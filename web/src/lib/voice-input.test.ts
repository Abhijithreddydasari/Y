import { afterEach, describe, expect, it, vi } from "vitest";
import { BoardError } from "./board-api";
import { matchOption, transcribe, voiceErrorMessage } from "./voice-input";
import { RecorderError, startWavRecording } from "./wav-recorder";

const options = ["Scores get huge, softmax saturates", "Scores get tiny, softmax becomes uniform", "Nothing changes"];

afterEach(() => vi.unstubAllGlobals());

describe("matchOption", () => {
  it.each([
    ["B", options[1]], ["b.", options[1]], ["Option C", options[2]], ["I think it's A", options[0]], ["bee", options[1]],
    ["my answer is c please", options[2]], ["the answer is option b", options[1]],
    ["nothing changes", options[2]], ["I'd say softmax saturates because scores get huge", options[0]],
  ])("%s → one option", (spoken, expected) => expect(matchOption(spoken, options)).toBe(expected));

  it.each([["E"], ["scores get"], ["um"], [""], ["a vector rotates when the matrix acts on it"]])("%s → no match", (spoken) => {
    expect(matchOption(spoken, options)).toBeNull();
  });
});

describe("transcribe client", () => {
  it("posts the WAV to the session's proxy path and maps failures to a typed code", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ text: "What is an eigenvector?", duration: 2.1 }))
      .mockResolvedValueOnce(Response.json({ detail: "no_speech" }, { status: 422 }));
    vi.stubGlobal("fetch", fetcher);
    const audio = new Blob(["RIFF"], { type: "audio/wav" });
    expect((await transcribe("sid", audio)).text).toBe("What is an eigenvector?");
    expect(fetcher.mock.calls[0][0]).toBe("/api/learning/sessions/sid/transcribe");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "POST", body: audio, headers: { "Content-Type": "audio/wav" } });
    const failure = await transcribe("sid", audio).catch((error) => error);
    expect(failure).toBeInstanceOf(BoardError);
    expect(voiceErrorMessage(failure)).toContain("didn't catch that");
    expect(voiceErrorMessage(new TypeError("Failed to fetch"))).toContain("Type your question instead");
  });
});

describe("startWavRecording", () => {
  it("reports a blocked or missing microphone as a typed reason", async () => {
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(Object.assign(new Error("no"), { name: "NotAllowedError" })) } });
    await expect(startWavRecording()).rejects.toMatchObject({ reason: "denied" });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(Object.assign(new Error("no"), { name: "NotFoundError" })) } });
    await expect(startWavRecording()).rejects.toMatchObject({ reason: "unavailable" });
    vi.stubGlobal("navigator", {});
    const missing = await startWavRecording().catch((error) => error);
    expect(missing).toBeInstanceOf(RecorderError);
    expect(missing.reason).toBe("unavailable");
  });
});

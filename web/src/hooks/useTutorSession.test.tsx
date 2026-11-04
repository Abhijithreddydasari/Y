import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTutorSession } from "./useTutorSession";

const api = vi.hoisted(() => ({
  fetchHealth: vi.fn(),
  fetchLearner: vi.fn(),
  resetLearner: vi.fn(),
  streamAssessment: vi.fn(),
  streamChat: vi.fn(),
  streamLesson: vi.fn(),
}));

vi.mock("@/lib/api", () => api);
vi.mock("@/lib/tts", () => ({ cancelSpeech: vi.fn(), installSpeechUnlock: vi.fn(() => () => {}) }));

describe("useTutorSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_API_BASE", "http://legacy.test");
    window.localStorage.clear();
    window.sessionStorage.clear();
    api.fetchLearner.mockResolvedValue(null);
    api.fetchHealth.mockResolvedValue({
      preferred_model: "edge",
      ollama_reachable: true,
      model: "gemma4:e4b",
      models: { edge: { kind: "ollama", model: "gemma4:e4b", ready: true } },
      transcription: { available: false, model: "moonshine-tiny-en" },
    });
  });

  it("exposes one controller for both view shells", async () => {
    const { result } = renderHook(() => useTutorSession());
    await waitFor(() => expect(result.current.status).toContain("Ready"));
    expect(result.current.modelChoice).toBe("edge");
    expect(result.current.checkpoint).toBeNull();
    expect(typeof result.current.solve).toBe("function");
    expect(typeof result.current.assess).toBe("function");
    expect(typeof result.current.insertSample).toBe("function");
    expect(api.fetchHealth).toHaveBeenCalledOnce();
  });
});

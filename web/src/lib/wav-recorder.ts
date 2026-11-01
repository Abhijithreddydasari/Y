export interface WavRecording {
  stop: () => Promise<Blob>;
  cancel: () => Promise<void>;
  /** Milliseconds captured so far. */
  elapsedMs: () => number;
}

export interface RecordingOptions {
  /** Hard cap; `onLimit` fires once when it is reached so the caller can stop and send. */
  maxMs?: number;
  onLimit?: () => void;
}

/** Why a recording could not start: the learner blocked the mic, there is none, or something else broke. */
export class RecorderError extends Error {
  constructor(readonly reason: "denied" | "unavailable" | "failed", message: string) { super(message); }
}

function recorderError(error: unknown): RecorderError {
  const name = (error as { name?: string })?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") return new RecorderError("denied", "Microphone access was blocked.");
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "NotReadableError") {
    return new RecorderError("unavailable", "No microphone is available.");
  }
  return new RecorderError("failed", (error as Error)?.message || "The microphone could not start.");
}

function mergeBuffers(buffers: Float32Array[]): Float32Array {
  const length = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
  const merged = new Float32Array(length);
  let offset = 0;
  for (const buffer of buffers) {
    merged.set(buffer, offset);
    offset += buffer.length;
  }
  return merged;
}

function resample(input: Float32Array, inputRate: number, outputRate = 16_000): Float32Array {
  if (inputRate === outputRate) return input;
  const outputLength = Math.max(1, Math.round(input.length * outputRate / inputRate));
  const output = new Float32Array(outputLength);
  const ratio = inputRate / outputRate;
  for (let index = 0; index < outputLength; index += 1) {
    const source = index * ratio;
    const low = Math.floor(source);
    const high = Math.min(input.length - 1, low + 1);
    const mix = source - low;
    output[index] = input[low] * (1 - mix) + input[high] * mix;
  }
  return output;
}

function encodePcmWav(samples: Float32Array, sampleRate = 16_000): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/** Capture mono PCM directly so transcription needs no codec; output is 16 kHz 16-bit WAV. */
export async function startWavRecording(options: RecordingOptions = {}): Promise<WavRecording> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new RecorderError("unavailable", "This browser cannot record audio.");
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    throw recorderError(error);
  }
  const context = new AudioContext();
  await context.resume();
  const source = context.createMediaStreamSource(stream);
  // ScriptProcessor is intentionally used as the broad-browser fallback for
  // a short, user-triggered recording. It lets us emit deterministic PCM WAV
  // without shipping a codec or touching the narration audio graph.
  const processor = context.createScriptProcessor(4096, 1, 1);
  const silent = context.createGain();
  silent.gain.value = 0;
  const buffers: Float32Array[] = [];
  const maxSamples = options.maxMs ? Math.ceil(options.maxMs / 1000 * context.sampleRate) : Infinity;
  let samples = 0, limited = false;
  processor.onaudioprocess = (event) => {
    if (samples >= maxSamples) return;
    const chunk = event.inputBuffer.getChannelData(0);
    buffers.push(new Float32Array(chunk.subarray(0, Math.min(chunk.length, maxSamples - samples))));
    samples += chunk.length;
    if (samples >= maxSamples && !limited) { limited = true; options.onLimit?.(); }
  };
  source.connect(processor);
  processor.connect(silent);
  silent.connect(context.destination);
  let closed = false;

  const cleanup = async () => {
    if (closed) return;
    closed = true;
    processor.onaudioprocess = null;
    source.disconnect();
    processor.disconnect();
    silent.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    await context.close();
  };

  return {
    stop: async () => {
      await cleanup();
      return encodePcmWav(resample(mergeBuffers(buffers), context.sampleRate));
    },
    cancel: cleanup,
    elapsedMs: () => Math.min(samples, maxSamples) / context.sampleRate * 1000,
  };
}

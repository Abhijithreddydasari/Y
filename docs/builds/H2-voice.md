# H2: Voice in, narration out

Status: planned, 2026-11-01. Branch `feature/voice-narration`, cut from `main` at `613a067` (the H1
merge). Prerequisite: H1 ([handoff](../handoffs/H1.md)).

## Learner story

I hold the mic button and ask my question out loud. Y writes the answer on the board straight
away and then talks me through it, one segment at a time, so the voice follows what I can see.
When it asks me something I can answer by voice or by tapping. Stop goes quiet at once. If the
microphone is blocked or the network drops, I can still type.

## What H1 left and what the stored turns show

- H1 voices each `write` line by reading it aloud and writes it at the speed of the speech. Each
  line waits for its audio, so a turn takes about 15–25 s to draw although its first move lands in
  about 2 s.
- The 29 stored live turns have **no `say` moves at all** (80 `write`, 48 `seg`, 23 `equation`,
  26 questions). The prompt says "use rarely". So today the only voice is the board read aloud.
- `tts.ts` calls `${API_BASE}/speech`, which only the legacy `main:app` serves. The capture service
  has no `/speech`, so H1's journey used browser speech.
- If a Kokoro clip is not ready within 450 ms, `speak()` switches the rest of that line to the
  browser voice, so one turn can mix two voices.

## Decisions

1. **The board is written; `say` is spoken.** Visuals draw at board speed (the reveal TTS-off
   already uses, about 0.5 s a line) and are never paced by audio. The voice says what a teacher
   says while pointing at the board. It does not read the board aloud.
2. **Segment binding.** A segment runs from one `seg` to the next. Its narration is its `say`
   moves, wherever they appear inside it. Narration for segment *k* starts once:
   - all of segment *k*'s visuals are drawn,
   - the segment is closed (the next `seg`, `turn_end` or the end of the stream), and
   - segment *k − 1*'s narration has finished.

   Drawing can run **at most one segment ahead** of the voice. Segment *k + 1* draws while *k* is
   spoken, and *k + 2* waits for *k*'s narration to finish. The board fills promptly and the voice
   never trails by more than one step.
3. **Fallback when a segment has no `say`:** speak its `write` lines, then the question's text if
   the segment holds the card. Old turns and a non-compliant model still get a voice.
4. **Prompt (moves section only; section names unchanged for H10):**
   - `say` is the spoken channel: one per segment, at most 25 words.
   - It is conversational, adds to the board rather than repeating it, and uses plain speakable
     words (no LaTeX or symbols).
   - It goes after the segment's board moves. In the last segment it goes before the question,
     because the validator requires the question to be last.
5. **One voice per turn.** In segment mode the player waits up to 2.5 s for the warmed Kokoro clip
   before using the browser voice, since the board no longer waits on it. After a Kokoro failure
   the rest of the turn uses the browser voice. Clips are warmed the moment a `say` streams in.
   *As built:* Kokoro measured at about real time on this laptop's CPU. The voice is therefore
   spoken clause by clause and clips are warmed one at a time. The first clause waits up to
   3.5 s, and once Kokoro has spoken, later clauses wait up to 8 s rather than switch voice (see
   the H2 handoff).
6. **Kokoro for the tutor path:** a speech route on the capture service, behind the same-origin
   proxy.
   - `POST /learning/speech` reuses `speech.get_speech_engine()` (Moonshine/Kokoro, ONNX on CPU,
     no Torch). It enforces the voice allowlist, ≤ 500 characters, the learning identity and at
     most 2 concurrent syntheses. The engine loads lazily; set `SPEECH_PREFETCH=1` to warm it at
     startup.
   - `tts.ts` calls `/api/learning/speech`, so the web needs no public API base. The same route
     deploys with the API in H9.
   - The legacy `/speech` on `main:app` is unchanged.
7. **Transcribe proxy:**
   - `POST /learning/sessions/{sid}/transcribe` takes a raw `audio/wav` body (≤ 1.1 MB) and sends
     it to `https://api.meta.ai/v1/asr/transcribe`:
     - `request`: `{model: "muse-voice-transcribe-1.0", audioEncoding: "WAV", sampleRateHertz}`,
       with the rate read from the WAV header;
     - `audio`: the WAV bytes.
   - Keyword hints come from the board **on the server**: the session's native text, recent
     segment goals and equation words, capped at about 30 terms. Nothing goes in the URL, and the
     browser cannot inject terms.
   - The hint field name is verified live first: probe candidate fields, then compare a jargon
     clip with and without hints. If no field is accepted, no hints are sent and the handoff says
     so.
   - Bounds:
     - 20 s timeout;
     - no automatic retry;
     - 4 concurrent provider calls;
     - 120 transcriptions per owner per hour (in process).
   - Errors map to safe codes: `transcribe_not_configured`, `transcribe_failed`,
     `transcribe_timeout`, `no_speech`, `audio_too_large` and `audio_invalid`.
8. **LaTeX misalignment.** Root cause, found by reading the html2canvas-pro source:
   - `renderTextNode` paints every text run with `textBaseline = 'alphabetic'` at
     `bounds.top + fontSize`. That assumes each font's ascent is exactly 1 em.
   - KaTeX mixes fonts in one formula: `3` is KaTeX_Main and `x` is KaTeX_Math italic. Their
     ascents differ, so each run lands on its own baseline.
   - KaTeX fonts also load lazily, and nothing waits for them before measuring.

   The fix replaces html2canvas with a small KaTeX painter in `katex.ts`:
   - Render KaTeX's HTML offscreen and wait for `document.fonts` to load the families it uses.
   - Draw each text run at `rangeRect.top + measureText().fontBoundingBoxAscent` in the run's
     computed font, so the browser's own layout baseline is reproduced.
   - Fill border boxes (fraction bars, rules, overlines) and background colours.
   - Draw KaTeX's inline SVGs (roots, stretchy delimiters) from their serialized markup, coloured
     with the computed colour.
   - Remove the now-unused `html2canvas-pro` dependency.

   The root cause is confirmed in the browser before the fix lands.

## Scope

- **Voice in (composer):**
  - A push-to-talk mic button: hold to talk and release to send, or tap to start and tap to stop.
  - States: idle → asking permission → recording (elapsed time, auto-stop at 30 s) →
    transcribing → idle.
  - Under 0.4 s of audio, nothing is sent and a hint is shown.
  - The transcript goes through exactly `tutor.ask(text)`, so it shares the typed path and keeps
    the draft on failure. One recording makes one turn.
  - When transcription fails, the error is shown and typing stays usable. When the turn fails to
    start, the transcript stays in the composer to edit.
  - A denied microphone disables the mic with "Microphone blocked: type instead". Offline or a
    provider error gives a message, and the composer stays usable.
- **Voice answers (card):**
  - The card gets its own mic. Free text: the transcript fills the answer and submits.
  - Options: the answer is matched deterministically (a letter such as "B" or "option b", or one
    option's text) and submitted with the slider's confidence.
  - No match or two matches: the transcript is shown and the learner taps an option.
- **Narration out:**
  - `LessonPlayer` gains a segment mode with `segment()` and `say(text)`, used only by tutor turns.
    Legacy Teach and Practice keep the lockstep mode.
  - Captions show the line being spoken (with TTS off: when its segment completes).
  - Mute (the existing Narration toggle) applies mid-turn: it silences at once and captions go on.
- **Stop:** silences Kokoro and browser speech, cancels warming fetches and queued narration, and
  takes no more than 150 ms from click to silence.
- **Recorder:** `wav-recorder.ts` gains max duration, elapsed time and a clean cancel. Errors are
  typed: `denied`, `unavailable` or `failed`.
- **LaTeX painter**, as in decision 8.

Exclude:
- streaming or partial transcripts;
- voice activity detection or wake words;
- barge-in (speaking interrupts narration);
- voice teach-back (H7);
- Kokoro hosting or deployment choice (H9 uses the first-audio numbers measured here);
- per-owner speech budgets beyond the concurrency cap (H9).

## Acceptance

1. A spoken question, from release to transcript to turn, uses the same path, routes and stored
   input as a typed one. One recording produces one turn.
2. A failed transcription leaves the board unchanged and typing usable. A failed turn leaves the
   transcript editable in the composer.
3. A denied mic or an offline network leaves typing fully usable, with an honest message.
4. Every segment's visuals are on the board before its narration starts, and drawing is never
   more than one segment ahead of the voice.
5. Stop silences audio within 150 ms, measured in the browser over 5 tries. Nothing plays after
   Stop.
6. Mute and captions work mid-turn.
7. In `3x + 5 = 20`, `\frac{QK^T}{\sqrt{d_k}}`, `A\mathbf{v} = \lambda \mathbf{v}`,
   `x_i^2 + y_{j}^{n+1}` and `\sum_{i=1}^{n} i = \frac{n(n+1)}{2}`, glyphs share their baselines.
   Fraction bars and roots are drawn. Before and after screenshots are recorded.

## Budgets and measurement

| Measure | Method | Target |
|---|---|---|
| Transcribe latency | Recorder stop → transcript in the browser hook (includes encode, proxy, provider). 10 spoken questions of about 10 s each, with jargon | ≤ 3 s p50, report all |
| First audio | Segment narration scheduled → audio `playing`, warm and cold Kokoro, plus raw `/learning/speech` time for a 20-word line | Report; choose warm-up policy |
| Turn draw time | Submit → last visual drawn (`drawn_ms`) and → narration ended, same questions, before (H1 code) and after | After: card drawn within first move + ~4 s |
| Stop to silence | `performance.now()` from Stop to `audio.paused` / `!speechSynthesis.speaking` | ≤ 150 ms |

Live transcribe samples need real speech:
- I play Kokoro-synthesised question clips through an injected media stream, so the real recorder,
  proxy and provider all run. They are labelled synthetic.
- The handoff asks the user to try two or three questions on a real microphone.

## Tests and evidence

- **Backend (mocked provider)**, in `tests/test_voice.py`:
  - the multipart shape and the `request` JSON;
  - the sample rate read from the WAV header;
  - hint terms taken from the board, deduped and capped;
  - size, format and duration bounds;
  - error mapping and timeouts;
  - missing key → 503;
  - the owner check and budget;
  - speech route: allowlist, length, concurrency and the unavailable path.
- **Frontend:**
  - recorder states: permission denied, auto-stop, too short, cancel;
  - the mic button state machine and transcript → `ask`;
  - failure keeps typing and the editable transcript;
  - voice-answer matching (letters, option text, ambiguity);
  - segment-mode ordering (visuals before narration, one-segment look-ahead, fallback to writes);
  - Stop and mute cancel queued narration;
  - the proxy allows the two new paths with their size limits;
  - KaTeX painter regression: runs in two fonts with different ascents share one baseline (stubbed
    geometry).
- `tsc`, changed-file lint and build.
- **Live** (separate from mocked): the transcribe latency table, the hint probe result, first-audio
  numbers and the before/after draw times.
- **Browser journey:**
  1. Speak a question.
  2. Narration follows the board.
  3. Answer a check by voice and by typing.
  4. Stop mid-narration.
  5. Mute mid-turn.
  6. Deny the mic, then type.
  7. Check the equation screenshots before and after.
- Write `docs/handoffs/H2.md`, update the H2 row in Slice status, and make scoped commits (API,
  web, docs).

## Files

API:
- `api/transcription.py` (Muse client beside Moonshine)
- new `api/learning/voice_router.py`
- mounted in `api/learning/app.py` and `api/main.py`
- `api/prompts/tutor-v1.md` (moves section)
- `api/tests/test_voice.py`

Web:
- `web/src/lib/wav-recorder.ts`, `tts.ts`, `lesson-player.ts`, `katex.ts`
- new `web/src/lib/voice-input.ts`
- `web/src/hooks/useTutorSession.ts`
- `TutorComposer.tsx`, `TutorQuestionCard.tsx`
- the learning proxy route
- tests

Contracts: no change to the H0 move schema. The prompt edit is noted in the handoff.

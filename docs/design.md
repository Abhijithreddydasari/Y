# Y: interaction and UI design

Status: intended experience, delivered incrementally by the [roadmap](builds/ROADMAP.md).

## Main surface

The shared board occupies the screen. Keep a compact drawing toolbar and a small
question composer near the lower edge; microphone becomes primary when B03 ships.
Show available actions only, not nonfunctional microphone/widget placeholders.
Practice, model controls, capture receipts and diagnostics are secondary surfaces.
Learners never need them to ask ordinary questions.

Use restrained color, clear typography and strong contrast. Light glass effects
may frame controls if readability and tablet performance hold. Equations, ink and
graph labels use stable opaque surfaces. Decoration is not a build.

## Normal turn

1. Learner writes/opens a problem; an empty board is equally valid.
2. Learner asks by voice or text, optionally circles a step or points to it.
3. Y briefly highlights inferred focus without routine confirmation.
4. Explanation appears nearby in a short coherent segment. Narration, when available,
   refers to visuals already visible.
5. Y pauses when asking for a prediction/answer. Learner writes, speaks, explores,
   asks another question or requests Continue. Full explanations remain available;
   not every interaction becomes compulsory testing.

Selection is an optional precision tool. For two plausible “step 3” targets, ask a
short question or let the learner tap one. Do not confidently choose at random.

## Learner control

- Stop remains available during generation, narration and animation.
- A new question or mic activation interrupts the current response.
- Preserve completed work; cancel queued output.
- Never erase, cover or move learner ink to make space for the tutor.
- Place answers nearby, link them subtly to their source, avoid surprising viewport
  jumps and provide a way to reach off-screen responses.
- Keep replay/mute/captions accessible; learners can think in silence.
- A tutor question enters a real waiting state instead of answering itself.

## Capture and failure states

- Saving stays quiet unless delayed/failed; errors preserve board and question.
- Restore before editing; distinguish failed load from an empty board.
- On conflict preserve local work and offer recovery; never silently overwrite.
- “How Y read this” is expandable evidence, never a required confirmation step.
- Clarify the exact uncertain symbol when it changes the answer. Nonessential
  ambiguity need not interrupt a useful explanation.
- Offline drawing remains recoverable. Explain why tutor requests cannot finish;
  allow deliberate retry rather than auto-sending stale questions on reconnect.
- Permission/provider failures leave typed entry and existing work usable.

## Tablet and accessibility checks

- Test landscape/portrait, stylus, touch pan/zoom and soft keyboard.
- Aim for at least 44 CSS-pixel touch controls; no hover-only actions.
- Pen marks must not accidentally trigger floating controls/widgets.
- Widget gestures and canvas gestures need clear hit targets and escape paths.
- Provide keyboard focus, visible focus indicators and accessible names.
- Speech has readable text; meaning does not depend on color alone.
- Respect reduced motion; animations pause and have a static/final representation.

## Later evidence UI

No scoreboard of supposed intelligence or mastery inferred from engagement. Show
topic-specific observations with sources, uncertainty and assistance when useful.
“This step was difficult last time” needs supporting evidence. Corrections create
new records rather than rewriting sources.

For each UI build record a real browser journey or sufficient screenshots, device,
input method and remaining limitations. Mocked tests alone do not establish a
usable live voice/pen experience.

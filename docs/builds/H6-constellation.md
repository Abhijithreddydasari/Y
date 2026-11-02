# H6 brief: learner map ("Your mind", the brain network)

Status: confirmed by the user on 2026-11-03, after prototypes of orbs, an island, depth columns and a
brain network; the brain network was chosen. Branch `feature/constellation`, cut from `main` at
`fc3ffd0`, with H5 merged. Priority P1. Owned files: `web/src/components/constellation/*`, plus two
small, noted API additions: thread links and revision history. Coding freezes at 22:00 IST.

The roadmap calls this Constellation. The learner-facing name is **Your mind**.

## Learner story

The learner opens **Your mind** from either shell. The view changes as they zoom.

**Zoomed out**, they see a brain made of faint points:
- Regions glow where they have studied, coloured by that region's mastery. A region is a
  subject area: the concept id's prefix (`attention.*`).
- A label card for each region gives its name and how many ideas it holds. Tapping one flies in.

**Zoomed in**, the brain gives way to neurons:
- **Neuron**: one per concept.
  - Its size shows the amount of evidence, and its colour shows mastery.
  - A dashed membrane means few answers so far.
- **Five dendrites**, clockwise from the top: recall, understand, apply, analyze and transfer.
  - Each dendrite's length is that dimension's mean.
  - A short dashed stub means that dimension is untested.
- **Synapses**: `builds_on` links, written by the model at close with citations required.
  - Spikes travel along them, and the receiving neuron flashes.
  - Thickness grows with link strength across sessions.
- **Misfiring links**: `confused_with`, shown as a flickering red line.
- **Halos**: a red pulsing halo marks an active misconception, sized by `strength`. A dashed halo
  means suspected, and a gold ring means resolved.

**Replay**: after End session, the newest revision replays. A spike traces that session's real
answer path while the neurons grow and halos change. A scrubber steps back through earlier
revisions.

Dragging a neuron pulls it, and it springs back with a wobble, tugging the neurons it is linked to.
Tapping a neuron opens the evidence sheet:
- dimension means with counts;
- uncertainty in words;
- misconceptions;
- the "why it connects" cards, with the cited questions and answers;
- the teaching notes that cite this neuron's evidence.

Honesty: the brain outline is a container drawn from seeded noise. Nothing glows without evidence
behind it, a spike runs only on a cited link, and the replay path is the observed answer order.

## Acceptance

1. **Empty profile**: the H0 mock arc is shown with a "Sample" badge, and it is never presented as
   the learner's data. A failed load shows Retry, never the sample.
2. **Real profile**: the map is built from `GET /learning/profile/revisions`, and the header shows
   the revision.
3. **End session**: the page reloads into a new session, and the map button shows a "new" dot.
   Opening the map auto-replays revision n−1 → n, and the scrubber reaches every revision.
4. **Drag**: the neuron springs back. The gate is 60 fps while idle-dragging, measured with p50 and
   p5 reported.
5. **Focus**: tap or Enter flies the camera to the neuron and opens the sheet. Esc closes it.
6. **Reduced motion or no WebGL**: a static SVG view with the same encodings and no animation.
7. **Board**: the map is never mounted while drawing. It is a full-screen dialog, and closing it
   unmounts the canvas and disposes GPU resources.

## API additions (no extra model calls)

**Thread links.** The existing Spark Open close call gains
`links: [{from, to, kind: builds_on|confused_with, why, cites}]`.
- A link is kept only if:
  - both concepts appear in this session or in the prior profile;
  - its two ends differ;
  - every cite is one of this session's observations on either end;
  - `why` is at most 200 characters.
- At most 6 links are kept.
- System `confused_with` links are added when a named belief's cited answers span concepts.

`ProfileRevision.links` is new (`ConceptLink`, default `()`). This is an H0 contract change, and the
TypeScript mirror is updated. The reducer carries links forward:
- links are merged by `(source, target, kind)`, with `confused_with` unordered;
- strength adds the cited answers' weights;
- the latest `why` is kept;
- at most 16 evidence ids are kept per link.

Links never change beliefs, the misconception ledger or the brief.

**Revision history.** `GET /learning/profile/revisions` is owner-scoped and read-only, and returns
at most 20 revisions in ascending order. Each revision includes its full `ProfileRevision`.
`events` adds, for the observations in those revisions:
- `{id, concept, dimension, outcome, modality, created_at, question, answer}`;
- question and answer are truncated to 160 characters.

The route has a proxy entry.

## Rendering

- `ConstellationButton` lives in both shells. It preloads the chunk on hover, focus or touch.
- The scene is loaded with `next/dynamic` (`ssr: false`), so three, fiber and d3-force-3d stay out of
  the board bundle.
- The scene uses R3F with `frameloop="demand"` and `dpr` of at most 1.75:
  - the cortex is one `Points` cloud;
  - neurons, halos and dendrites are instanced;
  - synapses are line geometry, and spikes are a few instanced sprites;
  - labels are DOM overlays, for at most 40 neurons near the focus.
- Frames are requested only while the layout settles, a drag or spring is moving, the camera is
  flying, a replay is running, or for a few seconds after the last interaction. At rest, nothing
  renders.
- Layout: regions are fixed anchors inside the brain. Within a region, d3-force-3d places neurons
  with links as springs, using fixed warm-up ticks.
- At most 150 nodes and 600 edges.

## Tests and checks

- **API**:
  - link validation and system bridges;
  - carry-forward and replay idempotence;
  - the revisions route: ordering, owner isolation, truncation.
- **Web**:
  - profile → graph mapping: states, dimensions, regions, links, misconceptions, the cap, the
    revision diff and the empty → mock fallback;
  - reduced-motion fallback.
- **Full checks**: backend suite, frontend suite, tsc, changed-file lint, build.
- **In-app browser journey**: open from Studio and Mobile, drag, focus, End session, replay. Plus
  FPS samples.

## Cut order

1. Spike trails.
2. Region fly-in.
3. Model links. System bridges stay, and no link is faked.
4. The scrubber. Replay of the latest revision stays.

## Completion

- `docs/handoffs/H6.md` and the slice status row.
- Scoped commits: API, then web, then docs.
- No push and no PR.

# ECC: selective use for Y

Reviewed 2026-11-01 from the [official repository](https://github.com/affaan-m/ECC).
No installation or plugin configuration was performed. **The user handles installation.**
These are a shortlist and usage policy, not copied or automatically active skills.

## Four useful skills

- [verification-loop](https://github.com/affaan-m/ECC/blob/main/skills/verification-loop/SKILL.md):
  use at a feature's completion to report build/types/lint/tests, diff review and
  actual environment acceptance separately. Use Y's CMD commands and applicable
  checks; do not copy its shell commands or add tools just to imitate examples.
- [iterative-retrieval](https://github.com/affaan-m/ECC/blob/main/skills/iterative-retrieval/SKILL.md):
  use when finding code for a slice. Start with the brief and named modules, inspect
  matches, then expand only to resolve concrete gaps. Its upstream focus is subagent
  retrieval; the search discipline is useful here without spawning agents.
- [frontend-patterns](https://github.com/affaan-m/ECC/blob/main/skills/frontend-patterns/SKILL.md):
  use for the board composer, state/render performance and accessible controls.
  Existing Next.js-version documentation and Y's UI/renderer constraints take priority
  over generic sample implementations. It is not a substitute for visual/device QA.
- [eval-harness](https://github.com/affaan-m/ECC/blob/main/skills/eval-harness/SKILL.md):
  use when defining model capability/regression cases. Adapt its evaluation discipline
  to source reading, correct targeting, tutor behavior and GEPA comparisons. Reviewed
  educational correctness labels are still required; a model grader is not truth.

One optional specialist:
[security-review](https://github.com/affaan-m/ECC/blob/main/skills/security-review/SKILL.md)
only for authentication, uploads, ownership, proxy or public-deployment changes.
Apply relevant checks to our stack, not every framework-specific example.

## Keep context and automation small

1. User installs/enables the desired skills through their chosen supported mechanism;
   verify availability afterward. Do not assume Claude slash-command syntax works here.
2. Start a feature with AGENTS, handoff and one build brief. Load at most one relevant
   specialist skill initially; load verification guidance near completion as needed.
3. Keep deep skill bodies out of AGENTS, CLAUDE and every chat's startup context.
   Installed availability is not proof that it has no context cost; check the actual
   skill catalog. If the plugin exposes the whole catalog, prefer a supported selective
   installation/disable mechanism over loading hundreds of entries for this project.
4. No wholesale rules import, automatic hooks, memory/continuous-learning agents,
   MCP servers, autonomous loops or dependency changes for the hackathon.
5. Our folder exclusions apply to all searches/retrieval. No blanket whole-repo scans
   or secret-value printing. No automatic commits/pushes from plugin hooks.
6. ECC's coding-agent memory is unrelated to Y's learner adaptation/GEPA. Keep product
   behavior in reviewed application code and versioned evaluation artifacts.

## Per-session request

Ask for the build ID and outcome first. Add “use frontend-patterns for this UI slice”
or “use eval-harness to define these model cases” only when relevant. End with the
verification-loop discipline, a scoped commit and a handoff. Do not activate every
skill in the shortlist for every task or install ECC on the user's behalf.

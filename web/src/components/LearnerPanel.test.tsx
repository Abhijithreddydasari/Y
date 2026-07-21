import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import LearnerPanel, { buildConstellationLayout } from "./LearnerPanel";
import type { ConceptBelief, LearnerSnapshot } from "@/lib/types";

const belief = (name: string, evidence: number): ConceptBelief => ({
  name,
  mastery_mean: 0.61,
  mastery_std: 0.22,
  credible_low: 0.3,
  credible_high: 0.8,
  evidence_count: evidence,
  help_evidence_count: 1,
  strong_evidence_count: Math.max(0, evidence - 1),
  last_evidence_at: "2026-07-21T10:00:00Z",
  mastery_delta: 0.03,
  uncertainty_delta: -0.02,
  trend: 0.1,
});

const beliefs = [belief("fraction-addition", 3), belief("common-denominators", 2)];
const relation = { source: "fraction-addition", target: "common-denominators", strength: 0.8, kind: "mixed" };

function snapshot(): LearnerSnapshot {
  const learnerState = {
    schema_version: 2,
    revision: 3,
    updated_at: "2026-07-21T10:00:00Z",
    observations: 3,
    concept_beliefs: beliefs,
    latent_point: { ts: "now", x: 0, y: 0, z: 0, observations: 3 },
    latent_trajectory: [],
    concept_relations: [relation],
    last_activity: { concepts: ["fraction-addition"] },
    profile_text: "Developing fraction understanding.",
    adapter: {
      base_version: "test",
      online_steps: 3,
      rollback_count: 0,
      representation_steps: 2,
      representation_rollbacks: 0,
      trained_checkpoint: true,
    },
  };
  return {
    user_id: "learner", schema_version: 2, sessions: [], evidence: [], learner_state: learnerState,
    concept_beliefs: beliefs, latent_trajectory: [], adapter_version: "test",
    online_step_count: 3, rollback_count: 0,
    mastery_summary: { mastered: [], struggling: [], seen: [] },
  };
}

describe("LearnerPanel", () => {
  it("creates a stable constellation and scales nodes by evidence", () => {
    const first = buildConstellationLayout(beliefs, [relation]);
    const second = buildConstellationLayout(beliefs, [relation]);
    expect(first.map(({ x, y }) => ({ x, y }))).toEqual(second.map(({ x, y }) => ({ x, y })));
    expect(first[0].radius).toBeGreaterThan(first[1].radius);
  });

  it("opens a live constellation with adapter activity from the SSE state", async () => {
    render(<LearnerPanel snapshot={snapshot()} />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: /open learning constellation/i }));
    expect(screen.getByRole("img", { name: /live concept constellation/i })).toBeInTheDocument();
    expect(screen.getByText(/representation 2/i)).toBeInTheDocument();
    expect(screen.getByText(/95% interval/i)).toBeInTheDocument();
  });

  it("separates dragging from clicking and persists the new position", async () => {
    vi.useFakeTimers();
    render(<LearnerPanel snapshot={snapshot()} />);
    await act(async () => { vi.runOnlyPendingTimers(); });
    const orb = screen.getByRole("button", { name: /open learning constellation/i });
    fireEvent.pointerDown(orb, { pointerId: 7, clientX: 50, clientY: 500 });
    fireEvent.pointerMove(orb, { pointerId: 7, clientX: 105, clientY: 450 });
    fireEvent.pointerUp(orb, { pointerId: 7, clientX: 105, clientY: 450 });
    fireEvent.click(orb);
    expect(screen.queryByRole("img", { name: /live concept constellation/i })).not.toBeInTheDocument();
    const saved = JSON.parse(window.localStorage.getItem("y_learner_orb_position_v1") ?? "null");
    expect(Number.isFinite(saved?.x) && Number.isFinite(saved?.y)).toBe(true);
    act(() => { vi.runOnlyPendingTimers(); });
    fireEvent.click(orb);
    expect(screen.getByRole("img", { name: /live concept constellation/i })).toBeInTheDocument();
    vi.useRealTimers();
  });
});

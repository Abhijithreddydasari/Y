import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import LearnerPanel, { buildKnowledgeHierarchy } from "./LearnerPanel";
import type { ConceptBelief, LearnerSnapshot } from "@/lib/types";

const dimensions = Object.fromEntries(
  ["knowledge", "understanding", "retention", "reasoning", "application"].map((name) => [name, {
    mean: name === "retention" ? 0.5 : 0.61,
    std: name === "retention" ? 0.5 : 0.22,
    credible_low: name === "retention" ? 0 : 0.3,
    credible_high: name === "retention" ? 1 : 0.8,
    evidence_count: name === "retention" ? 0 : 2,
    status: name === "retention" ? "insufficient-evidence" : "developing",
  }]),
) as ConceptBelief["dimensions"];

const belief = (name: string, evidence: number): ConceptBelief => ({
  name,
  display_name: name.replaceAll("-", " "),
  hierarchy: ["Mathematics", "Number theory", "Fractions", name.replaceAll("-", " ")],
  dimensions,
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

function snapshot(): LearnerSnapshot {
  const learnerState = {
    schema_version: 2,
    revision: 3,
    updated_at: "2026-07-21T10:00:00Z",
    observations: 3,
    concept_beliefs: beliefs,
    latent_point: { ts: "now", x: 0, y: 0, z: 0, observations: 3 },
    latent_trajectory: [],
    concept_relations: [],
    knowledge_hierarchy: buildKnowledgeHierarchy(beliefs),
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
  it("builds stable subject-to-concept hierarchy with unresolved retention", () => {
    const first = buildKnowledgeHierarchy(beliefs);
    const second = buildKnowledgeHierarchy(beliefs);
    expect(first).toEqual(second);
    expect(first[0].name).toBe("Mathematics");
    expect(first[0].children[0].name).toBe("Number theory");
    expect(first[0].dimensions.retention.evidence_count).toBe(0);
  });

  it("drills into the live atlas and exposes evidence bars", async () => {
    render(<LearnerPanel snapshot={snapshot()} />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: /open learner knowledge atlas/i }));
    expect(screen.getByRole("img", { name: /hierarchical learner knowledge map/i })).toBeInTheDocument();
    expect(screen.getByText(/representation 2/i)).toBeInTheDocument();
    const subject = screen.getByRole("button", { name: /mathematics, subject/i });
    fireEvent.mouseEnter(subject);
    expect(screen.getByLabelText(/learning dimensions for mathematics/i)).toBeInTheDocument();
    expect(screen.getByText("Retention")).toBeInTheDocument();
    expect(screen.getAllByText("needs evidence").length).toBeGreaterThan(0);
    fireEvent.click(subject);
    expect(screen.getByRole("button", { name: /number theory, field/i })).toBeInTheDocument();
  });

  it("separates dragging from clicking and persists the new position", async () => {
    vi.useFakeTimers();
    render(<LearnerPanel snapshot={snapshot()} />);
    await act(async () => { vi.runOnlyPendingTimers(); });
    const orb = screen.getByRole("button", { name: /open learner knowledge atlas/i });
    fireEvent.pointerDown(orb, { pointerId: 7, clientX: 50, clientY: 500 });
    fireEvent.pointerMove(orb, { pointerId: 7, clientX: 105, clientY: 450 });
    fireEvent.pointerUp(orb, { pointerId: 7, clientX: 105, clientY: 450 });
    fireEvent.click(orb);
    expect(screen.queryByRole("img", { name: /hierarchical learner knowledge map/i })).not.toBeInTheDocument();
    const saved = JSON.parse(window.localStorage.getItem("y_learner_orb_position_v1") ?? "null");
    expect(Number.isFinite(saved?.x) && Number.isFinite(saved?.y)).toBe(true);
    act(() => { vi.runOnlyPendingTimers(); });
    fireEvent.click(orb);
    expect(screen.getByRole("img", { name: /hierarchical learner knowledge map/i })).toBeInTheDocument();
    vi.useRealTimers();
  });
});

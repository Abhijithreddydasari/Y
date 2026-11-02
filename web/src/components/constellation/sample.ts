// The labelled sample shown before a learner has sealed any session: the H0 two-session attention arc.
import arc from "@/lib/fixtures/attention-arc.v1.json";
import type { DemoArcFixture } from "@/lib/learner-contracts";
import { fromGraph, type MindMap } from "./map-model";

const REGIONS: Record<string, string> = {
  vectors: "linalg", dot_product: "linalg", dot_product_variance: "linalg", exponentials: "calc", gradient_saturation: "calc",
};

export const sampleMap = (): MindMap =>
  fromGraph((arc as unknown as DemoArcFixture).constellation, (id) => REGIONS[id] ?? "attention");

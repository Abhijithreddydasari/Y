// Minimal types for the parts of d3-force-3d the learner map uses (the package ships none).
declare module "d3-force-3d" {
  export interface SimNode { id: string; x?: number; y?: number; z?: number; vx?: number; vy?: number; vz?: number; [key: string]: unknown }
  export interface SimLink { source: string | SimNode; target: string | SimNode }
  type Accessor<T> = number | ((d: T) => number);
  export interface Force<T> { (alpha: number): void; strength(value: Accessor<T>): this }
  export interface LinkForce<T> extends Force<T> { id(fn: (d: SimNode) => string): this; distance(value: Accessor<T>): this }
  export interface Simulation {
    force(name: string, force: unknown): Simulation;
    stop(): Simulation;
    tick(iterations?: number): Simulation;
  }
  export function forceSimulation(nodes: SimNode[], numDimensions?: number): Simulation;
  export function forceLink(links: SimLink[]): LinkForce<SimLink>;
  export function forceManyBody(): Force<SimNode>;
  export function forceX(x: Accessor<SimNode>): Force<SimNode>;
  export function forceY(y: Accessor<SimNode>): Force<SimNode>;
  export function forceZ(z: Accessor<SimNode>): Force<SimNode>;
}

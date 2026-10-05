/**
 * `fluidcad/sdk/kernel` — the geometry a custom feature's `buildTool()`
 * builds with: the shape wrappers, the primitives, the booleans and the
 * placement transform.
 *
 * **Unstable.** These are the engine's own kernel classes, exported as they
 * are so the first custom features can be written at all. Their names and
 * signatures will change without notice while the SDK settles; build on
 * `fluidcad/sdk` and `fluidcad/math` wherever they reach.
 *
 * Every shape these make belongs to the caller. A shape `buildTool()` returns
 * belongs to the feature from then on; any other one the caller builds and
 * drops (an intermediate cylinder, a tool already cut) is freed with
 * `dispose()`.
 *
 * Raw OpenCascade code (`fluidcad/sdk/occt`) comes back into these wrappers:
 * `shape.getShape()` is a wrapper's raw handle, and `ShapeFactory.fromShape(raw)`
 * wraps a raw shape by its type — a solid as a `Solid`, a face as a `Face`, a
 * wire as a `Wire` … — as do `Solid.fromTopoDSSolid`, `Face.fromTopoDSFace`,
 * `Edge.fromTopoDSEdge`, `Wire.fromTopoDSWire` and `Vertex.fromTopoDSVertex`.
 * Those are the shapes `buildTool()` returns and `setBuckets()` names.
 */
export { Shape } from "../common/shape.js";
export { Solid } from "../common/solid.js";
export { Face } from "../common/face.js";
export { Edge } from "../common/edge.js";
export { Wire } from "../common/wire.js";
export { Vertex } from "../common/vertex.js";
export { ShapeFactory } from "../common/shape-factory.js";
export { Primitives } from "../oc/primitives.js";
export { BooleanOps } from "../oc/boolean-ops.js";
export { ShapeOps } from "../oc/shape-ops.js";

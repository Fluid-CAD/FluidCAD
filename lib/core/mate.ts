import { captureSourceLocation } from "../index.js";
import { getCurrentScene } from "../scene-manager.js";
import { AssemblyScene, MateType } from "../rendering/assembly-scene.js";
import { BoundConnector } from "../features/connector.js";
import { MateBuilder, makeAssemblyMate } from "../features/mate.js";

const VALID_TYPES: ReadonlyArray<MateType> = [
  "fastened", "revolute", "slider", "cylindrical", "planar", "parallel", "pin-slot",
];

// Types the solver actually implements. "parallel" and "pin-slot" parse
// as MateType but have no warm-start or residual yet — accepting them
// would silently leave the mate unenforced AND disable loop relaxation
// for the whole component, so reject them loudly at parse time. Remove
// each from this gate when its solver phase lands.
const IMPLEMENTED_TYPES: ReadonlyArray<MateType> = [
  "fastened", "revolute", "slider", "cylindrical", "planar",
];

function mate(type: MateType, a: unknown, b: unknown): MateBuilder {
  const scene = getCurrentScene();
  if (!(scene instanceof AssemblyScene)) {
    throw new Error("mate() can only be used in *.assembly.js files.");
  }
  if (!VALID_TYPES.includes(type)) {
    throw new Error(
      `mate(): unknown mate type "${type}". Expected one of: ${VALID_TYPES.join(", ")}.`,
    );
  }
  if (!IMPLEMENTED_TYPES.includes(type)) {
    throw new Error(
      `mate('${type}', …) — not implemented yet; supported types: ${IMPLEMENTED_TYPES.join(", ")}.`,
    );
  }
  if (!(a instanceof BoundConnector) || !(b instanceof BoundConnector)) {
    throw new Error(
      "mate(): both arguments must be connectors from inserted instances (e.g. instance.connectors.main). Define them inside the part with `connector('main', ...)`.",
    );
  }
  if (a.instanceId === b.instanceId && a.connector.id === b.connector.id) {
    throw new Error("mate(): a connector cannot be mated to itself.");
  }

  const sourceLocation = captureSourceLocation();
  // Counter-based id; see insert.ts for the rationale (line-derived ids
  // collided across edits and caused the UI to reuse the wrong record).
  // Counted per scope and path-qualified, like instance ids.
  const record = makeAssemblyMate(
    type, a, b, scene.nextMateId(), scene.currentScopePath(), sourceLocation ?? undefined,
  );
  scene.addMate(record);
  return new MateBuilder(record);
}

export default mate;

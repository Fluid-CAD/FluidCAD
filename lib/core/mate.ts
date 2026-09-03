import { captureSourceLocation } from "../index.js";
import { getCurrentScene } from "../scene-manager.js";
import { AssemblyScene, MateType } from "../rendering/assembly-scene.js";
import { BoundConnector, Connector } from "../features/connector.js";
import { BoundExposure } from "../features/exposed.js";
import { MateBuilder, makeAssemblyMate, makeTangentAssemblyMate } from "../features/mate.js";

const VALID_TYPES: ReadonlyArray<MateType> = [
  "fastened", "revolute", "slider", "cylindrical", "planar", "parallel", "pin-slot", "tangent",
];

// Types the solver actually implements. "parallel" and "pin-slot" parse
// as MateType but have no warm-start or residual yet — accepting them
// would silently leave the mate unenforced AND disable loop relaxation
// for the whole component, so reject them loudly at parse time. Remove
// each from this gate when its solver phase lands.
const IMPLEMENTED_TYPES: ReadonlyArray<MateType> = [
  "fastened", "revolute", "slider", "cylindrical", "planar", "tangent",
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

  const sourceLocation = captureSourceLocation();
  // Counter-based id; see insert.ts for the rationale (line-derived ids
  // collided across edits and caused the UI to reuse the wrong record).
  // Counted per scope and path-qualified, like instance ids.

  // Tangent is the one mate authored on geometry, not connectors: both
  // sides are exposures bound to an instance (`instance.features.<name>`).
  if (type === "tangent") {
    if (!(a instanceof BoundExposure) || !(b instanceof BoundExposure)) {
      if (a instanceof BoundConnector || b instanceof BoundConnector || a instanceof Connector || b instanceof Connector) {
        throw new Error(
          "mate('tangent'): takes exposed geometry, not connectors — pass instance.features.<name> for both sides (published in the part with `expose('name', ...)`).",
        );
      }
      throw new Error(
        "mate('tangent'): both arguments must be exposed geometry from inserted instances (e.g. instance.features.profile). Publish the face/edge inside the part with `expose('profile', ...)`.",
      );
    }
    if (a.instanceId === b.instanceId && a.exposed === b.exposed) {
      throw new Error("mate(): geometry cannot be mated to itself.");
    }
    const record = makeTangentAssemblyMate(
      a, b, scene.nextMateId(), scene.currentScopePath(), sourceLocation ?? undefined,
    );
    scene.addMate(record);
    return new MateBuilder(record);
  }

  if (a instanceof BoundExposure || b instanceof BoundExposure) {
    throw new Error(
      `mate('${type}'): takes connectors, not exposed geometry — pass instance.connectors.<name> for both sides. Only mate('tangent', …) is authored on exposed faces/edges.`,
    );
  }
  // A bare part connector (`def.connectors.x` off a definition, or the
  // connector() return value inside a part block) names no instance —
  // point at the bound spelling instead of the generic error.
  for (const side of [a, b]) {
    if (side instanceof Connector && !side.isAssemblyConnector()) {
      throw new Error(
        `mate(): connector "${side.connectorName}" is a part connector with no instance — pass instance.connectors.${side.connectorName} from an inserted instance.`,
      );
    }
  }
  const isFrame = (s: unknown): s is Connector => s instanceof Connector && s.isAssemblyConnector();
  if (isFrame(a) && isFrame(b)) {
    throw new Error(
      "mate(): both sides are assembly connectors — one side must be an inserted instance's connector (instance.connectors.<name>).",
    );
  }
  const sideOk = (s: unknown) => s instanceof BoundConnector || isFrame(s);
  if (!sideOk(a) || !sideOk(b)) {
    throw new Error(
      "mate(): both arguments must be connectors from inserted instances (e.g. instance.connectors.main) or an assembly connector (`connector('name', [x, y, z])` at the top level). Define part connectors inside the part with `connector('main', ...)`.",
    );
  }
  if (
    a instanceof BoundConnector && b instanceof BoundConnector
    && a.instanceId === b.instanceId && a.connector.id === b.connector.id
  ) {
    throw new Error("mate(): a connector cannot be mated to itself.");
  }

  // v1 scope rule: connector() itself refuses to run inside an assembly()
  // body, but the connector VALUE could leak into one through a closure —
  // the mate is where it would silently stop meaning the root frame, so
  // refuse here too.
  if ((isFrame(a) || isFrame(b)) && scene.currentScopePath() !== "") {
    throw new Error(
      "mate(): assembly connectors are root-scope only for now — mate to one from the file that declares it.",
    );
  }

  const record = makeAssemblyMate(
    type,
    a as BoundConnector | Connector,
    b as BoundConnector | Connector,
    scene.nextMateId(),
    scene.currentScopePath(),
    sourceLocation ?? undefined,
  );
  scene.addMate(record);
  return new MateBuilder(record);
}

export default mate;

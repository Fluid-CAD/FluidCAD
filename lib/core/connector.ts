import { registerBuilder, SceneParserContext } from "../index.js";
import { getCurrentScene } from "../scene-manager.js";
import { Connector } from "../features/connector.js";
import {
  ConnectorOptions,
  FreePoint,
  isConnectorInput,
} from "../features/connector-frame.js";
import { AssemblyScene } from "../rendering/assembly-scene.js";
import { Point } from "../math/point.js";
import { IConnector, ISceneObject } from "./interfaces.js";
import { CONNECTOR_NAME_PATTERN } from "../selection/types.js";

/** A world point for an assembly connector: `[x, y, z]`. */
export type AssemblyConnectorPoint = [number, number, number];

interface ConnectorFunction {
  /**
   * Creates a named mate connector — a coordinate frame attached to real
   * geometry. Declared inside a `part(...)` block, the connector registers
   * on the part and appears on EVERY instance of it: assemblies reference it
   * as `instance.connectors.<name>` in `mate()` calls.
   *
   * Accepts a face/edge/vertex selection (`select(...)`), a sketch lazy
   * selection (e.g., `rect.edge('top')`), a `LazyVertex`, or a plane object.
   * Raw points are intentionally not allowed — the frame must be tied to
   * real geometry so it re-derives correctly on every render.
   *
   * @param name - Identifier the connector is registered under.
   * @param source - The geometry the connector is attached to.
   * @param options - Optional `xDirection` override (re-orthogonalized against Z).
   */
  (name: string, source: ISceneObject, options?: ConnectorOptions): IConnector;
  /**
   * Creates an assembly connector — a mate frame placed freely in the
   * assembly's space, attached to no geometry. Declared at the top level of
   * an *.assembly.js file, it is a `mate()` side in its own right, so a base
   * part can keep degrees of freedom relative to the assembly instead of
   * being fully pinned by `.grounded()`:
   *
   *     const hinge = connector('hinge', [40, 0, 12]).rotate('x', 90);
   *     mate('revolute', hinge, crank.connectors.shaft);
   *
   * The frame starts at the point with world axes (Z up); `.rotate(axis,
   * degrees)` turns it about its own axis, in chain order, and
   * `.offset(x, y, z)` moves it along its own axes. Mate options
   * (`.offset()`, `.rotate()`) on a mate to this connector read in its
   * frame — the assembly side is always the grounded driver.
   *
   * @param name - Identifier the connector is registered under (unique
   *   among the assembly's connectors).
   * @param position - World position `[x, y, z]`.
   */
  (name: string, position: AssemblyConnectorPoint): IConnector;
}

function isPointTuple(value: unknown): value is AssemblyConnectorPoint {
  return Array.isArray(value)
    && value.length === 3
    && value.every(n => typeof n === "number" && Number.isFinite(n));
}

function validateName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !CONNECTOR_NAME_PATTERN.test(name)) {
    const got = typeof name === "string" ? JSON.stringify(name) : `a ${typeof name}`;
    throw new Error(
      `connector(): the first argument is the connector's name — a plain identifier like 'topLeft' (got ${got}).`,
    );
  }
}

/** The assembly-level form: `connector('name', [x, y, z])`. */
function assemblyConnector(
  context: SceneParserContext,
  scene: AssemblyScene,
  name: unknown,
  source: unknown,
): IConnector {
  if (scene.currentScopePath() !== "") {
    // An occurrence's frame is not a solver body yet: a connector riding an
    // ungrounded sub-assembly would be silently unenforced, so refuse at
    // parse time (same policy as the unimplemented mate types).
    throw new Error(
      "connector() inside an assembly() body — assembly connectors are root-scope only for now; "
      + "declare it in the file that inserts the sub-assembly.",
    );
  }
  validateName(name);
  if (!isPointTuple(source)) {
    throw new Error(
      "connector() at assembly top level takes a world point [x, y, z] as its second argument — "
      + "geometry-attached connectors are declared inside part().",
    );
  }
  if (scene.getAssemblyConnectors().some(c => c.connectorName === name)) {
    throw new Error(
      `connector(): the assembly already has a connector named "${name}" — names must be unique within the assembly.`,
    );
  }
  const obj = new Connector(name, new FreePoint(Point.fromArray(source)), {}, scene.currentScopePath());
  context.addSceneObject(obj);
  scene.registerAssemblyConnector(obj);
  return obj;
}

function build(context: SceneParserContext): ConnectorFunction {
  return function connector(name: string, source: unknown, options: ConnectorOptions = {}): IConnector {
    const scene = getCurrentScene();
    const part = scene.getActivePart();
    if (!part) {
      // Registered with allowAssemblyTopLevel so assembly files reach the
      // assembly form (or this pointed error) instead of the generic
      // part-design-only one.
      if (scene instanceof AssemblyScene) {
        return assemblyConnector(context, scene, name, source);
      }
      throw new Error(
        "connector() must be called inside a part() block — connectors are the part's "
        + "mating interface and appear on every instance. Declare it in the part's file "
        + "and reference it as instance.connectors.<name> in mate().",
      );
    }
    // The part is found by scanning the container stack, but parenting goes
    // to the TOP container — a connector nested in e.g. a sketch() callback
    // would become the sketch's child, invisible to Part.getConnectors()
    // and every instance.connectors lookup. Refuse instead of silently
    // registering nowhere.
    const container = scene.getActiveContainer();
    if (container !== part) {
      throw new Error(
        `connector() must be declared directly in the part() body — this call is nested inside `
        + `${container ? container.getType() + '(...)' : 'another callback'}, so the connector would not `
        + `register on the part "${part.partName}". Move the statement out of the nested callback.`,
      );
    }
    validateName(name);

    if (part.getConnectors().some(c => c.connectorName === name)) {
      throw new Error(
        `connector(): the part "${part.partName}" already has a connector named "${name}" — names must be unique within a part.`,
      );
    }
    if (!isConnectorInput(source)) {
      throw new Error("connector(): source must be a face/edge/vertex selection, sketch lazy selection, LazyVertex, or plane object.");
    }
    const geometry = source;

    // Ensure the source (and anything it depends on — an anchored vertex
    // like `e.endFaces().center()` wraps an inline lazy selection that is
    // registered nowhere else) is in the scene so it builds before the
    // connector — `addSceneObject` is idempotent, so already-registered
    // sources (e.g., from `select(...)`) are unaffected.
    for (const dep of geometry.getDependencies()) {
      context.addSceneObject(dep);
    }
    context.addSceneObject(geometry);

    const obj = new Connector(name, geometry, options);
    context.addSceneObject(obj);
    return obj;
  };
}

export default registerBuilder(build, { allowAssemblyTopLevel: true });

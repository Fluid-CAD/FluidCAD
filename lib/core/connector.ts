import { registerBuilder, SceneParserContext } from "../index.js";
import { getCurrentScene } from "../scene-manager.js";
import { AssemblyScene, AssemblyInstance } from "../rendering/assembly-scene.js";
import { Connector, BoundConnector } from "../features/connector.js";
import { InstanceSelectSceneObject } from "../features/instance-select.js";
import { AnchoredLazyVertex } from "../features/anchored-vertex.js";
import {
  ConnectorOptions,
  isConnectorInput,
} from "../features/connector-frame.js";
import { IConnector, ISceneObject } from "./interfaces.js";
import { CONNECTOR_NAME_PATTERN } from "../selection/types.js";

interface ConnectorFunction {
  /**
   * Creates a named mate connector — a coordinate frame attached to real
   * geometry. Two scopes:
   *
   * Inside a `part(...)` block, the connector registers on the part and
   * appears on EVERY instance of it: assemblies reference it as
   * `instance.connectors.<name>`.
   *
   * At the top level of an *.assembly.js file, the source must be an
   * instance-scoped selection (`arm1.select(face()...)` / `arm1.face(...)` /
   * `arm1.edge(...)`); the connector then belongs to that ONE instance and
   * the returned value is passed to `mate()` directly:
   *
   *     const arm1 = insert(arm());
   *     const pivot = connector('pivot', arm1.face(f => f.parallelTo('xy').largest()));
   *     mate('revolute', pivot, base1.connectors.hinge);
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
}

function build(context: SceneParserContext): ConnectorFunction {
  return function connector(name: string, source: ISceneObject, options: ConnectorOptions = {}): IConnector {
    const scene = getCurrentScene();
    const part = scene.getActivePart();
    if (!part && !(scene instanceof AssemblyScene)) {
      throw new Error("connector() must be called inside a part() block.");
    }
    if (typeof name !== "string" || !CONNECTOR_NAME_PATTERN.test(name)) {
      const got = typeof name === "string" ? JSON.stringify(name) : `a ${typeof name}`;
      throw new Error(
        `connector(): the first argument is the connector's name — a plain identifier like 'topLeft' (got ${got}).`,
      );
    }

    if (!part) {
      return buildInstanceConnector(context, scene as AssemblyScene, name, source, options) as unknown as IConnector;
    }

    if (part.getConnectors().some(c => c.connectorName === name)) {
      throw new Error(
        `connector(): the part "${part.partName}" already has a connector named "${name}" — names must be unique within a part.`,
      );
    }
    if (!isConnectorInput(source)) {
      throw new Error("connector(): source must be a face/edge/vertex selection, sketch lazy selection, LazyVertex, or plane object.");
    }

    // Ensure the source (and anything it depends on — an anchored vertex
    // like `e.endFaces().center()` wraps an inline lazy selection that is
    // registered nowhere else) is in the scene so it builds before the
    // connector — `addSceneObject` is idempotent, so already-registered
    // sources (e.g., from `select(...)`) are unaffected.
    for (const dep of source.getDependencies()) {
      context.addSceneObject(dep);
    }
    context.addSceneObject(source);

    const obj = new Connector(name, source, options);
    context.addSceneObject(obj);
    return obj;
  };
}

/**
 * Assembly-scoped connector: bound to the one instance its source selection
 * was scoped to. Registers as a top-level scene object (not parented under
 * the part container — every instance of the part shares that subtree) and
 * returns a {@link BoundConnector} usable as a `mate()` argument directly.
 */
function buildInstanceConnector(
  context: SceneParserContext,
  scene: AssemblyScene,
  name: string,
  source: ISceneObject,
  options: ConnectorOptions,
): BoundConnector {
  const instance = resolveSourceInstance(source);
  if (!instance || !isConnectorInput(source)) {
    throw new Error(
      "connector() at assembly scope needs an instance-scoped selection — e.g. "
      + "connector('pivot', arm1.select(face().parallelTo('xy'))) or arm1.face(f => ...). "
      + "For a connector on every instance, declare it inside the part() block instead.",
    );
  }
  const taken = scene.getInstanceConnectors(instance.instanceId).some(c => c.connectorName === name)
    || instance.part.getConnectors().some(c => c.connectorName === name);
  if (taken) {
    throw new Error(
      `connector(): "${instance.name}" already has a connector named "${name}" — `
      + `names must be unique per instance (part-owned connectors included).`,
    );
  }

  for (const dep of source.getDependencies()) {
    context.addSceneObject(dep);
  }
  context.addSceneObject(source);

  const obj = new Connector(name, source, options);
  obj.boundInstanceId = instance.instanceId;
  context.addSceneObject(obj);
  return obj.boundTo(instance.instanceId);
}

/**
 * The instance an assembly-scope connector source is bound to. The selection
 * itself carries it; an anchored vertex (`arm1.select(...).center()` /
 * `.start()` / `.end()` / `.offset(...)`) wraps the selection — unwrap it,
 * mirroring how `Connector.build` consumes through anchored vertices.
 */
function resolveSourceInstance(source: ISceneObject): AssemblyInstance | null {
  if (source instanceof InstanceSelectSceneObject) {
    return source.instance;
  }
  if (source instanceof AnchoredLazyVertex) {
    const selection = source.getSourceSelection();
    if (selection instanceof InstanceSelectSceneObject) {
      return selection.instance;
    }
  }
  return null;
}

export default registerBuilder(build, { allowAssemblyTopLevel: true });

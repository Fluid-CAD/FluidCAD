import { registerBuilder, SceneParserContext } from "../index.js";
import { getCurrentScene } from "../scene-manager.js";
import { Connector } from "../features/connector.js";
import {
  ConnectorOptions,
  isConnectorInput,
} from "../features/connector-frame.js";
import { IConnector, ISceneObject } from "./interfaces.js";
import { CONNECTOR_NAME_PATTERN } from "../selection/types.js";

interface ConnectorFunction {
  /**
   * Creates a named mate connector — a coordinate frame attached to the
   * active part. Must be called inside a `part(...)` block. The name
   * registers the connector on the part: assemblies reference it as
   * `instance.connectors.<name>`, so it must be a valid identifier and
   * unique within the part.
   *
   * Accepts a face/edge/vertex selection (`select(...)`), a sketch lazy
   * selection (e.g., `rect.edge('top')`), a `LazyVertex`, or a plane object.
   * Raw points are intentionally not allowed — the frame must be tied to
   * real geometry so it re-derives correctly on every render.
   *
   * @param name - Identifier the connector is registered under on the part.
   * @param source - The geometry the connector is attached to.
   * @param options - Optional `xDirection` override (re-orthogonalized against Z).
   */
  (name: string, source: ISceneObject, options?: ConnectorOptions): IConnector;
}

function build(context: SceneParserContext): ConnectorFunction {
  return function connector(name: string, source: ISceneObject, options: ConnectorOptions = {}): IConnector {
    const scene = getCurrentScene();
    const part = scene.getActivePart();
    if (!part) {
      throw new Error("connector() must be called inside a part() block.");
    }
    if (typeof name !== "string" || !CONNECTOR_NAME_PATTERN.test(name)) {
      const got = typeof name === "string" ? JSON.stringify(name) : `a ${typeof name}`;
      throw new Error(
        `connector(): the first argument is the connector's name — a plain identifier like 'topLeft' (got ${got}).`,
      );
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

export default registerBuilder(build);

import { registerBuilder, SceneParserContext } from "../index.js";
import { getCurrentScene } from "../scene-manager.js";
import { Connector } from "../features/connector.js";
import {
  ConnectorInput,
  ConnectorOptions,
  isConnectorInput,
} from "../features/connector-frame.js";
import { IConnector, ISceneObject } from "./interfaces.js";
import { SceneObject } from "../common/scene-object.js";

interface ConnectorFunction {
  /**
   * Creates a mate connector — a coordinate frame attached to the active part.
   * Must be called inside a `part(...)` block.
   *
   * Accepts a face/edge/vertex selection (`select(...)`), a sketch lazy
   * selection (e.g., `rect.topEdge()`), a `LazyVertex`, or a plane object.
   * Raw points are intentionally not allowed — the frame must be tied to
   * real geometry so it re-derives correctly on every render.
   *
   * @param source - The geometry the connector is attached to.
   * @param options - Optional `xDirection` override (re-orthogonalized against Z).
   */
  (source: ISceneObject, options?: ConnectorOptions): IConnector;
}

function build(context: SceneParserContext): ConnectorFunction {
  return function connector(source: ISceneObject, options: ConnectorOptions = {}): IConnector {
    const scene = getCurrentScene();
    const part = scene.getActivePart();
    if (!part) {
      throw new Error("connector() must be called inside a part() block.");
    }
    if (!isConnectorInput(source)) {
      throw new Error("connector(): source must be a face/edge/vertex selection, sketch lazy selection, LazyVertex, or plane object.");
    }

    // Ensure the source is registered with the scene so it builds before the
    // connector — `addSceneObject` is idempotent, so already-registered
    // sources (e.g., from `select(...)`) are unaffected.
    context.addSceneObject(source);

    const obj = new Connector(source, options);
    context.addSceneObject(obj);
    return obj;
  };
}

export default registerBuilder(build);

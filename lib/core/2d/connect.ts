import { Connect, ConnectMode } from "../../features/2d/connect.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { IGeometry } from "../interfaces.js";

interface ConnectFunction {
  (mode?: ConnectMode): IGeometry;
}

function build(context: SceneParserContext): ConnectFunction {
  return function connect(mode?: ConnectMode) {
    const connect = new Connect(mode);
    context.addSceneObject(connect);
    return connect;
  } as ConnectFunction;
}

export default registerBuilder(build);

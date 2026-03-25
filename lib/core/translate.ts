import { registerBuilder, SceneParserContext } from "../index.js";
import { normalizePoint } from "../helpers/normalize.js";
import { Translate } from "../features/translate.js";
import { Point, PointLike } from "../math/point.js";
import { SceneObject } from "../common/scene-object.js";
import { Vertex } from "../common/vertex.js";
import { LazyVertex } from "../features/lazy-vertex.js";
import { ISceneObject } from "./interfaces.js";

interface TranslateFunction {
  (x: number, ...targets: ISceneObject[]): ISceneObject;
  (x: number, copy: boolean, ...targets: ISceneObject[]): ISceneObject;
  (x: number, y: number, ...targets: ISceneObject[]): ISceneObject;
  (x: number, y: number, copy: boolean, ...targets: ISceneObject[]): ISceneObject;
  (x: number, y: number, z: number, ...targets: ISceneObject[]): ISceneObject;
  (x: number, y: number, z: number, copy: boolean, ...targets: ISceneObject[]): ISceneObject;
  (distance: PointLike, ...targets: ISceneObject[]): ISceneObject;
  (distance: PointLike, copy: boolean, ...targets: ISceneObject[]): ISceneObject;
}

function build(context: SceneParserContext): TranslateFunction {
  return function translate() {
    const args = Array.from(arguments);

    // Extract SceneObject targets from the end
    const targets: SceneObject[] = [];
    while (args.length > 0 && args[args.length - 1] instanceof SceneObject) {
      targets.unshift(args.pop() as SceneObject);
    }

    // Extract copy flag from the end (if boolean)
    const copy = typeof args[args.length - 1] === 'boolean' ? args.pop() as boolean : false;

    // translate(x, y?, z?)
    if (typeof args[0] === 'number') {
      const x = args[0] as number;
      const y = (args[1] as number) ?? 0;
      const z = (args[2] as number) ?? 0;
      const vertex = Vertex.fromPoint(new Point(x, y, z));
      const lazyVertex = LazyVertex.fromVertex(vertex);
      const translate = new Translate(lazyVertex, copy, ...targets);
      context.addSceneObject(translate);
      return translate;
    }

    // translate(distance: PointLike, copy?, ...targets)
    if (args.length === 1) {
      const normalizedDistance = normalizePoint(args[0]);
      const translate = new Translate(normalizedDistance, copy, ...targets);
      context.addSceneObject(translate);
      return translate;
    }

    throw new Error("Invalid arguments for translate function");
  } as TranslateFunction;
}

export default registerBuilder(build);


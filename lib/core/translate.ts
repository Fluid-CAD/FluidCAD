import { registerBuilder, SceneParserContext } from "../index.js";
import { normalizePoint } from "../helpers/normalize.js";
import { Translate } from "../features/translate.js";
import { Point, PointLike } from "../math/point.js";
import { SceneObject } from "../common/scene-object.js";
import { Vertex } from "../common/vertex.js";
import { LazyVertex } from "../features/lazy-vertex.js";

interface TranslateFunction {
  (x: number, copy?: boolean): Translate;
  (x: number, y: number, copy?: boolean): Translate;
  (x: number, y: number, z: number, copy?: boolean): Translate;
  (distance: PointLike, copy?: boolean): Translate;
  (objects: SceneObject[], distance: PointLike, copy?: boolean): Translate;
}

function build(context: SceneParserContext): TranslateFunction {
  return function translate() {
    const args = Array.from(arguments);
    const copy = typeof args[args.length - 1] === 'boolean' ? args.pop() as boolean : false;

    // translate(x, y?, z?)
    if (typeof args[0] === 'number') {
      const x = args[0] as number;
      const y = (args[1] as number) ?? 0;
      const z = (args[2] as number) ?? 0;
      const vertex = Vertex.fromPoint(new Point(x, y, z));
      const lazyVertex = LazyVertex.fromVertex(vertex);
      const translate = new Translate(lazyVertex, copy);
      context.addSceneObject(translate);
      return translate;
    }

    // translate(objects, distance, plane)
    if (Array.isArray(args[0]) && args.length >= 2) {
      const first = args[0];
      if (first.length === 0 || typeof first[0] !== 'number') {
        const objects = first as SceneObject[];
        const normalizedDistance = normalizePoint(args[1]);
        const translate = new Translate(normalizedDistance, copy, ...objects);
        context.addSceneObject(translate);
        return translate;
      }
    }

    // translate(distance: PointLike)
    if (args.length === 1) {
      const normalizedDistance = normalizePoint(args[0]);
      const translate = new Translate(normalizedDistance, copy);
      context.addSceneObject(translate);
      return translate;
    }

    throw new Error("Invalid arguments for translate function");
  } as TranslateFunction;
}

export default registerBuilder(build);

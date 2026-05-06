import { SceneObject } from "../common/scene-object.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { Rib } from "../features/rib.js";
import { Extrudable } from "../helpers/types.js";
import { IRib, ISceneObject } from "./interfaces.js";

interface RibFunction {
  /**
   * Creates a rib from the last sketch with the given thickness.
   * The rib extends in the sketch normal direction until it reaches
   * surrounding solids. Positive thickness = forward, negative = reverse.
   * @param thickness - Wall thickness (sign controls direction)
   */
  (thickness: number): IRib;

  /**
   * Creates a rib from an explicit sketch spine with the given thickness.
   * @param thickness - Wall thickness (sign controls direction)
   * @param spine - The sketch providing the rib spine wire and plane
   */
  (thickness: number, spine: ISceneObject): IRib;
}

function isExtrudable(obj: any): obj is Extrudable {
  return obj instanceof SceneObject && obj.isExtrudable();
}

function build(context: SceneParserContext): RibFunction {

  //@ts-ignore
  return function rib() {
    const args = [...arguments];

    if (args.length === 0) {
      throw new Error("rib() requires at least a thickness argument.");
    }

    const thickness = args[0] as number;
    if (typeof thickness !== 'number' || thickness === 0) {
      throw new Error("rib() thickness must be a non-zero number.");
    }

    let spine: SceneObject;
    let extrudable: Extrudable | undefined;

    if (args.length > 1 && isExtrudable(args[1])) {
      spine = args[1] as SceneObject;
      extrudable = args[1] as Extrudable;
    } else {
      const lastExtrudable = context.getLastExtrudable();
      if (!lastExtrudable) {
        throw new Error("rib() requires a sketch. No sketch found in the scene.");
      }
      spine = lastExtrudable;
      extrudable = lastExtrudable;
    }

    const result = new Rib(thickness, spine, extrudable);
    context.addSceneObject(result);
    return result;
  } as RibFunction;
}

export default registerBuilder(build);

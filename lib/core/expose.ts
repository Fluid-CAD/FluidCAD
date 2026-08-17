import { registerBuilder, SceneParserContext } from "../index.js";
import { getCurrentScene } from "../scene-manager.js";
import { SceneObject } from "../common/scene-object.js";
import { Exposed } from "../features/exposed.js";
import { ISceneObject } from "./interfaces.js";
import { MEMBER_NAME_PATTERN } from "../selection/types.js";

interface ExposeFunction {
  /**
   * Publishes a named piece of the part's geometry — the part's geometry
   * interface, the outbound counterpart of `param()` (values in) and
   * `connector()` (mate frames out). Declared inside a `part(...)` block,
   * the exposure registers on the part and other parts consume the SOURCE
   * through `def.features.<name>`:
   *
   *     export const p1 = part('Part1', () => {
   *       const s = sketch('xz', () => { ... }).reusable();
   *       expose('profile', s);
   *     });
   *
   *     // consumer part:
   *     extrude(15, p1.features.profile);
   *
   * Accepts any scene object — a sketch, a face/edge selection, a plane,
   * an axis, or a feature. Raw values are not allowed: an exposure must be
   * tied to real geometry so it re-derives correctly on every render.
   *
   * @param name - Identifier the exposure is registered under.
   * @param source - The scene object published under `def.features.<name>`.
   */
  (name: string, source: ISceneObject): ISceneObject;
}

function build(context: SceneParserContext): ExposeFunction {
  return function expose(name: string, source: ISceneObject): ISceneObject {
    const scene = getCurrentScene();
    const part = scene.getActivePart();
    if (!part) {
      // Registered with allowAssemblyTopLevel so assembly files reach this
      // pointed error instead of the generic part-design-only one.
      throw new Error(
        "expose() must be called inside a part() block — exposures are the part's "
        + "geometry interface; consumers read them as def.features.<name>.",
      );
    }
    // The part is found by scanning the container stack, but parenting goes
    // to the TOP container — an exposure nested in e.g. a sketch() callback
    // would become the sketch's child, invisible to Part.getExposed() and
    // every def.features lookup. Refuse instead of silently registering
    // nowhere.
    const container = scene.getActiveContainer();
    if (container !== part) {
      throw new Error(
        `expose() must be declared directly in the part() body — this call is nested inside `
        + `${container ? container.getType() + '(...)' : 'another callback'}, so the exposure would not `
        + `register on the part "${part.partName}". Move the statement out of the nested callback.`,
      );
    }
    if (typeof name !== "string" || !MEMBER_NAME_PATTERN.test(name)) {
      const got = typeof name === "string" ? JSON.stringify(name) : `a ${typeof name}`;
      throw new Error(
        `expose(): the first argument is the exposure's name — a plain identifier like 'profile' (got ${got}).`,
      );
    }

    if (part.getExposed().some(e => e.exposeName === name)) {
      throw new Error(
        `expose(): the part "${part.partName}" already exposes "${name}" — names must be unique within a part.`,
      );
    }
    if (!(source instanceof SceneObject)) {
      throw new Error(
        "expose(): source must be a scene object — a sketch, a face/edge selection, a plane, an axis, or a feature.",
      );
    }

    // Ensure the source (and anything it depends on — an inline lazy
    // selection is registered nowhere else) is in the scene so it builds
    // before the exposure — `addSceneObject` is idempotent, so
    // already-registered sources (e.g., a sketch) are unaffected.
    for (const dep of source.getDependencies()) {
      context.addSceneObject(dep);
    }
    context.addSceneObject(source);

    const obj = new Exposed(name, source);
    context.addSceneObject(obj);
    return obj;
  };
}

export default registerBuilder(build, { allowAssemblyTopLevel: true });

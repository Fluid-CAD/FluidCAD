import { registerBuilder, SceneParserContext } from "../index.js";
import { SceneObject } from "../common/scene-object.js";
import { isPlaneLike, PlaneLike } from "../math/plane.js";
import { PlaneObjectBase } from "../features/plane-renderable-base.js";
import { resolvePlane } from "../helpers/resolve.js";
import { SectionView } from "../features/section-view.js";
import type { SectionOptions } from "../features/section-view.js";
import { IPlane, ISceneObject, ISection } from "./interfaces.js";

export type { SectionOptions } from "../features/section-view.js";

interface SectionFunction {
  /**
   * Saves a named section view: a cut plane the viewer clips the scene at
   * when the view is activated from the section menu. Nothing is built and
   * the timeline shows no row — the statement only records the plane.
   *
   *     section('A-A', 'xz');                          // cut at the XZ plane
   *     section('Bore', 'xy', { offset: 12 });         // 12 above XY
   *     section('Flange', p, { flip: true });          // keep the other half
   *     section('Boss', select(face().onPlane('xy', 30)), { offset: -5 });
   *
   * The plane normal points at the half that is removed; `offset` moves the
   * cut along that normal and `flip` keeps the removed half instead. A face
   * yields its own plane, exactly as `plane(face)` reads it.
   *
   * @param name - The view's name, as the section menu lists it.
   * @param plane - An origin plane (`'xy'`, `'xz'`, `'yz'`), a `plane()` statement, or a planar face selection.
   * @param options - `offset` along the normal and `flip`.
   */
  (name: string, plane: PlaneLike | IPlane | ISceneObject, options?: SectionOptions): ISection;
}

function validateOptions(name: string, options: unknown): SectionOptions {
  if (options === undefined) {
    return {};
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error(`section('${name}'): the options are an object { offset?, flip? } (got ${options === null ? 'null' : typeof options}).`);
  }
  const { offset, flip } = options as SectionOptions;
  if (offset !== undefined && (typeof offset !== 'number' || !Number.isFinite(offset))) {
    throw new Error(`section('${name}'): offset must be a finite number (got ${JSON.stringify(offset)}).`);
  }
  if (flip !== undefined && typeof flip !== 'boolean') {
    throw new Error(`section('${name}'): flip must be a boolean (got ${JSON.stringify(flip)}).`);
  }
  return {
    ...(offset !== undefined ? { offset } : {}),
    ...(flip !== undefined ? { flip } : {}),
  };
}

function build(context: SceneParserContext): SectionFunction {
  return function section(name: string, plane: PlaneLike | IPlane | ISceneObject, options?: SectionOptions): ISection {
    if (typeof name !== 'string' || name.trim() === '') {
      const got = typeof name === 'string' ? JSON.stringify(name) : `a ${typeof name}`;
      throw new Error(`section(): the first argument is the view's name, as the section menu lists it (got ${got}).`);
    }
    const valid = plane instanceof PlaneObjectBase || isPlaneLike(plane) || plane instanceof SceneObject;
    if (!valid) {
      throw new Error(
        `section('${name}'): the second argument is the cut plane — 'xy', 'xz', 'yz', a plane() statement, or a planar face selection.`,
      );
    }
    const source = resolvePlane(plane as PlaneLike | ISceneObject, context);
    const view = new SectionView(name, source, validateOptions(name, options));
    context.addSceneObject(view);
    return view;
  };
}

export default registerBuilder<SectionFunction>(build, { allowAssemblyTopLevel: true });

import { Part } from "../features/part.js";
import type { SceneObject, SourceLocation } from "../common/scene-object.js";
import type { ParamVal } from "../param-registry.js";
import { TextDigest } from "../common/text-digest.js";
import type { RenderDetail, Scene } from "./scene.js";

/** One generator layout a render ran: an insert of a generated assembly (or its own file's render). */
export type GeneratedLayoutTiming = {
  /** The generated definition's id. */
  definition: string;
  /** The assembly's name. */
  assembly: string;
  /** Where it ran: the insert, or `defineAssembly()` when its own file renders. */
  sourceLocation?: SourceLocation;
  /** How long `layout(g)` took, values checked included. */
  ms: number;
  /** How many parts it added (`g.part()` calls). */
  parts: number;
  /** Whether the insert was refused (a bad value, a throw from the layout). */
  refused: boolean;
};

/**
 * Where a generated part's shapes came from in a render: `built` — the
 * generator's `build` ran (a miss); `kept` — the previous render held the
 * same template and the compare carried it over; `cached` — the template
 * cache held it (both hits).
 */
export type GeneratedTemplateSource = 'built' | 'kept' | 'cached';

/** One part template a render holds. */
export type GeneratedTemplateTiming = {
  definition: string;
  /** Its type, as `g.part(type, …)` named it. */
  type: string;
  /** A digest of its identity key — enough to tell two templates of one type apart in a report. */
  key: string;
  detail: RenderDetail;
  source: GeneratedTemplateSource;
  /** How long its `build` took — `built` only. */
  buildMs?: number;
  /** Its build error, if it has one. */
  error?: string;
};

/** One variant of a generated part (`definePart`) a render holds. */
export type GeneratedVariantTiming = {
  /** The generated definition's id (its feature's catalog key). */
  definition: string;
  /** The part's name. */
  part: string;
  /** The values it was built from, by id, defaults filled. */
  values: Record<string, ParamVal>;
  source: GeneratedTemplateSource;
  /** How long its members' builds took (the feature's, its frames', its connectors') — `built` only. */
  buildMs?: number;
  /** Its build error, if it has one. */
  error?: string;
};

/**
 * What a render did with generated parts: each layout it ran, each part
 * template it holds and each generated part's variant it holds, with where
 * their shapes came from — what the server reports with a preview's
 * timings. The counts and the build time cover both kinds of part.
 */
export type GeneratedBuildReport = {
  /** The scene's detail tier. */
  detail: RenderDetail;
  layouts: GeneratedLayoutTiming[];
  templates: GeneratedTemplateTiming[];
  /** The variants of generated parts (`definePart`), in scene order. */
  variants: GeneratedVariantTiming[];
  /** Parts the render did not build, templates and variants: `kept` from the previous render, `cached` from the template cache. */
  hits: { kept: number; cached: number };
  /** Parts the render built, templates and variants. */
  misses: number;
  /** Every layout's time, summed. */
  layoutMs: number;
  /** Every build's time, summed: templates' and variants'. */
  buildMs: number;
};

/**
 * Build instrumentation for generated parts, always on and cheap: a clock
 * read around each layout and each template build, and each build of a
 * variant's members (the renderer's own clock), kept beside the scene and
 * its parts — nothing is logged. {@link of} assembles a scene's report on
 * demand.
 */
export class GeneratedBuildReports {

  private static readonly layouts = new WeakMap<Scene, GeneratedLayoutTiming[]>();

  /** Each built template part's build time, in milliseconds. */
  private static readonly builds = new WeakMap<Part, number>();

  /** The template parts a render took from the template cache. */
  private static readonly taken = new WeakSet<Part>();

  /** A layout `scene`'s module evaluation ran. */
  static recordLayout(scene: Scene, timing: GeneratedLayoutTiming): void {
    let list = GeneratedBuildReports.layouts.get(scene);
    if (!list) {
      list = [];
      GeneratedBuildReports.layouts.set(scene, list);
    }
    list.push(timing);
  }

  /** The generator built `part`'s shapes, in `ms`. */
  static recordBuild(part: Part, ms: number): void {
    GeneratedBuildReports.builds.set(part, ms);
  }

  /**
   * The renderer built `member` in `ms`: a member of a generated part's
   * variant adds it to the variant's build time; any other object is not
   * reported here (a template's body reports its build itself).
   */
  static recordMemberBuild(member: SceneObject, ms: number): void {
    const part = member.getParent();
    if (part instanceof Part && part.generatedVariant) {
      GeneratedBuildReports.builds.set(part, (GeneratedBuildReports.builds.get(part) ?? 0) + ms);
    }
  }

  /** `part`'s shapes came from the template cache. */
  static recordTaken(part: Part): void {
    GeneratedBuildReports.taken.add(part);
  }

  /** What `scene` did with generated parts so far: its layouts, and its templates in scene order. */
  static of(scene: Scene): GeneratedBuildReport {
    const layouts = (GeneratedBuildReports.layouts.get(scene) ?? []).map(timing => ({ ...timing }));
    const templates: GeneratedTemplateTiming[] = [];
    const variants: GeneratedVariantTiming[] = [];
    const hits = { kept: 0, cached: 0 };
    let misses = 0;
    let buildMs = 0;
    /** Count one part's source and build time onto the totals; its `buildMs` when it was built. */
    const count = (part: Part, source: GeneratedTemplateSource): number | undefined => {
      if (source !== 'built') {
        hits[source]++;
        return undefined;
      }
      misses++;
      const ms = GeneratedBuildReports.builds.get(part);
      if (ms !== undefined) {
        buildMs += ms;
      }
      return ms;
    };
    for (const obj of scene.getAllSceneObjects()) {
      if (!(obj instanceof Part) || obj.getParent() !== null || obj.cacheKey() === null) {
        continue;
      }
      const source = GeneratedBuildReports.sourceOf(scene, obj);
      const ms = count(obj, source);
      const error = obj.getError();
      const mark = obj.generatedBy;
      if (mark) {
        templates.push({
          definition: mark.definition,
          type: mark.type,
          key: TextDigest.of(mark.key),
          detail: mark.detail,
          source,
          ...(ms !== undefined ? { buildMs: ms } : {}),
          ...(error ? { error } : {}),
        });
        continue;
      }
      variants.push({
        definition: obj.generatedVariant!.definition,
        part: obj.partName,
        values: { ...(obj.generated?.values ?? {}) },
        source,
        ...(ms !== undefined ? { buildMs: ms } : {}),
        ...(error ? { error } : {}),
      });
    }
    return {
      detail: scene.detail,
      layouts,
      templates,
      variants,
      hits,
      misses,
      layoutMs: layouts.reduce((sum, timing) => sum + timing.ms, 0),
      buildMs,
    };
  }

  private static sourceOf(scene: Scene, part: Part): GeneratedTemplateSource {
    if (GeneratedBuildReports.taken.has(part)) {
      return 'cached';
    }
    return scene.isCached(part) ? 'kept' : 'built';
  }
}

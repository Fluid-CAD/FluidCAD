import { Part } from "../features/part.js";
import type { SourceLocation } from "../common/scene-object.js";
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

/**
 * What a render did with generated parts: each layout it ran, and each
 * part template it holds with where its shapes came from — what the
 * server reports with a preview's timings.
 */
export type GeneratedBuildReport = {
  /** The scene's detail tier. */
  detail: RenderDetail;
  layouts: GeneratedLayoutTiming[];
  templates: GeneratedTemplateTiming[];
  /** Templates the render did not build: `kept` from the previous render, `cached` from the template cache. */
  hits: { kept: number; cached: number };
  /** Templates the render built. */
  misses: number;
  /** Every layout's time, summed. */
  layoutMs: number;
  /** Every build's time, summed. */
  buildMs: number;
};

/**
 * Build instrumentation for generated parts, always on and cheap: a clock
 * read around each layout and each template build, kept beside the scene
 * and its parts — nothing is logged. {@link of} assembles a scene's report
 * on demand.
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

  /** `part`'s shapes came from the template cache. */
  static recordTaken(part: Part): void {
    GeneratedBuildReports.taken.add(part);
  }

  /** What `scene` did with generated parts so far: its layouts, and its templates in scene order. */
  static of(scene: Scene): GeneratedBuildReport {
    const layouts = (GeneratedBuildReports.layouts.get(scene) ?? []).map(timing => ({ ...timing }));
    const templates: GeneratedTemplateTiming[] = [];
    const hits = { kept: 0, cached: 0 };
    let misses = 0;
    let buildMs = 0;
    for (const obj of scene.getAllSceneObjects()) {
      if (!(obj instanceof Part) || !obj.generatedBy || obj.getParent() !== null) {
        continue;
      }
      const mark = obj.generatedBy;
      const timing: GeneratedTemplateTiming = {
        definition: mark.definition,
        type: mark.type,
        key: TextDigest.of(mark.key),
        detail: mark.detail,
        source: GeneratedBuildReports.sourceOf(scene, obj),
      };
      if (timing.source === 'built') {
        misses++;
        const ms = GeneratedBuildReports.builds.get(obj);
        if (ms !== undefined) {
          timing.buildMs = ms;
          buildMs += ms;
        }
      } else {
        hits[timing.source]++;
      }
      const error = obj.getError();
      if (error) {
        timing.error = error;
      }
      templates.push(timing);
    }
    return {
      detail: scene.detail,
      layouts,
      templates,
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

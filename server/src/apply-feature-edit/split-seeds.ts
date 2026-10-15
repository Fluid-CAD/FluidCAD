// A split's seed edge, exported from its sketch before the split statement
// renders: `split(s.geometries.l, …)` names the line through the sketch
// callback's return value, the way a hole names a sketch point. Staged
// against the original buffer and handed back as one buffer plus the spec
// that names the export, so an Apply is one write and a refusal never
// leaves a half-edited file.

import type { SketchExportRequest } from '../../../lib/dist/selection/sketch-target.js';
import type { SplitPlaneSpec } from './features/split.ts';
import { isSketchProducer } from './producers/predicates.ts';
import { SketchExports } from './sketch-exports.ts';
import type { ApplyFeatureEditSpec } from './spec.ts';

type Staged = { code: string; spec: ApplyFeatureEditSpec } | { error: string };

export class SplitSeeds {
  /** The cut a create or an edit spec carries, or undefined. */
  static plane(spec: ApplyFeatureEditSpec): SplitPlaneSpec | { kind: 'keep' } | undefined {
    return spec.edit ? spec.edit.split?.plane : spec.split?.plane;
  }

  static needsStaging(spec: ApplyFeatureEditSpec): boolean {
    return spec.feature === 'split' && SplitSeeds.plane(spec)?.kind === 'sketchEdge';
  }

  /** The line numbers the spec addresses, in the order `relocate` hands them back. */
  private static trackedLines(spec: ApplyFeatureEditSpec): number[] {
    return [
      ...spec.producers.map(producer => producer.line),
      ...(spec.edit ? [spec.edit.line] : []),
      ...(spec.activePart ? [spec.activePart.line] : []),
    ];
  }

  private static withLines(spec: ApplyFeatureEditSpec, lines: number[], plane: SplitPlaneSpec): ApplyFeatureEditSpec {
    let at = 0;
    const producers = spec.producers.map(producer => ({ ...producer, line: lines[at++] }));
    const edit = spec.edit
      ? { ...spec.edit, line: lines[at++], split: { ...spec.edit.split!, plane } }
      : undefined;
    const activePart = spec.activePart ? { ...spec.activePart, line: lines[at++] } : undefined;
    return {
      ...spec, producers, edit, activePart,
      ...(spec.split ? { split: { ...spec.split, plane } } : {}),
    };
  }

  /**
   * Author the seed's export and hand back the spec naming it as an
   * expression, its lines followed across the edit (a `const s = ` binding
   * or a new `return { l }` line shifts what comes after).
   */
  static async prepare(code: string, spec: ApplyFeatureEditSpec): Promise<Staged> {
    const plane = SplitSeeds.plane(spec);
    if (!plane || plane.kind !== 'sketchEdge') {
      return { code, spec };
    }
    if (!isSketchProducer(spec, plane.producer)) {
      return { error: 'a split seed edge needs its sketch producer' };
    }
    const producer = spec.producers[plane.producer];
    // A seed is a whole curve — a bezier or a spline qualifies as well as
    // a solver entity.
    const refs: SketchExportRequest[] = [{
      sketch: { filePath: spec.filePath, line: producer.line, column: producer.column },
      target: plane.target,
      entities: 'geometry',
    }];
    const staged = await SketchExports.applyCreates(code, refs, SplitSeeds.trackedLines(spec));
    if ('error' in staged) {
      return staged;
    }
    return {
      code: staged.code,
      spec: SplitSeeds.withLines(spec, staged.anchors, { kind: 'expression', expression: staged.expressions[0] }),
    };
  }

  /**
   * The expression the export WOULD produce, for a preview: the same dry
   * run the selection resolver makes, against the current buffer, with
   * nothing written.
   */
  static async previewExpression(
    code: string,
    filePath: string,
    sketch: { line: number; column: number },
    target: SketchExportRequest['target'],
  ): Promise<string | { error: string }> {
    const staged = await SketchExports.applyCreates(code, [{ sketch: { filePath, ...sketch }, target, entities: 'geometry' }]);
    if ('error' in staged) {
      return staged;
    }
    return staged.expressions[0];
  }
}

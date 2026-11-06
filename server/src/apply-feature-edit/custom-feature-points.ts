// Custom feature specs: the sketch exports their picked sketch points need, staged before the statement renders.

import type { SketchExportRequest } from '../../../lib/dist/selection/sketch-target.js';
import { CustomFeatureStatement, type CustomFeatureOptions, type CustomValueSource } from './features/custom.ts';
import { isSketchProducer } from './producers/predicates.ts';
import { SketchExports } from './sketch-exports.ts';
import type { ApplyFeatureEditSpec } from './spec.ts';

type Staged = { code: string; spec: ApplyFeatureEditSpec } | { error: string };

/**
 * A point a custom feature's dialog picked on a sketch is named through
 * that sketch's return value (`s.geometries.l1.start()`), which may not
 * exist yet. Every such point of one statement is exported in one pass
 * against the original buffer — the way a hole's sketch points and a
 * loft's connections are — and the spec then names each by the expression
 * the export wrote, so an Apply is one write and a refusal never leaves a
 * half-edited file.
 */
export class CustomFeaturePoints {

  /** Whether the spec's custom feature picks a point a sketch must export first. */
  static needsStaging(spec: ApplyFeatureEditSpec): boolean {
    return spec.feature === 'custom' && CustomFeatureStatement.picksOf(spec).some(item => item?.kind === 'sketchPoint');
  }

  /** Author every export the spec's sketch points need; the spec comes back naming each by its expression. */
  static async prepare(code: string, spec: ApplyFeatureEditSpec): Promise<Staged> {
    if (!CustomFeaturePoints.needsStaging(spec)) {
      return { code, spec };
    }
    const refs: SketchExportRequest[] = [];
    for (const item of CustomFeatureStatement.picksOf(spec)) {
      if (item.kind !== 'sketchPoint') {
        continue;
      }
      if (!isSketchProducer(spec, item.producer)) {
        return { error: 'a picked sketch point needs its sketch producer' };
      }
      const producer = spec.producers[item.producer];
      refs.push({ sketch: { filePath: spec.filePath, line: producer.line, column: producer.column }, target: item.target });
    }
    const tracked = [
      ...spec.producers.map(producer => producer.line),
      ...(spec.edit ? [spec.edit.line] : []),
      ...(spec.activePart ? [spec.activePart.line] : []),
    ];
    const staged = await SketchExports.applyCreates(code, refs, tracked);
    if ('error' in staged) {
      return staged;
    }

    let expression = 0;
    const rename = (options: CustomFeatureOptions): CustomFeatureOptions => ({
      ...options,
      values: Object.fromEntries(Object.entries(options.values).map(([name, source]): [string, CustomValueSource] => [
        name,
        source?.kind === 'picks'
          ? {
            kind: 'picks',
            items: source.items.map(item => item.kind === 'sketchPoint'
              ? { kind: 'expression' as const, expression: staged.expressions[expression++] }
              : item),
          }
          : source,
      ])),
    });
    let anchor = 0;
    const producers = spec.producers.map(producer => ({ ...producer, line: staged.anchors[anchor++] }));
    const edit = spec.edit
      ? { ...spec.edit, line: staged.anchors[anchor++], custom: rename(spec.edit.custom!) }
      : undefined;
    const activePart = spec.activePart ? { ...spec.activePart, line: staged.anchors[anchor++] } : undefined;
    return {
      code: staged.code,
      spec: {
        ...spec, producers, edit, activePart,
        // The points renamed are the ones picksOf read: an edit's, else a create's.
        ...(!spec.edit && spec.custom ? { custom: rename(spec.custom) } : {}),
      },
    };
  }
}

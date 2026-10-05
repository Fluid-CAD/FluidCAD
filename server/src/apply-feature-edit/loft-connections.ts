// Loft connection specs: staging the sketch exports their points need before the statement renders.

import type { SketchExportRequest } from '../../../lib/dist/selection/sketch-target.js';
import type { LoftConnectionSpec } from './features/loft.ts';
import { isSketchProducer } from './producers/predicates.ts';
import { SketchExports } from './sketch-exports.ts';
import type { ApplyFeatureEditSpec } from './spec.ts';

/** Connection lists share one atomic producer staging pass; renderLoftConnections renders them. */
export class LoftConnections {
  static list(spec: ApplyFeatureEditSpec): LoftConnectionSpec[] | undefined {
    return spec.edit ? spec.edit.loft?.connections : spec.loft?.connections;
  }

  static hasExports(spec: ApplyFeatureEditSpec): boolean {
    const connections = LoftConnections.list(spec);
    return Array.isArray(connections) && connections.some(connection => connection?.kind === 'points'
      && Array.isArray(connection.points) && connection.points.some(point => point?.kind === 'sketch'));
  }

  static async prepare(code: string, spec: ApplyFeatureEditSpec): Promise<
    { code: string; spec: ApplyFeatureEditSpec } | { error: string }
  > {
    if (!LoftConnections.hasExports(spec)) {
      return { code, spec };
    }
    const refs: SketchExportRequest[] = [];
    for (const connection of LoftConnections.list(spec)!) {
      if (connection.kind !== 'points') {
        continue;
      }
      for (const point of connection.points) {
        if (point.kind !== 'sketch') {
          continue;
        }
        if (!isSketchProducer(spec, point.producer)) {
          return { error: 'a connection sketch point needs its sketch producer' };
        }
        const producer = spec.producers[point.producer];
        refs.push({ sketch: { filePath: spec.filePath, line: producer.line, column: producer.column }, target: point.target });
      }
    }
    const tracked = [...spec.producers.map(producer => producer.line),
      ...(spec.edit ? [spec.edit.line] : []), ...(spec.activePart ? [spec.activePart.line] : [])];
    const staged = await SketchExports.applyCreates(code, refs, tracked);
    if ('error' in staged) {
      return staged;
    }
    let expression = 0;
    const connections = LoftConnections.list(spec)!.map(connection => connection.kind === 'verbatim' ? connection : {
      ...connection,
      points: connection.points.map(point => point.kind === 'sketch'
        ? { kind: 'expression' as const, expression: staged.expressions[expression++] } : point),
    });
    let anchor = 0;
    const producers = spec.producers.map(producer => ({ ...producer, line: staged.anchors[anchor++] }));
    const edit = spec.edit ? { ...spec.edit, line: staged.anchors[anchor++], loft: { ...spec.edit.loft!, connections } } : undefined;
    const activePart = spec.activePart ? { ...spec.activePart, line: staged.anchors[anchor++] } : undefined;
    return { code: staged.code, spec: { ...spec, producers, edit, activePart,
      ...(spec.loft ? { loft: { ...spec.loft, connections } } : {}) } };
  }
}

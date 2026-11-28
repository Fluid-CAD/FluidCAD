// One end slot's request input — the start or the end of an edge or a curve, or a point — as every end-taking route reads and resolves it.

import type { FluidCadServer, SelectionBoundary } from '../../fluidcad-server/index.ts';
import {
  EndSpecs,
  extractNumericParams,
  makeProducerBindable,
  makeProducerNamer,
  resolveParamValues,
  type ApplyFeatureEditSpec,
  type EndRole,
  type EndSpec,
  type FeatureCallees,
} from '../../apply-feature-edit/index.ts';
import type { SketchLoc } from './locations.ts';
import { isKeepSlot } from './validate/common.ts';
import type { Pick, VertexPick } from './picks.ts';

/**
 * One end on the wire, as the dialog's end row holds it — the preview takes
 * the same refs (`GhostEndRef`, the column aside), so a dialog sends one
 * value to both:
 *
 * - `edge-end` — the start or the end of an edge of a solid, a surface, a
 *   curve or a sketch, by its viewport address, `end` in the edge's own
 *   sense (the anchors the hover rail offers); written as the edge's
 *   selector with `.start()` / `.end()`;
 * - `curve-end` — where a curve object starts or ends, by its statement's
 *   call site; written as its variable with `.start()` / `.end()`;
 * - `vertex` — a picked vertex, written as the point synthesis writes it:
 *   a solid's corner as the end of the edge that names it
 *   (`e.endEdges(0).start()`), a sketch's vertex as its sketch point
 *   (`s.geometries.p1`), exported from the sketch first.
 */
export type EndInput =
  | { kind: 'edge-end'; shapeId: string; index: number; end: EndRole }
  | { kind: 'curve-end'; filePath: string; line: number; column: number; end: EndRole }
  | { kind: 'vertex'; shapeId: string; index: number };

/** What the ends' resolution folds into: the spec's producer merger, parts and imports, and the files its picks live in. */
export type EndSink = {
  /** Folds a statement into the request's producers once (see `makeProducerMerger`). */
  merge: (producer: ApplyFeatureEditSpec['producers'][number]) => number;
  parts: ApplyFeatureEditSpec['parts'];
  imports: Set<string>;
  /** Every file an end lives in, in end order, for the caller's same-file check. */
  files: string[];
};

/** How the ends' picks are synthesized, and how a refusal answers the request. */
export type EndSynthesis = {
  server: FluidCadServer;
  /** The synthesis kind an edge end runs as: the tool's (`'bridge'`), which names one edge. */
  feature: 'bridge';
  /** The live buffer, which the producer names and the linkable parameters are read from. */
  code: string | null;
  /** The custom features the buffer imports, which bind like the built-ins. */
  callees: () => Promise<FeatureCallees>;
  /** An edit's boundary: the picks resolve against the world before its statement. */
  before?: SelectionBoundary;
  /** Answers the request with a refusal. */
  refuse: (status: number, reason: string, pick?: unknown) => void;
};

/**
 * The end inputs of an end slot: read off a request, and resolved into the
 * {@link EndSpec}s a statement writes — a curve's end bound as a producer,
 * an edge's end synthesized into its selector part, a vertex through the
 * point synthesis.
 */
export class EndInputs {
  /** Reads `raw` as an end. The refusal names the slot. */
  static validate(raw: unknown, slot: string): EndInput | { error: string } {
    const input = raw as { kind?: unknown; shapeId?: unknown; index?: unknown; end?: unknown; filePath?: unknown; line?: unknown; column?: unknown } | null;
    const addressed = typeof input?.shapeId === 'string' && input.shapeId.length > 0
      && Number.isInteger(input.index) && (input.index as number) >= 0;
    if (input?.kind === 'edge-end') {
      if (!addressed || !EndSpecs.isRole(input.end)) {
        return { error: `${slot} must be {kind: "edge-end", shapeId, index, end: "start"|"end"}` };
      }
      return { kind: 'edge-end', shapeId: input.shapeId as string, index: input.index as number, end: input.end };
    }
    if (input?.kind === 'curve-end') {
      if (typeof input.filePath !== 'string' || input.filePath.length === 0
        || !Number.isInteger(input.line) || (input.line as number) < 1 || !EndSpecs.isRole(input.end)) {
        return { error: `${slot} must be {kind: "curve-end", filePath, line, column, end: "start"|"end"}` };
      }
      const column = Number.isInteger(input.column) && (input.column as number) >= 0 ? input.column as number : 0;
      return { kind: 'curve-end', filePath: input.filePath, line: input.line as number, column, end: input.end };
    }
    if (input?.kind === 'vertex') {
      if (!addressed) {
        return { error: `${slot} must be {kind: "vertex", shapeId, index}` };
      }
      return { kind: 'vertex', shapeId: input.shapeId as string, index: input.index as number };
    }
    return { error: `${slot} must be {kind: "edge-end"|"curve-end"|"vertex", …}` };
  }

  /** Reads an edit's end: absent, null or `{kind: "keep"}` keeps the statement's own (`edit` undefined), anything else is a new end. */
  static validateEdit(raw: unknown, slot: string): { edit: EndInput | undefined } | { error: string } {
    if (isKeepSlot(raw)) {
      return { edit: undefined };
    }
    const input = EndInputs.validate(raw, slot);
    return 'error' in input ? input : { edit: input };
  }

  /** Whether the input is a picked edge or vertex — what needs synthesis (and, in an edit, a boundary). */
  static picksGeometry(input: EndInput | undefined): boolean {
    return input !== undefined && input.kind !== 'curve-end';
  }

  /** The call site of the curve statement a curve end names, or null for a picked edge or vertex, whose file the synthesis answers. */
  static statement(input: EndInput | undefined): SketchLoc | null {
    return input?.kind === 'curve-end' ? { filePath: input.filePath, line: input.line, column: input.column } : null;
  }

  /**
   * The ends the inputs come to, in order: a curve's end bound as a curve
   * producer, an edge's end synthesized on its own into the one selector
   * part it writes, the vertices through the point synthesis in one pass.
   * Null once a refusal has answered the request.
   */
  static async resolve(inputs: EndInput[], sink: EndSink, synthesis: EndSynthesis): Promise<EndSpec[] | null> {
    const vertices = inputs.flatMap(input => input.kind === 'vertex'
      ? [{ shapeId: input.shapeId, sub: { type: 'vertex' as const, index: input.index } }]
      : []);
    const points = vertices.length > 0 ? await EndInputs.points(vertices, sink, synthesis) : [];
    if (points === null) {
      return null;
    }
    let namer: Awaited<ReturnType<typeof makeProducerNamer>> | undefined;
    let params: { name: string; value: number }[] | undefined;
    const ends: EndSpec[] = [];
    let point = 0;
    for (const input of inputs) {
      if (input.kind === 'vertex') {
        ends.push(points[point++]);
        continue;
      }
      if (input.kind === 'curve-end') {
        sink.files.push(input.filePath);
        const producer = sink.merge({ line: input.line, column: input.column, featureType: 'wire', nameHint: 'c', bind: true });
        // A statement a selector part also reads keeps one entry: its end
        // taken, it is a curve, and binds as one.
        ends.push({ kind: 'curve', producer, end: input.end });
        continue;
      }
      if (synthesis.code && !namer) {
        namer = await makeProducerNamer(synthesis.code, await synthesis.callees());
        params = resolveParamValues(await extractNumericParams(synthesis.code), synthesis.server.getParamDefinitions());
      }
      const pick: Pick = { shapeId: input.shapeId, sub: { type: 'edge', index: input.index } };
      const result = synthesis.server.synthesizeApplyFeature(
        [pick], synthesis.feature, undefined, [], { namer, params, connector: { anchor: { kind: input.end } } }, synthesis.before,
      );
      if (!result) {
        synthesis.refuse(404, 'No rendered scene');
        return null;
      }
      if (!result.ok) {
        synthesis.refuse(422, result.reason, result.pick);
        return null;
      }
      // An end is ONE edge — a multi-part selection has no single
      // expression to take its start or end of.
      if (result.spec.parts.length !== 1) {
        synthesis.refuse(422, 'an end must be the start or the end of a single edge');
        return null;
      }
      sink.files.push(result.spec.filePath);
      const remap = result.spec.producers.map(sink.merge);
      const part = result.spec.parts[0];
      sink.parts.push({
        ...part,
        producer: part.producer === null ? null : remap[part.producer],
        refs: part.refs ? part.refs.map((i: number) => remap[i]) : part.refs,
      });
      for (const symbol of result.spec.imports) {
        sink.imports.add(symbol);
      }
      ends.push({ kind: 'edge', part: sink.parts.length - 1, end: input.end });
    }
    return ends;
  }

  /**
   * The picked vertices as the point synthesis writes them, in pick order —
   * a solid's corner as the end of the edge whose selector names it, its
   * part folded into the sink; a sketch's vertex as its sketch point, its
   * export staged later. Null once a refusal has answered the request.
   */
  private static async points(picks: VertexPick[], sink: EndSink, synthesis: EndSynthesis): Promise<EndSpec[] | null> {
    const { server, code } = synthesis;
    if (!code) {
      synthesis.refuse(422, 'no current source buffer is available to name a picked vertex');
      return null;
    }
    const callees = await synthesis.callees();
    const resolved = server.resolveSelection({ picks, ...(synthesis.before ? { before: synthesis.before.index } : {}) }, {
      namer: await makeProducerNamer(code, callees),
      bindable: await makeProducerBindable(code, callees),
      params: resolveParamValues(await extractNumericParams(code), server.getParamDefinitions()),
    });
    if (resolved.ok === false) {
      synthesis.refuse(422, resolved.reason);
      return null;
    }
    const named = resolved.synthesized;
    if (!named?.ok) {
      synthesis.refuse(422, named && named.ok === false ? named.reason : 'the workspace kernel cannot name the picked vertex');
      return null;
    }
    const remap = new Map<string, number>();
    for (const producer of named.producers) {
      if (!producer.filePath || producer.line === null) {
        synthesis.refuse(422, 'a picked vertex has no source statement');
        return null;
      }
      sink.files.push(producer.filePath);
      remap.set(producer.sceneObjectId, sink.merge({
        line: producer.line, column: producer.column ?? 0,
        featureType: producer.featureType, nameHint: producer.variable, bind: true,
      }));
    }
    const ends: EndSpec[] = [];
    for (const part of named.parts) {
      if (part.point?.kind === 'sketch' && part.producer !== null && remap.has(part.producer)) {
        ends.push({ kind: 'sketch', producer: remap.get(part.producer)!, target: part.point.target });
      } else if (part.point?.kind === 'edge') {
        sink.parts.push({
          producer: part.producer === null ? null : remap.get(part.producer)!,
          accessor: part.accessor, indices: part.point.indices, filterArgs: part.point.filterArgs,
          refs: part.point.refs.map(id => remap.get(id)!),
        });
        ends.push({ kind: 'edge', part: sink.parts.length - 1, end: part.point.role });
      } else {
        synthesis.refuse(422, 'a picked vertex has no source expression');
        return null;
      }
    }
    if (ends.length !== picks.length) {
      synthesis.refuse(422, 'each picked vertex must come to one point expression');
      return null;
    }
    for (const symbol of named.imports) {
      sink.imports.add(symbol);
    }
    return ends;
  }
}

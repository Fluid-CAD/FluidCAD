// An end: the start or the end of an edge or of a curve, or a point — the spec a tool's end slot holds, its rendering, its check, and the sketch exports its points need.

import type { SolvedEmissionTarget, SketchExportRequest } from '../../../../lib/dist/selection/sketch-target.js';
import { isExpressionText } from '../../code-editor/index.ts';
import { isSketchProducer, isWireProducer } from '../producers/predicates.ts';
import { renderSelectorPartExpr } from '../render/selectors.ts';
import { SketchExports } from '../sketch-exports.ts';
import type { ApplyFeatureEditSpec } from '../spec.ts';
import { OperandPicks } from './operand-picks.ts';

/** Which end of an edge or a curve: its `.start()` or its `.end()`. */
export type EndRole = 'start' | 'end';

/**
 * One end, as a tool's end slot takes it — a bridge's `from` and `to`; a
 * point a later tool runs to:
 *
 * - `edge` — the start or the end of an edge of a body, a curve or a
 *   sketch: the selector `parts[part]` renders, then `.start()` / `.end()`.
 *   A picked vertex of a solid comes to this too: the end of the edge whose
 *   selector names it (`e.endEdges(0).start()`);
 * - `curve` — where a curve statement starts or ends: its bound variable,
 *   then `.start()` / `.end()` (`c.end()`);
 * - `sketch` — a sketch point, named through its sketch's return value
 *   (`s.geometries.l1.start()`, `s.geometries.p1`), which the export staging
 *   ({@link EndSpecs.stage}) authors first;
 * - `expression` — a sketch point once staged: the expression the export
 *   wrote. Only the staging produces it.
 */
export type EndSpec =
  | { kind: 'edge'; part: number; end: EndRole }
  | { kind: 'curve'; producer: number; end: EndRole }
  | { kind: 'sketch'; producer: number; target: SolvedEmissionTarget }
  | { kind: 'expression'; expression: string };

/** An end in an edit: the statement's own argument kept as written (an absent one too), or a new end. */
export type EndEdit = { kind: 'keep' } | EndSpec;

/** The producers and selector parts an end indexes into. */
type EndHost = Pick<ApplyFeatureEditSpec, 'producers' | 'parts'>;

/** An end's rendering, check and staging, shared by every statement that takes one. */
export class EndSpecs {
  /** Whether `value` names an end of an edge or a curve. */
  static isRole(value: unknown): value is EndRole {
    return value === 'start' || value === 'end';
  }

  /**
   * The end as an expression: the edge's selector or the curve's variable
   * with its `.start()` / `.end()`, or a staged sketch point's expression.
   * Null for a sketch point not yet staged, which has no name until its
   * export is written. Shared with the routes' previews, which pass their
   * namer's variables; the transform passes its bindings'.
   */
  static render(
    end: EndSpec,
    parts: ApplyFeatureEditSpec['parts'],
    varFor: (producer: number) => string | null,
  ): string | null {
    if (end.kind === 'edge') {
      const part = parts[end.part];
      return `${renderSelectorPartExpr(part, part.producer === null ? null : varFor(part.producer), varFor)}.${end.end}()`;
    }
    if (end.kind === 'curve') {
      return `${varFor(end.producer) ?? 'c'}.${end.end}()`;
    }
    return end.kind === 'expression' ? end.expression : null;
  }

  /** Whether an end, or an end in an edit, is a sketch point the staging must export first. */
  static isSketchPoint(end: EndEdit | undefined): end is Extract<EndSpec, { kind: 'sketch' }> {
    return end?.kind === 'sketch';
  }

  /** The selector part an edge end renders; none for the other kinds. */
  static parts(end: EndSpec): number[] {
    return end.kind === 'edge' ? [end.part] : [];
  }

  /**
   * Reads `value` as an end of `spec`: an edge end by a selector part the
   * spec holds, a curve end by a bound curve producer, a sketch point by a
   * sketch producer and its target, a staged expression by its text. The
   * refusal names the slot (`the from end`).
   */
  static validate(value: unknown, spec: EndHost, slot: string): EndSpec | { error: string } {
    const raw = value as { kind?: unknown; part?: unknown; producer?: unknown; end?: unknown; target?: unknown; expression?: unknown } | null;
    if (raw?.kind === 'edge') {
      const part = raw.part as number;
      if (!Number.isInteger(part) || part < 0 || part >= spec.parts.length) {
        return { error: `${slot} references no selector part` };
      }
      return EndSpecs.isRole(raw.end) ? { kind: 'edge', part, end: raw.end } : { error: `${slot} must say start or end` };
    }
    if (raw?.kind === 'curve') {
      const producer = raw.producer as number;
      if (!isWireProducer(spec as ApplyFeatureEditSpec, producer) || !spec.producers[producer].bind) {
        return { error: `${slot} references a statement that is not a curve` };
      }
      return EndSpecs.isRole(raw.end) ? { kind: 'curve', producer, end: raw.end } : { error: `${slot} must say start or end` };
    }
    if (raw?.kind === 'sketch') {
      const producer = raw.producer as number;
      if (!isSketchProducer(spec as ApplyFeatureEditSpec, producer) || typeof raw.target !== 'object' || raw.target === null) {
        return { error: `${slot} names a sketch point without its sketch or its target` };
      }
      return { kind: 'sketch', producer, target: raw.target as SolvedEmissionTarget };
    }
    if (raw?.kind === 'expression') {
      return isExpressionText(raw.expression) ? { kind: 'expression', expression: raw.expression } : { error: `${slot} has an empty expression` };
    }
    return { error: `unknown ${slot} kind` };
  }

  /**
   * An edited end's text: the statement's own (`kept`) while it is kept, a
   * new end rendered with each producer under `varFor`'s variable or else
   * its own hint. Answers the selector part a new edge end renders; a new
   * end the spec does not hold, or a sketch point not staged, is refused.
   */
  static edited(
    edit: EndEdit | undefined,
    kept: string,
    spec: EndHost,
    varFor: (producer: number) => string | null,
    slot: string,
  ): { text: string; parts: number[] } | { error: string } {
    if (edit === undefined || edit.kind === 'keep') {
      return { text: kept, parts: [] };
    }
    const end = EndSpecs.validate(edit, spec, slot);
    if ('error' in end) {
      return end;
    }
    const text = EndSpecs.render(end, spec.parts, OperandPicks.editNamer(spec, varFor));
    return text === null ? { error: `${slot} names a sketch point whose export was not staged` } : { text, parts: EndSpecs.parts(end) };
  }

  /**
   * Authors the sketch exports the `ends` that are sketch points need, in
   * one pass against `code`, and hands back the staged buffer, each sketch
   * point named by the expression its export wrote, and the spec with its
   * producers', its edit's and its active part's lines followed across the
   * export (a `const s = ` binding or a new `return { … }` line shifts what
   * comes after). Nothing to stage gives everything back as it was; a
   * refusal never leaves a half-edited buffer.
   */
  static async stage<E extends EndEdit | undefined>(
    code: string,
    spec: ApplyFeatureEditSpec,
    ends: E[],
  ): Promise<{ code: string; spec: ApplyFeatureEditSpec; ends: E[] } | { error: string }> {
    const refs: SketchExportRequest[] = [];
    for (const end of ends as (EndEdit | undefined)[]) {
      if (!EndSpecs.isSketchPoint(end)) {
        continue;
      }
      if (!isSketchProducer(spec, end.producer)) {
        return { error: 'a sketch point end needs its sketch producer' };
      }
      const producer = spec.producers[end.producer];
      refs.push({ sketch: { filePath: spec.filePath, line: producer.line, column: producer.column }, target: end.target });
    }
    if (refs.length === 0) {
      return { code, spec, ends };
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
    const named = ends.map(end => EndSpecs.isSketchPoint(end)
      ? { kind: 'expression' as const, expression: staged.expressions[expression++] }
      : end) as E[];
    let anchor = 0;
    const producers = spec.producers.map(producer => ({ ...producer, line: staged.anchors[anchor++] }));
    const edit = spec.edit ? { ...spec.edit, line: staged.anchors[anchor++] } : undefined;
    const activePart = spec.activePart ? { ...spec.activePart, line: staged.anchors[anchor++] } : undefined;
    return { code: staged.code, spec: { ...spec, producers, edit, activePart }, ends: named };
  }
}

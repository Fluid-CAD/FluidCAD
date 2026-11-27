// POST /apply-feature for a tool written from rows of curve or surface picks: the synthesis its rows share, the same-file check, the statement under the namer's variables, and the preview or the transform.

import type { Response } from 'express';
import {
  extractNumericParams,
  makeProducerNamer,
  resolveParamValues,
  type ApplyFeatureEditSpec,
  type RowPicks,
} from '../../apply-feature-edit/index.ts';
import type { SketchLoc } from './locations.ts';
import { OperandInputs, type RowInputs, type RowKinds } from './operand-inputs.ts';
import type { Pick as EntityPick } from './picks.ts';
import { allocateProducerVars, makeProducerMerger } from './synthesis.ts';
import type { ApplyFeatureRequestContext } from './context.ts';

/** The tools written from rows of operand picks: each the spec's feature and its synthesis kind. */
export type OperandRowFeature = 'intersection-curve' | 'projected-curve' | 'offset-curve';

/** A tool's payload under its own key on the spec. */
export type OperandRowSpecPayload =
  | Pick<ApplyFeatureEditSpec, 'intersectionCurve'>
  | Pick<ApplyFeatureEditSpec, 'projectedCurve'>
  | Pick<ApplyFeatureEditSpec, 'offsetCurve'>;

/**
 * What a request picks besides its rows (a direction) is resolved through:
 * the rows' own producer merger and synthesis, and the request's refusal.
 */
export type RowSynthesis = {
  /** Folds a statement into the request's producers once (see `makeProducerMerger`). */
  merge: (producer: ApplyFeatureEditSpec['producers'][number]) => number;
  /** Synthesizes picked edges or faces into selector parts: the indices of the parts added, or null once it has refused the request. */
  synthesize: (picks: EntityPick[]) => Promise<number[] | null>;
  /** Refuses the request (422) with `reason`. */
  refuse: (reason: string) => void;
};

/**
 * One operand-row tool's create request, as {@link createFromOperandRows}
 * runs it: its rows, what else it names, and how its payload and statement
 * are made from the resolved picks.
 */
export type OperandRowCreation<R extends string, P> = {
  /** The spec's feature, which is also the synthesis kind of every pick. */
  feature: OperandRowFeature;
  /** What each row takes, in argument order (`OperandRows.kinds`). */
  kinds: RowKinds<R>;
  /** Each row's picks, as the request sent them. */
  rows: RowInputs<R>;
  /** The call sites the request names besides its rows (a direction's statement), for the same-file check. */
  sites?: SketchLoc[];
  /** The refusal when the picks come from more than one file. */
  differentFiles: string;
  /**
   * The payload the spec carries, from the rows' resolved picks and
   * whatever else the request picks, resolved through the same synthesis
   * after the rows; null once that has refused the request (it has
   * answered).
   */
  payload: (rows: RowPicks<R>, synthesis: RowSynthesis) => Promise<P | null> | P | null;
  /** The statement the payload writes, each producer under `varFor`'s variable: the tool's own renderer, which the transform shares. */
  statement: (payload: P, parts: ApplyFeatureEditSpec['parts'], varFor: (producer: number) => string | null) => string;
  /** The payload under the tool's key on the spec. */
  spec: (payload: P) => OperandRowSpecPayload;
};

/** One synthesis answer, as an arm reads it. */
type Synthesis =
  | { ok: true; spec: Pick<ApplyFeatureEditSpec, 'filePath' | 'producers' | 'parts' | 'imports'> }
  | { ok: false; reason: string; pick?: unknown };

/**
 * Runs an operand-row tool's create request: each row resolved in argument
 * order — a whole object bound as a producer, a row's edges or faces
 * synthesized together into selectors — then the tool's payload; the
 * picks, the statements and `sites` checked to come from one file; the
 * statement rendered under the variables the transform will allocate; then
 * the preview answered, or the spec dispatched to the transform. The
 * synthesis setup (namer, parameters) is built on the first pick that needs
 * it, so a request of whole objects and literals runs none. Every refusal
 * answers the request itself.
 */
export async function createFromOperandRows<R extends string, P>(
  ctx: ApplyFeatureRequestContext,
  res: Response,
  creation: OperandRowCreation<R, P>,
): Promise<void> {
  const { fluidCadServer, dispatcher, preview, newVariables, activePartFor } = ctx;
  try {
    const code = fluidCadServer.getCurrentCode();
    const merger = makeProducerMerger();
    const parts: ApplyFeatureEditSpec['parts'] = [];
    const imports = new Set<string>();
    const files = [...OperandInputs.rowStatements(creation.rows), ...(creation.sites ?? [])].map(loc => loc.filePath);

    let options: { namer: Awaited<ReturnType<typeof makeProducerNamer>>; params: { name: string; value: number }[] } | undefined;
    const synthesize = async (picks: EntityPick[]): Promise<number[] | null> => {
      if (!options && code) {
        options = {
          namer: await makeProducerNamer(code, await ctx.currentCallees()),
          params: resolveParamValues(await extractNumericParams(code), fluidCadServer.getParamDefinitions()),
        };
      }
      const synthesis: Synthesis | null = fluidCadServer.synthesizeApplyFeature(picks, creation.feature, undefined, [], options);
      if (!synthesis) {
        res.status(404).json({ success: false, reason: 'No rendered scene' });
        return null;
      }
      if (synthesis.ok !== true) {
        res.status(422).json({ success: false, reason: synthesis.reason, pick: synthesis.pick });
        return null;
      }
      files.push(synthesis.spec.filePath);
      const remap = synthesis.spec.producers.map(merger.merge);
      const added: number[] = [];
      for (const part of synthesis.spec.parts) {
        added.push(parts.length);
        parts.push({
          ...part,
          producer: part.producer === null ? null : remap[part.producer],
          refs: part.refs ? part.refs.map(i => remap[i]) : part.refs,
        });
      }
      for (const symbol of synthesis.spec.imports) {
        imports.add(symbol);
      }
      return added;
    };

    const rows = await OperandInputs.resolveRows(creation.rows, creation.kinds, merger, synthesize);
    if (!rows) {
      return;
    }
    const payload = await creation.payload(rows, {
      merge: merger.merge,
      synthesize,
      refuse: reason => {
        res.status(422).json({ success: false, reason });
      },
    });
    if (payload === null) {
      return;
    }
    if (!OperandInputs.sameFile(files)) {
      res.status(422).json({ success: false, reason: creation.differentFiles });
      return;
    }
    const filePath = files[0] ?? fluidCadServer.getCurrentFileName();
    if (!filePath) {
      res.status(404).json({ success: false, reason: 'No rendered scene' });
      return;
    }

    // Truthful preview names: the same allocation walk the transform runs.
    const producerVars = await allocateProducerVars(merger.producers, code, await ctx.currentCallees());
    const statement = creation.statement(payload, parts, i => producerVars[i]);
    if (preview === true) {
      res.json({ success: true, preview: statement });
      return;
    }
    const activePart = activePartFor(filePath);
    await dispatcher.dispatch(res, {
      feature: creation.feature,
      ...creation.spec(payload),
      filePath,
      producers: merger.producers,
      parts,
      imports: [...imports],
      newVariables,
      ...(activePart ? { activePart } : {}),
    }, { success: true, preview: statement });
  } catch (err) {
    res.status(500).json({ success: false, reason: thrownReason(err) });
  }
}

/** What a thrown value says, as every route's 500 answers it: its message, else the value as text. */
function thrownReason(err: unknown): unknown {
  return (err as { message?: unknown } | null | undefined)?.message ?? String(err);
}

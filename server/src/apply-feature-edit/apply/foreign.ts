// Cross-part references: applying nested exposure creates and rendering the consumer-side sketch/projection.

import { ensureSymbolImport, importLocalName } from '../../code-editor.ts';
import { applyCreateEdit } from './create.ts';
import { relocateCallLines } from '../call-site-relocation.ts';
import { CONNECTOR_NAME } from '../features/connector.ts';
import type { ForeignExposureRef } from '../features/expose.ts';
import { appendTopLevelStatement } from '../insertion.ts';
import { resolvePartBindingIdent } from '../part-binding.ts';
import type { ApplyFeatureEditResult, ApplyFeatureEditSpec, FeatureEditApply } from '../spec.ts';

/**
 * The consumer-side cross-part reference rail the sketch-on-face and the
 * projection creates share. A reference renders as
 * `<ident>.features.<exposeName>`; a same-file `create` (the donor's
 * `expose()` statement) is applied FIRST in the same transform, and every
 * call site the consumer statement still needs — its own anchors, the
 * donors, the later creates' producers — is relocated across that edit by
 * callee ordinal: an exposure edit adds an `expose(...)` call and binds a
 * producer in place, so the k-th `part(...)` / `extrude(...)` / `sketch(...)`
 * call before it is the k-th one after it.
 */
export class ForeignExposures {
  /** Shape check for one reference — exactly one addressing mode, a same-file-only create. */
  static valid(ref: ForeignExposureRef | undefined): ref is ForeignExposureRef {
    if (!ref || typeof ref !== 'object') {
      return false;
    }
    const sameFile = ref.donor !== undefined;
    return typeof ref.exposeName === 'string' && CONNECTOR_NAME.test(ref.exposeName)
      && (sameFile !== (typeof ref.ident === 'string'))
      && (!sameFile || (Number.isInteger(ref.donor!.line) && Number.isInteger(ref.donor!.column)))
      && (ref.ident === undefined || CONNECTOR_NAME.test(ref.ident))
      && (ref.importFrom === undefined || (typeof ref.importFrom === 'string' && !sameFile))
      && (ref.create === undefined
        || (sameFile && ref.create.feature === 'expose'
          && ref.create.sketchForeign === undefined && ref.create.project === undefined));
  }

  /** The expression a resolved reference renders. */
  static reference(ident: string, ref: ForeignExposureRef): string {
    return `${ident}.features.${ref.exposeName}`;
  }

  /**
   * Apply every same-file `create` in order. `anchors` are the caller's own
   * 1-based call-site lines (the active part, the target sketch, the local
   * producers); they come back relocated alongside the refs, whose donor
   * sites and pending creates are relocated the same way. Fails without
   * touching anything when a create refuses or a site cannot be followed.
   * `apply` is the top-level transform each create goes through.
   */
  static async applyCreates(
    apply: FeatureEditApply,
    code: string,
    refs: ForeignExposureRef[],
    anchors: number[],
  ): Promise<{ code: string; refs: ForeignExposureRef[]; anchors: number[] } | { error: string }> {
    let working = code;
    let pending = refs.map(ref => ({ ...ref }));
    let lines = anchors.slice();
    for (let k = 0; k < pending.length; k++) {
      const create = pending[k].create;
      if (!create) {
        continue;
      }
      const applied = await apply(working, create);
      if (applied.error) {
        return { error: applied.error };
      }
      const tracked = [
        ...lines,
        ...pending.flatMap(ref => (ref.donor ? [ref.donor.line] : [])),
        ...pending.slice(k + 1).flatMap(ref => (ref.create ? ForeignExposures.createSiteLines(ref.create) : [])),
      ];
      const map = await relocateCallLines(working, applied.newCode, tracked);
      if (!map) {
        return {
          error: 'could not relocate the part statements after the exposure edit — is the file in sync with the last render?',
        };
      }
      working = applied.newCode;
      lines = lines.map(line => map.get(line)!);
      pending = pending.map((ref, j) => ({
        ...ref,
        ...(ref.donor ? { donor: { ...ref.donor, line: map.get(ref.donor.line)! } } : {}),
        ...(j > k && ref.create ? { create: ForeignExposures.relocateCreate(ref.create, map) } : {}),
      }));
    }
    return { code: working, refs: pending, anchors: lines };
  }

  /**
   * The identifier a reference renders against `code`: the donor's
   * module-level binding (same file) or what its import binds here
   * (cross-file — the export may already be aliased, or shadowed).
   */
  static async resolveIdent(
    code: string,
    ref: ForeignExposureRef,
  ): Promise<{ ident: string } | { error: string }> {
    if (ref.donor) {
      const resolved = await resolvePartBindingIdent(code, ref.donor.line);
      return 'error' in resolved ? resolved : { ident: resolved.ident };
    }
    const ident = ref.importFrom ? await importLocalName(code, ref.ident!, ref.importFrom) : ref.ident!;
    return { ident };
  }

  /** Import every cross-file donor under the local name its reference rendered. */
  static async ensureImports(code: string, refs: ForeignExposureRef[], idents: string[]): Promise<string> {
    let out = code;
    for (const [i, ref] of refs.entries()) {
      if (ref.importFrom) {
        out = await ensureSymbolImport(out, ref.ident!, ref.importFrom, idents[i]);
      }
    }
    return out;
  }

  /** The call-site lines an expose create spec addresses. */
  private static createSiteLines(create: ApplyFeatureEditSpec): number[] {
    return [
      ...(create.expose?.part ? [create.expose.part.line] : []),
      ...create.producers.map(p => p.line),
    ];
  }

  private static relocateCreate(create: ApplyFeatureEditSpec, map: Map<number, number>): ApplyFeatureEditSpec {
    return {
      ...create,
      ...(create.expose?.part
        ? { expose: { ...create.expose, part: { ...create.expose.part, line: map.get(create.expose.part.line)! } } }
        : {}),
      producers: create.producers.map(p => ({ ...p, line: map.get(p.line)! })),
    };
  }
}

/**
 * The consumer-side cross-part sketch: render
 * `sketch(<ident>.features.<exposeName>, () => {})` into the ACTIVE part's
 * body. With a same-file `create` spec the exposure statement is applied
 * first in the same transform, the active part's call site relocated
 * across it, so both stages stay atomic in one editor round trip.
 */
export async function applySketchForeign(
  code: string,
  spec: ApplyFeatureEditSpec,
  apply: FeatureEditApply,
): Promise<ApplyFeatureEditResult> {
  const sf = spec.sketchForeign;
  const valid = ForeignExposures.valid(sf)
    && Number.isInteger(spec.activePart?.line) && Number.isInteger(spec.activePart?.column)
    && spec.producers.length === 0 && spec.parts.length === 0;
  if (!valid) {
    return { newCode: code, error: 'malformed foreign sketch spec' };
  }

  const staged = await ForeignExposures.applyCreates(apply, code, [sf], [spec.activePart!.line]);
  if ('error' in staged) {
    return { newCode: code, error: staged.error };
  }
  const ref = staged.refs[0];
  const ident = await ForeignExposures.resolveIdent(staged.code, ref);
  if ('error' in ident) {
    return { newCode: code, error: ident.error };
  }

  const result = await appendTopLevelStatement(
    staged.code,
    indent => `sketch(${ForeignExposures.reference(ident.ident, ref)}, () => {\n\n${indent}})`,
    'sketch',
    spec.newVariables,
    { line: staged.anchors[0], column: spec.activePart!.column },
  );
  if (result.error) {
    return { newCode: code, error: result.error };
  }
  return { newCode: await ForeignExposures.ensureImports(result.newCode, [ref], [ident.ident]) };
}

/**
 * The cross-part projection: `project(<own selectors>, <ident>.features.<name>, …)`
 * into the sketch body, the donors' same-file `expose()` creates applied
 * first with the sketch call site and the local producers relocated across
 * them — one atomic transform. The references append after the selector
 * parts; a verbatim `rawArgs` override stands as typed.
 */
export async function applyProjectForeign(
  code: string,
  spec: ApplyFeatureEditSpec,
  apply: FeatureEditApply,
): Promise<ApplyFeatureEditResult> {
  const pj = spec.project!;
  const refs = pj.foreign!;
  const valid = Array.isArray(refs) && refs.every(ref => ForeignExposures.valid(ref))
    && Number.isInteger(pj.sketch?.line) && Number.isInteger(pj.sketch?.column);
  if (!valid) {
    return { newCode: code, error: 'malformed foreign project spec' };
  }

  const anchors = [pj.sketch.line, ...spec.producers.map(p => p.line)];
  const staged = await ForeignExposures.applyCreates(apply, code, refs, anchors);
  if ('error' in staged) {
    return { newCode: code, error: staged.error };
  }
  const idents: string[] = [];
  for (const ref of staged.refs) {
    const ident = await ForeignExposures.resolveIdent(staged.code, ref);
    if ('error' in ident) {
      return { newCode: code, error: ident.error };
    }
    idents.push(ident.ident);
  }

  const relocated: ApplyFeatureEditSpec = {
    ...spec,
    producers: spec.producers.map((p, i) => ({ ...p, line: staged.anchors[i + 1] })),
    project: { ...pj, sketch: { ...pj.sketch, line: staged.anchors[0] }, foreign: staged.refs },
  };
  const result = await applyCreateEdit(staged.code, relocated, {
    foreignArgs: staged.refs.map((ref, i) => ForeignExposures.reference(idents[i], ref)),
  });
  if (result.error) {
    return { newCode: code, error: result.error };
  }
  return { newCode: await ForeignExposures.ensureImports(result.newCode, staged.refs, idents) };
}

// mirror(): option types, statement rendering, chain parsing and the edit renderer.

import type { TSNode } from '../../code-editor/index.ts';
import { resolveRepeatTargetRef } from '../ast/args.ts';
import type { ChainSegment } from '../ast/chain.ts';
import { renderRepeatPlaneExpr, type RepeatPlaneSpec } from './repeat.ts';
import type { ChainParse, ParsedFeatureStatement } from '../parse/parsed-statement.ts';
import { isCopyTargetProducer, isPlaneProducer } from '../producers/predicates.ts';
import { renderOpChains } from '../render/chains.ts';
import { renderSelectorPartExpr } from '../render/selectors.ts';
import type { ApplyFeatureEditSpec, EditRenderSpec } from '../spec.ts';

/**
 * The 2D in-sketch mirror's axis: a sketch-plane datum (`xAxis()` /
 * `yAxis()`), or a picked sketch line — its selector part rendered BARE
 * (`mirror(l, …)`), the documented form the kernel lifts through
 * AxisFromEdge itself; unlike a copy direction it never wraps in `axis()`.
 */
export type MirrorAxisSpec =
  | { kind: 'local'; axis: 'x' | 'y' }
  | { kind: 'selector'; part: number };

/**
 * How a mirror statement is rendered and placed:
 * `mirror(<plane>, …targets)[.remove()|.new()]` — the default fuse renders no
 * chain. Targets are the solid-bearing feature statements being reflected,
 * each bound to a variable (featureType `feature` producers); the plane takes
 * the repeat mirror's plane shapes (origin literal / plane statement /
 * picked face as `plane(<selector>)`). The statement always inserts at end
 * of scope: a mirror reflects its targets over the finished model, and a
 * picked selector must resolve there.
 *
 * The 2D in-sketch form — `mirror(<axis>, …targets)` inside a sketch body —
 * carries an `axis` where the plane was (the two are mutually exclusive):
 * its targets are sketch-geometry producers (rect, circle, …) and it takes
 * no operation chain, so `op` is always `add`. It lands at the end of its
 * producers' scope like every sketch-body statement.
 */
export type MirrorEditOptions = {
  /** The plane to mirror across (3D). Mutually exclusive with `axis`. */
  plane?: RepeatPlaneSpec;
  /** The line to mirror across (2D, inside a sketch). Mutually exclusive with `plane`. */
  axis?: MirrorAxisSpec;
  /** How the reflected bodies land: fused (the default), cut, or standalone. */
  op: 'add' | 'remove' | 'new';
  /** The features being mirrored, in argument order — bound producers. */
  targets: { producer: number }[];
};

/**
 * Render a 2D mirror's axis argument: `xAxis()` / `yAxis()` for a
 * sketch-plane datum, or the picked line's selector part BARE — the kernel's
 * `mirror(line, …)` form takes the line itself, not `axis(line)`. Shared with
 * the route, which passes its namer's variables; the transform passes its
 * bindings'.
 */
export function renderMirrorAxisExpr(
  axis: MirrorAxisSpec,
  parts: ApplyFeatureEditSpec['parts'],
  varFor: (producer: number) => string | null,
): string {
  if (axis.kind === 'local') {
    return `${axis.axis}Axis()`;
  }
  const part = parts[axis.part];
  return renderSelectorPartExpr(part, part.producer === null ? null : varFor(part.producer), varFor);
}

/**
 * Render a mirror statement from its rendered plane (or, for the 2D form,
 * axis) input and target expressions: `mirror('yz', e)` /
 * `mirror(p, e, f).new()` / `mirror(yAxis(), r, c)` — the default fuse
 * renders no chain. Shared with the route's preview so the previewed text is
 * exactly what the transform writes.
 */
export function renderMirrorStatement(
  mo: Pick<MirrorEditOptions, 'op'>,
  inputExpr: string,
  targetExprs: string[],
): string {
  return `mirror(${[inputExpr, ...targetExprs].join(', ')})`
    + renderOpChains({ op: mo.op, thin: null });
}

/**
 * A `fuse(…)`, `subtract(…)` or `common(…)` statement's dialog-editable
 * reading — the callee is the kind. Target expressions are preserved
 * verbatim; a single-array argument (`fuse([a, b])`) is unpacked to its
 * elements, so the edit rewrite flattens it. A subtract must carry exactly
 * its base and tool arguments; fuse and common accept any count (empty
 * operates on every active shape).
 */
/**
 * A `mirror(<plane>, …targets)` statement's dialog-editable reading. The
 * plane and target expressions are preserved verbatim; the recognized
 * operation chains read as the op (`.add()` is the fuse default and simply
 * reads as it). An argument-less target list is legal — an implicit mirror
 * reflects the last feature — and reads as the empty list, exactly as an
 * implicit copy's does.
 */
export function parseMirrorChain(
  args: TSNode[],
  recognized: Map<string, ChainSegment>,
  start: number,
  end: number,
): ChainParse {
  if (args.length < 1) {
    return { error: 'the mirror has fewer arguments than the dialog understands' };
  }
  const ops = (['add', 'remove', 'new'] as const).filter(op => recognized.has(op));
  if (ops.length > 1) {
    return { error: 'the statement chains more than one operation — edit it in the source' };
  }
  const op: 'add' | 'remove' | 'new' = ops[0] ?? 'add';
  return {
    parsed: {
      feature: 'mirror',
      op,
      planeText: args[0].text,
      targetTexts: args.slice(1).map(n => n.text),
      targetRefs: args.slice(1).map(n => resolveRepeatTargetRef(n, start)),
    },
    start,
    end,
  };
}

/**
 * Render an edited mirror statement: resolve the plane input — a keep entry
 * re-reads the statement's own argument text, a re-sourced one renders from
 * producers/parts like create mode — and the target list (`verbatim` keeps by
 * position, re-picked features by bound producer; an absent list keeps every
 * statement target, an implicit statement's empty list included). The op
 * rewrites the operation chain wholesale. Selector parts must be covered
 * exactly once — for a mirror the plane is the only input that can claim one.
 */
export function renderEditedMirror(
  parsed: Extract<ParsedFeatureStatement, { feature: 'mirror' }>,
  spec: EditRenderSpec,
  varFor: (producer: number) => string | null,
): { statement: string } | { error: string } {
  const opts = spec.edit?.mirror;
  if (!opts || (opts.op !== 'add' && opts.op !== 'remove' && opts.op !== 'new')) {
    return { error: 'malformed mirror edit spec' };
  }
  const usedParts = new Set<number>();
  const claimPart = (part: number): boolean => {
    if (!Number.isInteger(part) || part < 0 || part >= spec.parts.length || usedParts.has(part)) {
      return false;
    }
    usedParts.add(part);
    return true;
  };

  const plane = opts.plane;
  const axis = opts.axis;
  let inputExpr: string;
  if (axis !== undefined) {
    // The 2D form: the statement's first argument is its axis, and the
    // chain-less kernel form takes no op.
    if (plane !== undefined || opts.op !== 'add') {
      return { error: 'malformed mirror edit spec' };
    }
    if (axis.kind === 'keep') {
      inputExpr = parsed.planeText;
    } else {
      if (axis.kind === 'selector') {
        if (!claimPart(axis.part)) {
          return { error: 'malformed mirror edit spec: bad selector axis' };
        }
      } else if (axis.kind !== 'local' || (axis.axis !== 'x' && axis.axis !== 'y')) {
        return { error: 'malformed mirror edit spec' };
      }
      inputExpr = renderMirrorAxisExpr(axis, spec.parts, varFor);
    }
  } else if (plane?.kind === 'keep') {
    inputExpr = parsed.planeText;
  } else {
    if (plane?.kind === 'selector') {
      if (!claimPart(plane.part)) {
        return { error: 'malformed mirror edit spec: bad selector plane' };
      }
    } else if (plane?.kind === 'plane') {
      if (!isPlaneProducer(spec as ApplyFeatureEditSpec, plane.producer)) {
        return { error: 'malformed mirror edit spec: the plane references a non-plane producer' };
      }
    } else if (plane?.kind !== 'standard'
      || (plane.plane !== 'xy' && plane.plane !== 'xz' && plane.plane !== 'yz')) {
      return { error: 'malformed mirror edit spec' };
    }
    inputExpr = renderRepeatPlaneExpr(plane, spec.parts, varFor);
  }

  let targetExprs = parsed.targetTexts;
  if (opts.targets !== undefined) {
    if (!Array.isArray(opts.targets) || opts.targets.length < 1) {
      return { error: 'a mirror needs at least one target feature' };
    }
    const usedVerbatim = new Set<number>();
    const exprs: string[] = [];
    for (const target of opts.targets) {
      if (target?.kind === 'verbatim') {
        if (!Number.isInteger(target.sourceIndex) || target.sourceIndex < 0
          || target.sourceIndex >= parsed.targetTexts.length || usedVerbatim.has(target.sourceIndex)) {
          return { error: 'malformed mirror edit spec: a kept target no longer matches the statement' };
        }
        usedVerbatim.add(target.sourceIndex);
        exprs.push(parsed.targetTexts[target.sourceIndex]);
      } else if (target?.kind === 'feature') {
        // A 3D mirror's targets are feature producers; the 2D form's are
        // sketch-geometry producers — the copy target rule covers both.
        if (!isCopyTargetProducer(spec as ApplyFeatureEditSpec, target.producer)) {
          return { error: 'malformed mirror edit spec: a target references a non-feature producer' };
        }
        exprs.push(varFor(target.producer) ?? spec.producers[target.producer].nameHint ?? 'f');
      } else {
        return { error: 'malformed mirror edit spec: unknown target kind' };
      }
    }
    targetExprs = exprs;
  }
  if (usedParts.size !== spec.parts.length) {
    return { error: 'malformed mirror edit spec: a selector part belongs to no input' };
  }

  return { statement: renderMirrorStatement(opts, inputExpr, targetExprs) };
}

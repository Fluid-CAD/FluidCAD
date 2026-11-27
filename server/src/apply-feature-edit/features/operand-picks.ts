// Curve and surface operands: the picks an operand slot holds, their rendering, read-back and check.

import type { TSNode } from '../../code-editor/index.ts';
import { resolveRepeatTargetRef, type OperandList } from '../ast/args.ts';
import { isSurfaceProducer, isWireProducer } from '../producers/predicates.ts';
import { renderSelectorPartExpr } from '../render/selectors.ts';
import type { ApplyFeatureEditSpec } from '../spec.ts';

/**
 * One pick of a curve or surface operand. A click on standalone construction
 * geometry means the whole object — a sketch, a curve object, an object
 * holding a surface — and is written as that statement's variable; a click
 * on a body means the edge or the face itself, written as a selector.
 */
export type OperandPick =
  /** A whole object, by its statement: `producers[producer]`, bound to a variable. */
  | { kind: 'producer'; producer: number }
  /** An edge or a face of a body: the selector rendered from `parts[part]`. */
  | { kind: 'selector'; part: number };

/**
 * An operand slot in an edit: keep the statement's own argument text, or
 * replace it with these picks. An absent slot reads as `keep`, so an edit
 * that touches only values leaves the operand byte-identical.
 */
export type OperandEdit = { kind: 'keep' } | { kind: 'picks'; picks: OperandPick[] };

/** The producers and selector parts an operand's picks index into. */
type OperandSpec = Pick<ApplyFeatureEditSpec, 'producers' | 'parts'>;

/** What each kind of slot takes, as a refusal says it. */
const TAKES = { curve: 'curves and edges', surface: 'surfaces and faces' } as const;

/**
 * The picks of a curve or surface operand slot, for every tool that takes
 * one: how they are written into a statement, read back out of one, and
 * checked against the spec that carries them. A tool's statement renderer is
 * its callee, its operand arguments from here, and its chained options.
 */
export class OperandPicks {
  /**
   * One expression per pick, in pick order: a whole object's bound variable
   * (the caller's `varFor` supplies its fallback name; `f` when it has
   * none), an edge's or a face's selector. Shared with the routes'
   * previews, which pass their namer's variables; the transform passes its
   * bindings'.
   */
  static render(
    picks: OperandPick[],
    parts: ApplyFeatureEditSpec['parts'],
    varFor: (producer: number) => string | null,
  ): string[] {
    return picks.map(pick => {
      if (pick.kind === 'producer') {
        return varFor(pick.producer) ?? 'f';
      }
      const part = parts[pick.part];
      return renderSelectorPartExpr(part, part.producer === null ? null : varFor(part.producer), varFor);
    });
  }

  /**
   * The variable an edit writes for a producer: the transform's binding,
   * else the producer's own hint — what a re-picked operand's whole object
   * is written as.
   */
  static editNamer(
    spec: Pick<ApplyFeatureEditSpec, 'producers'>,
    varFor: (producer: number) => string | null,
  ): (producer: number) => string | null {
    return producer => varFor(producer) ?? spec.producers[producer].nameHint ?? null;
  }

  /**
   * One argument for a slot: the bare expression for a single pick
   * (`sweep(spine)`), a list for several (`[a, b.sideEdges(0)]`).
   */
  static argument(exprs: string[]): string {
    return exprs.length === 1 ? exprs[0] : `[${exprs.join(', ')}]`;
  }

  /**
   * The expressions an edited slot writes: the statement's own texts while
   * the slot is kept, the rendered picks once it is re-picked.
   */
  static edited(
    edit: OperandEdit | undefined,
    kept: string[],
    parts: ApplyFeatureEditSpec['parts'],
    varFor: (producer: number) => string | null,
  ): string[] {
    return edit === undefined || edit.kind === 'keep' ? kept : OperandPicks.render(edit.picks, parts, varFor);
  }

  /**
   * Reads a slot's argument back: a list's elements, or the bare expression
   * as the one element, each with the statement a bare variable names. The
   * texts are verbatim — whatever the argument holds is what a kept slot
   * writes again — so nothing is refused here.
   */
  static parse(arg: TSNode, start: number): OperandList {
    return OperandPicks.parseArguments(
      arg.type === 'array' ? arg.namedChildren.filter(child => child.type !== 'comment') : [arg],
      start,
    );
  }

  /** Reads a slot written as the call's own arguments, one operand each (`fuse(a, b)`). */
  static parseArguments(args: TSNode[], start: number): OperandList {
    return {
      texts: args.map(arg => arg.text),
      refs: args.map(arg => resolveRepeatTargetRef(arg, start)),
    };
  }

  /**
   * Reads `picks` as the picks of `slot` in `spec`. A curve slot takes
   * curve producers (a bound wire or sketch statement) and edge selectors;
   * a surface slot takes surface holders and face selectors. A selector
   * whose part does not say what it names (a whole feature, a custom
   * accessor) is let through: the engine decides at build. The refusal
   * names the slot.
   */
  static validate(
    kind: 'curve' | 'surface',
    picks: unknown,
    slot: string,
    spec: OperandSpec,
  ): OperandPick[] | { error: string } {
    if (!Array.isArray(picks)) {
      return { error: `${slot} must be a list of picks` };
    }
    const valid: OperandPick[] = [];
    for (const pick of picks as { kind?: unknown; producer?: unknown; part?: unknown }[]) {
      if (pick?.kind === 'producer') {
        const producer = pick.producer as number;
        const fits = kind === 'curve'
          ? isWireProducer(spec as ApplyFeatureEditSpec, producer)
          : isSurfaceProducer(spec as ApplyFeatureEditSpec, producer);
        if (!fits || !spec.producers[producer].bind) {
          return { error: `${slot} takes ${TAKES[kind]}: a pick references a statement that is neither` };
        }
        valid.push({ kind: 'producer', producer });
        continue;
      }
      if (pick?.kind !== 'selector') {
        return { error: `${slot} holds a pick of an unknown kind` };
      }
      const part = pick.part as number;
      if (!Number.isInteger(part) || part < 0 || part >= spec.parts.length) {
        return { error: `${slot} holds a pick that references no selector part` };
      }
      const names = OperandPicks.namedBy(spec.parts[part]);
      if (names !== null && names !== (kind === 'curve' ? 'edge' : 'face')) {
        return { error: `${slot} takes ${TAKES[kind]}, not ${names === 'face' ? 'a face' : 'an edge'}` };
      }
      valid.push({ kind: 'selector', part });
    }
    return valid;
  }

  /**
   * What a selector part names, where the part says: a bucket accessor's
   * name ends in its kind (`sideEdges`, `faces`), a global `select()` leads
   * with its filter (`edge()…`, `face()…`). Null when it says neither.
   */
  private static namedBy(part: ApplyFeatureEditSpec['parts'][number]): 'edge' | 'face' | null {
    if (part.producer !== null && part.accessor !== '') {
      if (/edges$/i.test(part.accessor)) {
        return 'edge';
      }
      return /faces$/i.test(part.accessor) ? 'face' : null;
    }
    const filter = (part.filterArgs ?? '').trimStart();
    if (/^edge\s*\(/.test(filter)) {
      return 'edge';
    }
    return /^face\s*\(/.test(filter) ? 'face' : null;
  }
}

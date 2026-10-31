// shell(): option types and the .join() chain segment.

import type { ChainSegment } from '../ast/chain.ts';
import { numericArgValue, stringArgValue } from '../ast/args.ts';
import { ValueSlots, type ChoiceSlot } from '../value-slots.ts';

/**
 * Mirror of the kernel's `ShellJoinType` — how the inner-wall offset closes
 * corners. 'arc' is the kernel default and renders no chain.
 */
export type ShellJoinKind = 'arc' | 'intersection' | 'tangent';

/** The join dropdown's slot: one of the kinds, a variable named in its place, or the expression computing it. */
export type ShellJoinSlot = ChoiceSlot<ShellJoinKind>;

/**
 * How a shell statement's join type is rendered: a `.join('<type>')` chain
 * after the selector arguments; 'arc' (the kernel default) renders none.
 */
export type ShellEditOptions = {
  /** The join kind, or an expression computing it — written bare, `.join(join)`. */
  joinType: ShellJoinSlot;
};

/**
 * Render a shell's `.join(…)` chain; the literal 'arc' (the kernel default)
 * and absence render nothing, an expression renders bare — only the literal
 * default is elided, since an expression may come to anything. Shared with
 * the route's preview so the previewed text is exactly what the transform
 * writes.
 */
export function renderShellJoinChain(joinType: ShellJoinSlot | undefined): string {
  if (!joinType || ValueSlots.literal(joinType) === 'arc') {
    return '';
  }
  return `.join(${ValueSlots.source(joinType, type => `'${type}'`)})`;
}

export const SHELL_JOIN_KINDS: readonly ShellJoinKind[] = ['arc', 'intersection', 'tangent'];

/** A join slot a dialog may write: one of the kinds, a reference, or an expression (the statement's own kept as it was). */
export function validShellJoin(value: unknown, kept?: ReadonlySet<string>): value is ShellJoinSlot {
  return ValueSlots.validChoice(value, SHELL_JOIN_KINDS, kept);
}

/**
 * A shell's `.join(…)` member: an 'arc' / 'intersection' / 'tangent'
 * literal, a name standing for one, or the expression computing it.
 * Absence reads as 'arc' — the kernel default. A literal that is none of
 * the kinds is refused — the dropdown has nothing to show for it.
 */
export function parseJoinSegment(
  seg: ChainSegment | undefined,
): { joinType: ShellJoinSlot } | { error: string } {
  if (!seg) {
    return { joinType: 'arc' };
  }
  const typeNode = seg.args.length === 1 ? seg.args[0] : null;
  if (!typeNode) {
    return { error: 'the .join() chain takes one argument — edit it in the source' };
  }
  const literal = stringArgValue(typeNode) ?? numericArgValue(typeNode);
  if (literal !== null && !(SHELL_JOIN_KINDS as readonly (string | number)[]).includes(literal)) {
    return { error: `the .join() type '${literal}' is not one the dialog knows` };
  }
  const joinType = ValueSlots.choice(typeNode, SHELL_JOIN_KINDS);
  if (joinType === null) {
    return { error: 'the .join() argument is not one the dialog can carry — edit it in the source' };
  }
  return { joinType };
}

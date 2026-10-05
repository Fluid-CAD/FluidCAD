// shell(): option types and the .join() chain segment.

import type { ChainSegment } from '../ast/chain.ts';

/**
 * Mirror of the kernel's `ShellJoinType` — how the inner-wall offset closes
 * corners. 'arc' is the kernel default and renders no chain.
 */
export type ShellJoinKind = 'arc' | 'intersection' | 'tangent';

/**
 * How a shell statement's join type is rendered: a `.join('<type>')` chain
 * after the selector arguments; 'arc' (the kernel default) renders none.
 */
export type ShellEditOptions = {
  joinType: ShellJoinKind;
};

/**
 * Render a shell's `.join('<type>')` chain; 'arc' (the kernel default) and
 * absence render nothing. Shared with the route's preview so the previewed
 * text is exactly what the transform writes.
 */
export function renderShellJoinChain(joinType: ShellJoinKind | undefined): string {
  if (!joinType || joinType === 'arc') {
    return '';
  }
  return `.join('${joinType}')`;
}

export const SHELL_JOIN_KINDS = new Set<ShellJoinKind>(['arc', 'intersection', 'tangent']);

/**
 * A shell's `.join(…)` member: a plain 'arc' / 'intersection' / 'tangent'
 * string. Absence reads as 'arc' — the kernel default.
 */
export function parseJoinSegment(
  seg: ChainSegment | undefined,
): { joinType: ShellJoinKind } | { error: string } {
  if (!seg) {
    return { joinType: 'arc' };
  }
  const typeNode = seg.args.length === 1 ? seg.args[0] : null;
  if (!typeNode || typeNode.type !== 'string') {
    return { error: 'the .join() type is not a plain string — edit it in the source' };
  }
  const type = typeNode.text.slice(1, -1) as ShellJoinKind;
  if (!SHELL_JOIN_KINDS.has(type)) {
    return { error: `the .join() type '${type}' is not one the dialog knows` };
  }
  return { joinType: type };
}

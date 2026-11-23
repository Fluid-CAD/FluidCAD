// What a scratch build (docs/agent-chat-plan.md §23) puts on a card that
// shows one: the numbers under its picture, and why it did not build. Shared
// by the variants card (§24) and the approval card's before and after (§25).

import type { ToolResult, TryBuildOutput } from '../../mcp/dist/server.js';
import type { ChangePreviewProblem, VariantFacts } from './types.ts';

/** Longest reason a card carries for one problem. */
export const MAX_REASON_CHARS = 400;

/** A build that evaluated: `rendered`, or `build-error` with what did build. */
export type EvaluatedBuild = Exclude<TryBuildOutput, { state: 'compile-error' }>;

/** The numbers a card shows of a build that evaluated: bodies, overall size, volume, each in the build's unit. */
export function buildFacts(outcome: EvaluatedBuild): VariantFacts {
  return {
    solidCount: outcome.solidCount,
    size: outcome.bounds
      ? [0, 1, 2].map((axis) => round(outcome.bounds!.max[axis] - outcome.bounds!.min[axis])) as [number, number, number]
      : null,
    volume: outcome.volume,
    unit: outcome.unit,
    ...(outcome.instanceCount !== undefined ? { instanceCount: outcome.instanceCount } : {}),
    ...(outcome.validation ? { sound: outcome.validation.ok } : {}),
  };
}

/**
 * Why a build is not a model that builds, one entry per reason, in the
 * order the engine gave them; empty for one that rendered. The engine
 * refusing the build, a compile error, or each feature that failed.
 */
export function buildProblems(built: ToolResult<TryBuildOutput>): ChangePreviewProblem[] {
  if (built.ok === false) {
    return [{ title: 'Not built', message: cut(firstLine(built.message)) }];
  }
  const outcome = built.data;
  if (outcome.state === 'compile-error') {
    const line = outcome.compileError.sourceLocation?.line;
    return [{ title: 'Compile error', message: cut(firstLine(outcome.compileError.message)), ...(typeof line === 'number' ? { line } : {}) }];
  }
  if (outcome.state === 'build-error') {
    if (outcome.objectErrors.length === 0) {
      return [{ title: 'Build error', message: 'A feature does not build.' }];
    }
    return outcome.objectErrors.map((error) => ({
      title: `${error.name || 'A feature'} failed`,
      message: cut(firstLine(error.message)),
      ...(typeof error.sourceLocation?.line === 'number' ? { line: error.sourceLocation.line } : {}),
    }));
  }
  return [];
}

export function firstLine(text: string): string {
  return (text ?? '').split('\n')[0].trim();
}

export function cut(text: string): string {
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS - 1)}…` : text;
}

/** Extents come out of exact bounds with float noise in the last places: six decimals is past any unit's precision. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

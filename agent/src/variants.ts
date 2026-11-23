// Variants the agent proposes to the user (`propose_variants`,
// docs/agent-chat-plan.md §24): what a call's input becomes on the card,
// what a build of a variant puts on its tile, what the page may answer, and
// what the model is told.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MAX_VARIANTS, MIN_VARIANTS, type ProposeVariantsInput, type ProposedVariant, type ToolResult, type TryBuildOutput } from '../../mcp/dist/server.js';
import { buildFacts, cut, firstLine } from './build-facts.ts';
import { MAX_ANSWER_CHARS, type VariantTile, type VariantsPart, type VariantsReply } from './types.ts';

/** How a variants card ended. */
export type VariantsOutcome =
  | { kind: 'picked'; label: string }
  | { kind: 'answered'; text: string }
  | { kind: 'skipped' }
  /** No variant built: there is nothing to choose from. */
  | { kind: 'none-built' }
  /** The file is no longer the one the variants were built from: the pick was not written. */
  | { kind: 'stale'; label: string }
  /** The file could not be copied before the write: the pick was not written. */
  | { kind: 'no-copy'; label: string; message: string }
  | { kind: 'stopped' | 'shutdown' | 'timeout' | 'aborted' };

export const VARIANTS_STOPPED_MESSAGE = 'The user stopped the turn before choosing a variant.';
export const VARIANTS_TIMED_OUT_MESSAGE =
  'The user did not choose within an hour. Do not propose again: end your turn and say what you need to know.';
export const VARIANTS_SKIPPED_NOTE =
  'The user chose none of the variants, and nothing was written. Decide yourself, make the change with write_file or edit_range, and state the assumption you made.';
export const VARIANTS_ANSWERED_NOTE =
  'The user wrote this instead of picking a variant, and nothing was written. Act on what they wrote.';
export const VARIANTS_RESTART_REASON = 'The app restarted before you chose.';
export const VARIANTS_RESTART_BUILDING_REASON = 'The app restarted while these were building.';

/** One variant of a call, checked: its label and description as the tile shows them, and how its candidate was given. */
export type ReadVariant = { label: string; description?: string; candidate: Pick<ProposedVariant, 'content' | 'edits'> };

/**
 * The variants of a call as the card shows them, or what is wrong with them.
 * The schema already bounds the count and the lengths; this trims, refuses
 * labels one pick could not tell apart, and refuses a variant that is not
 * exactly one candidate. Whether more than two were asked for is the
 * model's to judge (the tool's description says when); the count is only
 * bounded here.
 */
export function readVariants(input: ProposeVariantsInput): { ok: true; variants: ReadVariant[] } | { ok: false; error: string } {
  const given = Array.isArray(input.variants) ? input.variants : [];
  if (given.length < MIN_VARIANTS || given.length > MAX_VARIANTS) {
    const fix = given.length > MAX_VARIANTS ? `Offer the ${MAX_VARIANTS} that differ most` : 'Offer two that differ';
    return {
      ok: false,
      error: `propose_variants takes ${MIN_VARIANTS} variants, or up to ${MAX_VARIANTS} when the user asked for that many; this call has ${given.length}. ${fix}, or ask with ask_user.`,
    };
  }
  const variants: ReadVariant[] = [];
  const seen = new Set<string>();
  for (const variant of given) {
    const label = variant.label.trim();
    if (seen.has(label)) {
      return { ok: false, error: `${given.length === 2 ? 'Both' : 'Two'} variants are labelled "${label}". Give each its own label.` };
    }
    seen.add(label);
    const hasContent = variant.content !== undefined;
    const hasEdits = variant.edits !== undefined;
    if (hasContent === hasEdits) {
      return {
        ok: false,
        error: `Variant "${label}": give the candidate as \`content\` (the whole file) or as \`edits\`, ${hasContent ? 'not both' : 'one of the two'}.`,
      };
    }
    const description = variant.description?.trim();
    variants.push({
      label,
      ...(description ? { description } : {}),
      candidate: hasContent ? { content: variant.content } : { edits: variant.edits },
    });
  }
  return { ok: true, variants };
}

/** A candidate a write would refuse, as the tool error naming its variant. `rel`: the file, workspace-relative. */
export function candidateRefusal(label: string, rel: string, refusal: Extract<ToolResult<unknown>, { ok: false }>): CallToolResult {
  if (refusal.code === 'dirty-buffer') {
    // The write tools' own text offers `force`, which the agent may not pass.
    return toolError({
      code: 'dirty-buffer',
      message: `Not shown: "${rel}" has unsaved changes in the editor, so a picked variant could not be written. Ask the user to save the file, then call propose_variants again.`,
      ...(refusal.details !== undefined ? { details: refusal.details } : {}),
    });
  }
  return toolError({
    code: refusal.code,
    message: `Variant "${label}": ${refusal.message}`,
    details: { ...(refusal.details && typeof refusal.details === 'object' ? refusal.details : {}), variant: label },
  });
}

/** The tile of a variant whose build ended: `ready` with its facts, or `failed` with why. */
export function builtTile(tile: VariantTile, built: ToolResult<TryBuildOutput>): VariantTile {
  const { error: _error, ...base } = tile;
  if (built.ok === false) {
    return { ...base, state: 'failed', error: cut(`It could not be built: ${built.message}`) };
  }
  const outcome = built.data;
  if (outcome.state === 'compile-error') {
    const at = outcome.compileError.sourceLocation;
    return { ...base, state: 'failed', error: cut(`It does not compile: ${firstLine(outcome.compileError.message)}${at ? ` (line ${at.line})` : ''}`) };
  }
  const built_ = { ...base, buildId: outcome.id, sceneKind: outcome.sceneKind, facts: buildFacts(outcome) };
  if (outcome.state === 'build-error') {
    const [first, ...rest] = outcome.objectErrors;
    const more = rest.length > 0 ? `, and ${rest.length} more` : '';
    const where = first?.sourceLocation ? ` (line ${first.sourceLocation.line})` : '';
    return {
      ...built_,
      state: 'failed',
      error: cut(first ? `${first.name} does not build${where}: ${firstLine(first.message)}${more}` : 'A feature does not build.'),
    };
  }
  return { ...built_, state: 'ready' };
}

/** The tiles with the ones whose build has not ended marked `cancelled`. */
export function cancelUnbuilt(tiles: VariantTile[]): VariantTile[] {
  return tiles.map((tile) => (tile.state === 'queued' || tile.state === 'building' ? { ...tile, state: 'cancelled' as const } : tile));
}

/**
 * The page's reply to a card waiting for the user, checked: a pick names a
 * tile that built, the user's own words are of a bounded length.
 */
export function readVariantsReply(tiles: VariantTile[], body: unknown): { ok: true; reply: VariantsReply } | { ok: false; error: string } {
  const record = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (record.skip === true) {
    return { ok: true, reply: { skip: true } };
  }
  if (record.pick !== undefined) {
    const tile = typeof record.pick === 'string' ? tiles.find((t) => t.label === record.pick) : undefined;
    if (!tile) {
      return { ok: false, error: '`pick` must be the label of one of the variants.' };
    }
    if (tile.state !== 'ready') {
      return { ok: false, error: `"${tile.label}" did not build, so it cannot be picked.` };
    }
    return { ok: true, reply: { pick: tile.label } };
  }
  if (record.text !== undefined) {
    const text = typeof record.text === 'string' ? record.text.trim() : '';
    if (text === '') {
      return { ok: false, error: '`text` must be what the user wrote.' };
    }
    if (text.length > MAX_ANSWER_CHARS) {
      return { ok: false, error: `\`text\` is longer than ${MAX_ANSWER_CHARS} characters.` };
    }
    return { ok: true, reply: { text } };
  }
  return { ok: false, error: 'Send `{ "pick": "<label>" }`, `{ "text": "…" }` or `{ "skip": true }`.' };
}

/** What the card becomes when it ends. `rel`: the file, workspace-relative. */
export function variantsPatch(outcome: VariantsOutcome, tiles: VariantTile[], rel: string): Partial<VariantsPart> {
  const variants = cancelUnbuilt(tiles);
  switch (outcome.kind) {
    case 'picked':
      return { state: 'picked', picked: outcome.label, variants };
    case 'answered':
      return { state: 'answered', text: outcome.text, variants };
    case 'skipped':
      return { state: 'skipped', variants };
    case 'none-built':
      return { state: 'failed', reason: `${noneBuilt(tiles.length)}.`, variants };
    case 'stale':
      return { state: 'failed', reason: `${rel} changed after these were built, so "${outcome.label}" was not written.`, variants };
    case 'no-copy':
      return { state: 'failed', reason: `"${outcome.label}" was not written: ${outcome.message}`, variants };
    case 'stopped':
      return { state: 'unanswered', reason: 'Stopped before you chose.', variants };
    case 'shutdown':
      return { state: 'unanswered', reason: 'The app closed before you chose.', variants };
    case 'timeout':
      return { state: 'unanswered', reason: 'Not chosen within an hour.', variants };
    case 'aborted':
      return { state: 'unanswered', reason: 'Cancelled.', variants };
  }
}

/**
 * What `propose_variants` returns to the model for every ending but a pick
 * that was written (the gate adds the write's render to that one).
 * `cancelledMessage`: the gate's text for a call the client gave up on.
 */
export function variantsResult(outcome: Exclude<VariantsOutcome, { kind: 'picked' }>, tiles: VariantTile[], rel: string, cancelledMessage: string): CallToolResult {
  const failed = failedVariants(tiles);
  switch (outcome.kind) {
    case 'answered':
      return json({ answer: outcome.text, note: VARIANTS_ANSWERED_NOTE, ...failed });
    case 'skipped':
      return json({ skipped: true, note: VARIANTS_SKIPPED_NOTE, ...failed });
    case 'none-built':
      return failure(
        [
          `${noneBuilt(tiles.length)}, so the user was not asked and nothing was written:`,
          ...tiles.map((tile) => `- "${tile.label}": ${tile.error ?? 'not built.'}`),
          'Fix the candidates (try_build tells whether one builds) before proposing again.',
        ].join('\n'),
      );
    case 'stale':
      return failure(
        `The user picked "${outcome.label}", but ${rel} changed on disk while they were choosing, so it was not written. `
          + 'Read the file again and make the change they picked with write_file or edit_range.',
      );
    case 'no-copy':
      return failure(`The user picked "${outcome.label}", but it was not written: ${outcome.message}`);
    case 'stopped':
    case 'shutdown':
      return failure(VARIANTS_STOPPED_MESSAGE);
    case 'timeout':
      return failure(VARIANTS_TIMED_OUT_MESSAGE);
    case 'aborted':
      return failure(cancelledMessage);
  }
}

/** That no variant of a card of `count` built, as a clause. */
function noneBuilt(count: number): string {
  return count === 2 ? 'Neither variant built' : 'None of the variants built';
}

/** `{ failed: [{ label, reason }] }` for the variants that did not build, or nothing. */
export function failedVariants(tiles: VariantTile[]): { failed?: { label: string; reason: string }[] } {
  const failed = tiles.filter((tile) => tile.state === 'failed').map((tile) => ({ label: tile.label, reason: tile.error ?? 'It did not build.' }));
  return failed.length > 0 ? { failed } : {};
}

export function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** A tool error in the shape FluidCAD's tools give theirs: `{ code, message, details }` as JSON. */
export function toolError(error: { code: string; message: string; details?: unknown }): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(error) }] };
}

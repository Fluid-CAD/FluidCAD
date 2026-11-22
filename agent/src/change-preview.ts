// What a change does to the model, on its approval card
// (docs/agent-chat-plan.md §25): a `write_file` or `edit_range` on a model
// file that waits for the user is built without being written — the file as
// it is and the file with the change — so the card shows two pictures and
// the difference in bodies, size and volume, or says that the change does
// not build, before the user answers.
//
// A preview is one full build per side the engine does not already keep,
// each holding the engine while it runs. So a side is asked for with
// `reuse` (the after of an approved change is the before of the next one),
// and nothing is built unasked for a file whose last build took longer than
// {@link AUTO_PREVIEW_MAX_BUILD_MS}: the card then offers a button. The
// approval never waits for any of it.

import { buildCandidate, candidateCost, type RegistryEntry, type ToolResult, type TryBuildOutput } from '../../mcp/dist/server.js';
import { buildFacts, buildProblems } from './build-facts.ts';
import type { ChangePreview, ChangePreviewSide } from './types.ts';

/**
 * The longest last build of a file, in ms, after which its preview is no
 * longer built unasked. A first approval builds two sides, so the engine is
 * held for at most about twice this, and once the before is kept for about
 * this: the time it takes to read the diff. Past it the user would meet an
 * editor, a parameter or a pick that waits, for a picture they did not ask
 * for — so they are asked.
 */
export const AUTO_PREVIEW_MAX_BUILD_MS = 2000;

/** How many reasons a side that does not build lists; the rest are counted. */
export const MAX_PREVIEW_PROBLEMS = 5;

/** The model files: what a scratch build builds (`server/src/file-kind.ts`). */
export function isModelFile(absPath: string): boolean {
  return /\.(fluid|part|assembly)\.js$/i.test(absPath);
}

/** What a preview needs from the gate that started it. */
export type ChangePreviewHost = {
  pinnedWorkspace(): RegistryEntry;
  /** The preview as the transcript holds it now: a page may have added a picture since it was last written. */
  read(): ChangePreview | undefined;
  /** Sets the card's preview. */
  write(preview: ChangePreview): void;
  persist(): void;
};

/** The change: the model file, whether it exists, its text now and with the change. */
export type PreviewedEdit = { absPath: string; existed: boolean; before: string; after: string };

type Side = 'before' | 'after';

/**
 * The preview of one change, from the moment its approval is asked to the
 * moment it is settled. {@link start} asks the engine what the two builds
 * would cost and builds them, or offers them; {@link request} builds an
 * offered one; {@link cancel} ends it with the approval.
 *
 * A build that has not started when the approval is settled is not
 * started. One in progress runs to its end — nothing cancels a build — and
 * its result is dropped (the engine keeps it, for the next change).
 */
export class ChangePreviewJob {
  private phase: 'checking' | 'offered' | 'building' | 'ready' | 'cancelled' = 'checking';
  /** What each side draws, as the engine digests it; null for a side with no build. */
  private readonly geometry: Partial<Record<Side, string | null>> = {};

  constructor(
    private readonly host: ChangePreviewHost,
    private readonly edit: PreviewedEdit,
    private readonly autoMaxBuildMs: number = AUTO_PREVIEW_MAX_BUILD_MS,
  ) {}

  /** Finds out what the preview costs, then builds it or offers it. Returns at once; never throws. */
  start(): void {
    void this.check().catch((e) => console.error('[agent] previewing a change failed:', e));
  }

  /** The user asked for an offered preview. False when there is none to build (not offered, building, built, cancelled). */
  request(): boolean {
    if (this.phase !== 'offered') {
      return false;
    }
    void this.build().catch((e) => console.error('[agent] previewing a change failed:', e));
    return true;
  }

  /**
   * The approval was settled. Returns the card's preview when that ended it
   * unfinished, for the caller to write with the approval's own outcome;
   * null when the card shows no preview yet, or a finished one.
   */
  cancel(): ChangePreview | null {
    const unfinished = this.phase === 'offered' || this.phase === 'building';
    if (this.phase !== 'ready') {
      this.phase = 'cancelled';
    }
    const shown = unfinished ? this.host.read() : undefined;
    return shown ? { ...shown, state: 'cancelled' } : null;
  }

  private sides(): Side[] {
    return this.edit.existed ? ['before', 'after'] : ['after'];
  }

  private async check(): Promise<void> {
    const pinnedWorkspace = this.host.pinnedWorkspace();
    const absPath = this.edit.absPath;
    let toBuild = 0;
    let lastBuildMs: number | null = null;
    for (const side of this.sides()) {
      const cost = await candidateCost({ pinnedWorkspace, absPath, text: this.edit[side] });
      if (this.phase !== 'checking') {
        return;
      }
      if (cost.ok === false) {
        // An engine that cannot build a candidate, or refuses this one: the card stays as it is.
        return;
      }
      if (!cost.data.reusable) {
        toBuild += 1;
      }
      lastBuildMs = cost.data.lastBuildMs;
    }
    if (toBuild > 0 && lastBuildMs !== null && lastBuildMs > this.autoMaxBuildMs) {
      this.phase = 'offered';
      this.host.write({ state: 'offered', estimateMs: lastBuildMs, ...(this.edit.existed ? {} : { before: null }) });
      this.host.persist();
      return;
    }
    await this.build();
  }

  private async build(): Promise<void> {
    const pinnedWorkspace = this.host.pinnedWorkspace();
    this.phase = 'building';
    this.host.write({ state: 'building', ...(this.edit.existed ? {} : { before: null }) });
    // Saved before the first build: an engine a build takes down finds the card, and says the preview was not built.
    this.host.persist();
    let last: { text: string; built: ToolResult<TryBuildOutput> } | null = null;
    for (const side of this.sides()) {
      const text = this.edit[side];
      let built: ToolResult<TryBuildOutput>;
      if (last && last.text === text) {
        // A change that leaves the text as it is: one build is both sides.
        built = last.built;
      } else {
        try {
          built = await buildCandidate({ pinnedWorkspace, absPath: this.edit.absPath, text, reuse: true });
        } catch (e) {
          built = { ok: false, code: 'internal', message: e instanceof Error ? e.message : String(e) };
        }
      }
      if (this.phase !== 'building') {
        // Settled while it built: the card already says so.
        return;
      }
      last = { text, built };
      this.geometry[side] = built.ok && built.data.state !== 'compile-error' ? built.data.geometry ?? null : null;
      this.update((preview) => ({ ...preview, [side]: previewSide(built) }));
    }
    this.phase = 'ready';
    const { before, after } = this.geometry;
    this.update((preview) => ({
      ...preview,
      state: 'ready',
      ...(this.edit.existed ? { same: typeof before === 'string' && before === after } : {}),
    }));
    this.host.persist();
  }

  /** Writes the preview from what the transcript holds, so a picture a page added meanwhile stays. */
  private update(change: (preview: ChangePreview) => ChangePreview): void {
    this.host.write(change(this.host.read() ?? { state: 'building' }));
  }
}

/** One side of a preview, from the build of it. */
export function previewSide(built: ToolResult<TryBuildOutput>): ChangePreviewSide {
  const all = buildProblems(built);
  const problems = all.length > 0
    ? { problems: all.slice(0, MAX_PREVIEW_PROBLEMS), ...(all.length > MAX_PREVIEW_PROBLEMS ? { moreProblems: all.length - MAX_PREVIEW_PROBLEMS } : {}) }
    : {};
  if (built.ok === false || built.data.state === 'compile-error') {
    return { state: 'failed', ...problems };
  }
  const outcome = built.data;
  return {
    state: outcome.state === 'rendered' ? 'built' : 'failed',
    buildId: outcome.id,
    sceneKind: outcome.sceneKind,
    facts: buildFacts(outcome),
    ...(outcome.bounds ? { bounds: outcome.bounds } : {}),
    ...problems,
  };
}

/** A preview a restart, a stop or the end of its turn found unfinished: not built. Others are returned as they are. */
export function cancelUnfinishedPreview(preview: ChangePreview | undefined): ChangePreview | undefined {
  return preview && (preview.state === 'offered' || preview.state === 'building') ? { ...preview, state: 'cancelled' } : preview;
}

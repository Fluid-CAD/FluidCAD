// Scene references (docs/agent-chat-plan.md §11): the idle selection attached
// to a chat message as a synthesized selector, never as an address.
//
// A reference is built from `POST api/resolve-selection` with the live picks:
// the selector the synthesizer writes for the whole selection (in the file's
// own variable names), the features it names, the imports it needs, its
// verified alternatives and each entity's geometric summary. Every shape id,
// index, scene-object id and `$obj[…]` form is left behind. The live picks
// stay in the page, next to each unsent reference, only to draw the capture;
// a render invalidates them and drops the unsent references.

import type { SceneReference } from './chat-types';
import { MAX_REFERENCES, referenceColor, type ReferenceColor } from './reference-colors';

/** One face or edge of the idle selection, valid for the render it was picked in. */
export type ReferencePick = { shapeId: string; kind: 'face' | 'edge'; index: number };

/** An entity of the idle selection, as `MeasureController.selection` holds it. */
export type SelectedEntityLike = { shapeId: string; sub: { type: string; index: number }; instanceId?: string };

/** `EntitySummary` (lib/oc/measure/entity-summary.ts): what a reference keeps of each entity. */
export type ReferenceGeometry = {
  form: string;
  center: [number, number, number];
  normal?: [number, number, number];
  axis?: [number, number, number];
  area?: number;
  length?: number;
  diameter?: number;
};

/** The fields of `POST api/resolve-selection`'s 200 answer a reference reads. */
export type ResolveSelectionAnswer = {
  ok: true;
  matches: { kind: 'face' | 'edge' | 'vertex'; summary?: ReferenceGeometry }[];
  count: number;
  unit: string;
  warning?: string;
  synthesized?:
    | {
        ok: true;
        source: string;
        producers: {
          sceneObjectName: string;
          featureType: string;
          variable: string;
          line: number | null;
          bound?: boolean;
        }[];
        imports: string[];
        alternatives: { source: string }[];
      }
    | { ok: false; reason: string };
};

export type ResolveOutcome = { ok: true; answer: ResolveSelectionAnswer } | { ok: false; reason: string };

/** Resolves picks to the synthesizer's answer: `POST api/resolve-selection`, or a fake in tests. */
export type SelectionResolver = (picks: ReferencePick[]) => Promise<ResolveOutcome>;

/** A highlight entry of the capture: a pick in its reference's colour. */
export type CaptureHighlight = ReferencePick & { color: string };

/** What the page lends the composer to attach geometry (main.ts builds it). */
export type ChatSceneHost = {
  /** The idle selection (faces and edges). */
  selection(): readonly SelectedEntityLike[];
  /** Called whenever the idle selection changes; returns the unsubscribe. */
  addSelectionListener(fn: () => void): () => void;
  /** Called on every render, after the selection was cleared; returns the unsubscribe. */
  addRenderListener(fn: () => void): () => void;
  clearSelection(): void;
  /** The timeline is rolled back: the selection is against an earlier state of the model. */
  isRolledBack(): boolean;
  /** The model file on screen, workspace-absolute. */
  currentFile(): string | null;
  /**
   * One PNG of the current view framed to `highlight`, each entry in its
   * colour (§11.2). The idle selection's own highlight is not in it: a
   * selection made since the last Add is not part of the message.
   */
  capture(highlight: CaptureHighlight[]): Promise<Blob>;
  /** Defaults to {@link httpSelectionResolver}. */
  resolve?: SelectionResolver;
};

/** `POST api/resolve-selection` with `{ picks }` (a relative URL: the page is served at `/` and `/p/<id>/`). */
export const httpSelectionResolver: SelectionResolver = async (picks) => {
  try {
    const res = await fetch('api/resolve-selection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ picks: picks.map((p) => ({ shapeId: p.shapeId, kind: p.kind, index: p.index })) }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.ok !== true) {
      return { ok: false, reason: typeof body?.error === 'string' ? body.error : `The selection could not be resolved (HTTP ${res.status}).` };
    }
    return { ok: true, answer: body as ResolveSelectionAnswer };
  } catch (err) {
    return { ok: false, reason: `The selection could not be resolved: ${err instanceof Error ? err.message : String(err)}` };
  }
};

export type ReferenceBuild = { ok: true; reference: SceneReference } | { ok: false; reason: string };

/**
 * The reference for one resolve-selection answer (§11.1). Keeps
 * `synthesized.source`, the producers (without their scene-object ids), the
 * imports, the alternatives' source forms and each match's summary; drops
 * `expression` (the `$obj` form) and every id and index. A refused or absent
 * synthesis is a refusal with the synthesizer's reason: there is no fallback
 * to ids.
 */
export function buildSceneReference(
  answer: ResolveSelectionAnswer,
  slot: { n: number; color: ReferenceColor; file: string },
): ReferenceBuild {
  const synthesized = answer.synthesized;
  if (answer.count === 0 || answer.matches.length === 0) {
    return { ok: false, reason: 'The selection resolved to nothing in the current model.' };
  }
  if (!synthesized) {
    return { ok: false, reason: answer.warning ?? 'No selector could be written for this selection.' };
  }
  if (synthesized.ok === false) {
    return { ok: false, reason: synthesized.reason };
  }
  const faces = answer.matches.filter((m) => m.kind === 'face').length;
  const edges = answer.matches.filter((m) => m.kind === 'edge').length;
  const kind: SceneReference['kind'] = faces > 0 && edges === 0 ? 'face' : edges > 0 && faces === 0 ? 'edge' : 'mixed';
  return {
    ok: true,
    reference: {
      n: slot.n,
      color: { name: slot.color.name, hex: slot.color.hex },
      kind,
      count: answer.matches.length,
      file: slot.file,
      selector: {
        source: synthesized.source,
        producers: synthesized.producers.map((p) => ({
          variable: p.variable,
          feature: p.sceneObjectName,
          featureType: p.featureType,
          line: typeof p.line === 'number' ? p.line : null,
          bound: p.bound === true,
        })),
        imports: [...synthesized.imports],
        alternatives: synthesized.alternatives.map((a) => a.source).filter((s) => typeof s === 'string' && s !== ''),
      },
      geometry: answer.matches.flatMap((m) => (m.summary ? [copyGeometry(m.summary)] : [])),
      unit: answer.unit,
    },
  };
}

/** Only the summary's own fields, so nothing else a match carries rides along. */
function copyGeometry(summary: ReferenceGeometry): ReferenceGeometry {
  const out: ReferenceGeometry = { form: summary.form, center: summary.center };
  for (const key of ['normal', 'axis', 'area', 'length', 'diameter'] as const) {
    if (summary[key] !== undefined) {
      (out as Record<string, unknown>)[key] = summary[key];
    }
  }
  return out;
}

/** "1 face", "4 edges", "3 faces and edges". */
export function referenceLabel(kind: SceneReference['kind'], count: number): string {
  if (kind === 'mixed') {
    return `${count} faces and edges`;
  }
  return `${count} ${kind}${count === 1 ? '' : 's'}`;
}

/** "4 edges selected", "1 face and 2 edges selected". */
export function selectionLabel(selection: readonly SelectedEntityLike[]): string {
  const faces = selection.filter((e) => e.sub.type === 'face').length;
  const edges = selection.filter((e) => e.sub.type === 'edge').length;
  const parts = [
    ...(faces > 0 ? [`${faces} face${faces === 1 ? '' : 's'}`] : []),
    ...(edges > 0 ? [`${edges} edge${edges === 1 ? '' : 's'}`] : []),
  ];
  return `${parts.join(' and ')} selected`;
}

/** The token a reference is written as in the message. */
export function referenceToken(n: number): string {
  return `[${n}]`;
}

/** A reference waiting in the composer, with the live picks it was made from (page state only). */
export type PendingReference = { reference: SceneReference; picks: ReferencePick[] };

/** Where the references put their tokens: the composer's textarea. */
export type ReferenceTokenTarget = {
  insertToken(token: string): void;
  removeToken(token: string): void;
};

/** The selection row's state. */
type RowState =
  | { kind: 'none' }
  | { kind: 'busy' }
  /** The synthesizer (or the route) refused the current selection. */
  | { kind: 'refused'; reason: string };

export const MODEL_CHANGED_NOTICE = 'The model changed — select again.';
export const ROLLED_BACK_HINT = 'Roll the timeline forward to the last feature to attach geometry.';
export const FULL_HINT = `At most ${MAX_REFERENCES} references per message.`;
const INSTANCE_REASON = 'Faces and edges of an inserted part cannot be attached yet: open the part file and select them there.';

/**
 * The composer's scene references (§11.1): the add-selection row
 * ("4 edges selected — Add"), the refusal with "Add one at a time", the
 * chips, and the `[n]` tokens they put in the message. One Add is one
 * reference for the whole selection. Reference `n` takes colour `n` of the
 * palette, the lowest free, so removing a chip frees its number and colour.
 * Add clears the idle selection. While the timeline is rolled back, Add is
 * off with a hint. A render drops the unsent references and their tokens
 * with "The model changed — select again.".
 */
export class SceneReferences {
  readonly el: HTMLDivElement;
  private readonly chips: HTMLDivElement;
  private readonly row: HTMLDivElement;
  private readonly noticeEl: HTMLDivElement;
  private readonly pending: PendingReference[] = [];
  private rowState: RowState = { kind: 'none' };
  private notice: string | null = null;
  /** Bumped by every render: an answer for picks of an older render is dropped. */
  private generation = 0;
  private readonly resolve: SelectionResolver;
  private readonly unsubscribes: (() => void)[] = [];

  constructor(
    private readonly host: ChatSceneHost,
    private readonly tokens: ReferenceTokenTarget,
    /** Called when the references change (the composer repaints its Send button). */
    private readonly onChange: () => void = () => {},
  ) {
    this.resolve = host.resolve ?? httpSelectionResolver;
    this.el = document.createElement('div');
    this.el.className = 'chat-attach';
    this.el.dataset.ref = 'scene-references';
    this.chips = document.createElement('div');
    this.chips.className = 'chat-attach-chips';
    this.chips.dataset.ref = 'reference-chips';
    this.row = document.createElement('div');
    this.row.className = 'chat-attach-row';
    this.row.dataset.ref = 'selection-row';
    this.noticeEl = document.createElement('div');
    this.noticeEl.className = 'chat-attach-notice';
    this.noticeEl.dataset.ref = 'reference-notice';
    this.el.append(this.chips, this.row, this.noticeEl);

    this.unsubscribes.push(
      host.addSelectionListener(() => this.onSelectionChanged()),
      host.addRenderListener(() => this.onRender()),
    );
    this.paint();
  }

  /** The unsent references, in number order. */
  get references(): SceneReference[] {
    return this.sorted().map((p) => p.reference);
  }

  get size(): number {
    return this.pending.length;
  }

  /** Whether anything shows (chips, the row or a notice). */
  get visible(): boolean {
    return !this.el.classList.contains('hidden');
  }

  /**
   * What a send carries: the references and the capture's highlight, every
   * pick in its reference's colour. Null without references.
   */
  forSend(): { references: SceneReference[]; highlight: CaptureHighlight[]; generation: number } | null {
    if (this.pending.length === 0) {
      return null;
    }
    const sorted = this.sorted();
    return {
      references: sorted.map((p) => p.reference),
      highlight: sorted.flatMap((p) => p.picks.map((pick) => ({ ...pick, color: p.reference.color.hex }))),
      generation: this.generation,
    };
  }

  /** Whether the picks of a {@link forSend} are still those of the model on screen. */
  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  /** The message went: the chips go with it (its tokens left with the text). */
  clearSent(): void {
    this.pending.length = 0;
    this.notice = null;
    this.paint();
  }

  /** Remove reference `n`: its chip, its token, its colour. */
  remove(n: number): void {
    const i = this.pending.findIndex((p) => p.reference.n === n);
    if (i < 0) {
      return;
    }
    this.pending.splice(i, 1);
    this.tokens.removeToken(referenceToken(n));
    this.paint();
  }

  /** Attach the whole idle selection as one reference (the row's Add). */
  async add(): Promise<boolean> {
    const selection = this.addable();
    if (!selection) {
      return false;
    }
    const picks = selection.map(toPick);
    this.rowState = { kind: 'busy' };
    this.notice = null;
    this.paint();
    const generation = this.generation;
    const outcome = await this.resolve(picks);
    if (generation !== this.generation) {
      return false;
    }
    const built = this.buildFrom(outcome);
    if (built.ok === false) {
      this.rowState = { kind: 'refused', reason: built.reason };
      this.paint();
      return false;
    }
    this.rowState = { kind: 'none' };
    this.attach(built.reference, picks);
    this.host.clearSelection();
    this.paint();
    return true;
  }

  /**
   * "Add one at a time": each entity of the selection resolved on its own;
   * those that synthesize are attached, one reference each, the others named
   * in a notice.
   */
  async addOneAtATime(): Promise<number> {
    const selection = this.addable();
    if (!selection) {
      return 0;
    }
    this.rowState = { kind: 'busy' };
    this.notice = null;
    this.paint();
    const generation = this.generation;
    let attached = 0;
    const reasons: string[] = [];
    for (const entity of selection) {
      if (this.pending.length >= MAX_REFERENCES) {
        reasons.push(FULL_HINT);
        break;
      }
      const pick = toPick(entity);
      const outcome = await this.resolve([pick]);
      if (generation !== this.generation) {
        return attached;
      }
      const built = this.buildFrom(outcome);
      if (built.ok === false) {
        reasons.push(built.reason);
        continue;
      }
      this.attach(built.reference, [pick]);
      attached++;
    }
    const failed = selection.length - attached;
    this.rowState = { kind: 'none' };
    if (attached > 0) {
      this.host.clearSelection();
    } else {
      this.rowState = { kind: 'refused', reason: reasons[0] ?? 'Nothing could be attached.' };
    }
    if (attached > 0 && failed > 0) {
      this.notice = `${failed} of ${selection.length} could not be attached: ${reasons[0]}`;
    }
    this.paint();
    return attached;
  }

  destroy(): void {
    for (const unsubscribe of this.unsubscribes) {
      unsubscribe();
    }
    this.el.remove();
  }

  // ---------------------------------------------------------------------------

  /** The selection Add would take, or null when Add is off. */
  private addable(): readonly SelectedEntityLike[] | null {
    const selection = this.host.selection().filter((e) => e.sub.type === 'face' || e.sub.type === 'edge');
    if (selection.length === 0 || this.rowState.kind === 'busy' || this.pending.length >= MAX_REFERENCES || this.host.isRolledBack()) {
      return null;
    }
    if (selection.some((e) => e.instanceId)) {
      this.rowState = { kind: 'refused', reason: INSTANCE_REASON };
      this.paint();
      return null;
    }
    return selection;
  }

  private buildFrom(outcome: ResolveOutcome): ReferenceBuild {
    return 'answer' in outcome ? this.build(outcome.answer) : { ok: false, reason: outcome.reason };
  }

  private build(answer: ResolveSelectionAnswer): ReferenceBuild {
    const n = this.nextNumber();
    return buildSceneReference(answer, { n, color: referenceColor(n), file: this.host.currentFile() ?? '' });
  }

  private attach(reference: SceneReference, picks: ReferencePick[]): void {
    this.pending.push({ reference, picks });
    this.tokens.insertToken(referenceToken(reference.n));
  }

  /** The lowest number (and colour) no unsent reference holds. */
  private nextNumber(): number {
    const used = new Set(this.pending.map((p) => p.reference.n));
    let n = 1;
    while (used.has(n)) {
      n++;
    }
    return n;
  }

  private sorted(): PendingReference[] {
    return [...this.pending].sort((a, b) => a.reference.n - b.reference.n);
  }

  private onSelectionChanged(): void {
    // A refusal belongs to the selection it was for.
    if (this.rowState.kind === 'refused') {
      this.rowState = { kind: 'none' };
    }
    if (this.host.selection().length > 0) {
      this.notice = null;
    }
    this.paint();
  }

  private onRender(): void {
    this.generation++;
    this.rowState = { kind: 'none' };
    if (this.pending.length > 0) {
      for (const p of this.pending) {
        this.tokens.removeToken(referenceToken(p.reference.n));
      }
      this.pending.length = 0;
      this.notice = MODEL_CHANGED_NOTICE;
    }
    this.paint();
  }

  private paint(): void {
    this.paintChips();
    this.paintRow();
    this.noticeEl.textContent = this.notice ?? '';
    this.noticeEl.classList.toggle('hidden', this.notice === null);
    const empty = this.pending.length === 0 && this.row.classList.contains('hidden') && this.notice === null;
    this.el.classList.toggle('hidden', empty);
    this.onChange();
  }

  private paintChips(): void {
    this.chips.replaceChildren();
    for (const { reference } of this.sorted()) {
      const chip = document.createElement('span');
      chip.className = 'chat-reference-chip';
      chip.dataset.n = String(reference.n);
      chip.dataset.color = reference.color.name;
      chip.title = reference.selector.source;
      const dot = document.createElement('span');
      dot.className = 'chat-reference-dot';
      dot.style.backgroundColor = reference.color.hex;
      const label = document.createElement('span');
      label.className = 'truncate';
      label.textContent = `${referenceToken(reference.n)} ${referenceLabel(reference.kind, reference.count)}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'chat-reference-remove';
      remove.dataset.ref = 'remove-reference';
      remove.setAttribute('aria-label', `Remove reference ${reference.n}`);
      remove.title = 'Remove';
      remove.textContent = '×';
      remove.addEventListener('click', () => this.remove(reference.n));
      chip.append(dot, label, remove);
      this.chips.append(chip);
    }
    this.chips.classList.toggle('hidden', this.pending.length === 0);
  }

  private paintRow(): void {
    const selection = this.host.selection().filter((e) => e.sub.type === 'face' || e.sub.type === 'edge');
    this.row.replaceChildren();
    const state = this.rowState;
    if (selection.length === 0 && state.kind !== 'busy') {
      this.row.classList.add('hidden');
      delete this.row.dataset.state;
      return;
    }
    this.row.classList.remove('hidden');
    const label = document.createElement('span');
    label.className = 'chat-attach-label';
    label.dataset.ref = 'selection-label';
    label.textContent = selection.length > 0 ? selectionLabel(selection) : 'Attaching…';
    this.row.append(label);

    if (state.kind === 'refused') {
      this.row.dataset.state = 'refused';
      const reason = document.createElement('span');
      reason.className = 'chat-attach-reason';
      reason.dataset.ref = 'refusal';
      reason.textContent = state.reason;
      this.row.append(reason);
      if (selection.length > 1 && !this.host.isRolledBack() && !selection.some((e) => e.instanceId)) {
        this.row.append(this.button('Add one at a time', 'add-one-at-a-time', () => void this.addOneAtATime()));
      }
      return;
    }

    const add = this.button('Add', 'add-selection', () => void this.add());
    const hint = this.host.isRolledBack() ? ROLLED_BACK_HINT : this.pending.length >= MAX_REFERENCES ? FULL_HINT : null;
    if (state.kind === 'busy') {
      this.row.dataset.state = 'busy';
      add.disabled = true;
      add.prepend(spinner());
    } else if (hint) {
      this.row.dataset.state = 'disabled';
      add.disabled = true;
      add.title = hint;
    } else {
      this.row.dataset.state = 'ready';
      add.title = 'Attach the selection to the message';
    }
    this.row.append(add);
    if (hint && state.kind !== 'busy') {
      const hintEl = document.createElement('span');
      hintEl.className = 'chat-attach-hint';
      hintEl.dataset.ref = 'selection-hint';
      hintEl.textContent = hint;
      this.row.append(hintEl);
    }
  }

  private button(text: string, ref: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-xs btn-soft btn-primary chat-attach-button';
    button.dataset.ref = ref;
    button.textContent = text;
    button.addEventListener('click', onClick);
    return button;
  }
}

function toPick(entity: SelectedEntityLike): ReferencePick {
  return { shapeId: entity.shapeId, kind: entity.sub.type as 'face' | 'edge', index: entity.sub.index };
}

function spinner(): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = 'loading loading-spinner loading-xs';
  return el;
}

/** A PNG blob as base64, for `SendMessage.image`. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

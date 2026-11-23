// Scene references (docs/agent-chat-plan.md §11): the idle selection attached
// to a chat message as a synthesized selector, never as an address.
//
// A reference is built from `POST api/resolve-selection` with the live picks:
// the selector the synthesizer writes for the whole selection (in the file's
// own variable names), the features it names, the imports it needs, its
// verified alternatives and each entity's geometric summary. Every shape id,
// index, scene-object id and `$obj[…]` form is left behind. The selection
// attaches by itself while the panel is open (a live chip that follows it);
// the live picks stay in the page, next to each unsent reference, only to
// draw the capture; a render invalidates them and drops the unsent
// references.

import { ChatIcons } from './chat-icons';
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
   * colour (§11.2). The idle selection's own (amber) highlight is not in
   * it: when the selection goes with the message it is in `highlight`, in
   * its reference's colour; when it does not, it is not part of the message.
   */
  capture(highlight: CaptureHighlight[]): Promise<Blob>;
  /**
   * One PNG of the viewport as it is on screen now: the same view and
   * proportions, the grid, the axes and the selection as shown, nothing
   * framed or hidden (§28). The composer's Capture button opens it to draw
   * on. Absent: no Capture button.
   */
  captureViewport?(): Promise<Blob>;
  /** Defaults to {@link httpSelectionResolver}. */
  resolve?: SelectionResolver;
  /**
   * Why no face or edge of the model on screen can be attached (an assembly,
   * no model): what a question answered by picking says in place of its
   * pick control (§27). Null, or absent, when the model can be picked from.
   */
  unpickable?(): string | null;
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

/** The token a reference is written as in the message. */
export function referenceToken(n: number): string {
  return `[${n}]`;
}

/** A reference waiting in the composer, with the live picks it was made from (page state only). */
export type PendingReference = { reference: SceneReference; picks: ReferencePick[] };

/** Where a chip puts its `[n]` when its label is clicked: the composer's textarea. */
export type ReferenceTokenTarget = {
  insertToken(token: string): void;
  focus(): void;
};

/**
 * The live chip: the idle selection as it stands, following it.
 * - `pending`: waiting for the debounce or the synthesizer; already numbered.
 * - `ready`: synthesized, goes with the next message.
 * - `refused`: the synthesizer (or the route, or the page for an inserted
 *   instance) said no; not sent. `busy` while "One at a time" runs.
 * - `hint`: not attachable right now (rolled back, eight references); not sent.
 */
type LiveReference =
  | { kind: 'pending'; n: number; picks: ReferencePick[]; label: string }
  | { kind: 'ready'; reference: SceneReference; picks: ReferencePick[] }
  | { kind: 'refused'; picks: ReferencePick[]; label: string; reason: string; oneAtATime: boolean; busy: boolean }
  | { kind: 'hint'; label: string; hint: string };

/** How a {@link SceneReferences} differs from the composer's: the picks of one question of the agent (§27). */
export type SceneReferencesOptions = {
  /**
   * Why this selection cannot be taken (a question that takes one face was
   * given two, or an edge); null when it can. Shown on the live chip, which
   * is then not attached.
   */
  accept?(picks: readonly ReferencePick[]): string | null;
  /**
   * One reference at most: there is no pin, and a selection that
   * synthesizes replaces the reference kept before it (and takes its number).
   */
  single?: boolean;
  /**
   * Numbers (and so colours) taken elsewhere: by the other questions of the
   * same card, so no two chips of a card share one.
   */
  reserved?(): readonly number[];
  /** Told after every change of what shows. */
  onChange?(): void;
};

export const MODEL_CHANGED_NOTICE = 'The model changed — select again.';
export const ROLLED_BACK_HINT = 'Roll the timeline forward to the last feature to attach geometry.';
export const FULL_HINT = `At most ${MAX_REFERENCES} references per message.`;
const INSTANCE_REASON = 'Faces and edges of an inserted part cannot be attached yet: open the part file and select them there.';
/** How long the selection must hold still before it is resolved. */
export const RESOLVE_DEBOUNCE_MS = 150;

/**
 * The composer's scene references (§11.1). While the panel is open
 * ({@link setActive}), the idle selection shows as a live chip: one
 * reference for the whole selection, resolved a moment after it stops
 * changing, gone when it is cleared. Its pin keeps it (it becomes a chip of
 * its own and the selection clears, so the next selection is the next
 * reference); its × clears the selection. A refused selection shows why, and
 * a selection of several entities offers "One at a time". Each reference
 * takes the lowest free number and its colour, and keeps it: removing a chip
 * frees them without renumbering the others. Clicking a chip's label puts its
 * `[n]` in the message; nothing is typed for the user otherwise. A render
 * drops the kept references with "The model changed — select again.".
 *
 * A question the agent asks to be answered by picking (§27) holds one of
 * these too, with {@link SceneReferencesOptions}: the same selection, the
 * same synthesis and the same chips, on the question's card.
 */
export class SceneReferences {
  readonly el: HTMLDivElement;
  private readonly chips: HTMLDivElement;
  private readonly noticeEl: HTMLDivElement;
  /** The kept references. */
  private readonly kept: PendingReference[] = [];
  private live: LiveReference | null = null;
  private active = false;
  private notice: string | null = null;
  /** Bumped by every render: an answer for picks of an older render is dropped. */
  private generation = 0;
  /** Bumped by every change of the selection: an answer for an older selection is dropped. */
  private selectionSeq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The resolve (or "One at a time") under way. */
  private inflight: Promise<void> | null = null;
  private readonly resolve: SelectionResolver;
  private readonly unsubscribes: (() => void)[] = [];

  constructor(
    private readonly host: ChatSceneHost,
    private readonly tokens: ReferenceTokenTarget,
    private readonly options: SceneReferencesOptions = {},
  ) {
    this.resolve = host.resolve ?? httpSelectionResolver;
    this.el = document.createElement('div');
    this.el.className = 'chat-attach';
    this.el.dataset.ref = 'scene-references';
    this.chips = document.createElement('div');
    this.chips.className = 'chat-attach-chips';
    this.chips.dataset.ref = 'reference-chips';
    this.noticeEl = document.createElement('div');
    this.noticeEl.className = 'chat-attach-notice';
    this.noticeEl.dataset.ref = 'reference-notice';
    this.el.append(this.chips, this.noticeEl);

    this.unsubscribes.push(
      host.addSelectionListener(() => this.onSelectionChanged()),
      host.addRenderListener(() => this.onRender()),
    );
    this.paint();
  }

  /**
   * The selection attaches only while this is on: the panel is open and its
   * composer usable. Off, there is no live chip; the kept ones stay.
   */
  setActive(active: boolean): void {
    if (this.active !== active) {
      this.active = active;
      this.follow();
    }
  }

  /** What the next message carries: the kept references and the live one if it synthesized, in number order. */
  get references(): SceneReference[] {
    return this.attached().map((p) => p.reference);
  }

  get size(): number {
    return this.attached().length;
  }

  /** Whether anything shows (chips or a notice). */
  get visible(): boolean {
    return !this.el.classList.contains('hidden');
  }

  /**
   * Resolves once the live chip says what it stands for: a debounce waiting
   * is cut short and a resolve under way is awaited, so a message carries
   * what is on screen.
   */
  async settle(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      if (this.timer !== null) {
        this.resolveLive();
      }
      const inflight = this.inflight;
      if (!inflight) {
        return;
      }
      await inflight;
    }
  }

  /**
   * What a send carries: the references and the capture's highlight, every
   * pick in its reference's colour. Null without references.
   */
  forSend(): { references: SceneReference[]; highlight: CaptureHighlight[]; generation: number } | null {
    const attached = this.attached();
    if (attached.length === 0) {
      return null;
    }
    return {
      references: attached.map((p) => p.reference),
      highlight: attached.flatMap((p) => p.picks.map((pick) => ({ ...pick, color: p.reference.color.hex }))),
      generation: this.generation,
    };
  }

  /** Whether the picks of a {@link forSend} are still those of the model on screen. */
  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  /** The message went with its references: the chips go, and so does the selection the live one stood for. */
  clearSent(): void {
    this.kept.length = 0;
    this.live = null;
    this.notice = null;
    this.host.clearSelection();
    this.follow();
  }

  /** Remove kept reference `n`: its chip and its colour. The text is left as typed, the other numbers as they are. */
  remove(n: number): void {
    const i = this.kept.findIndex((p) => p.reference.n === n);
    if (i < 0) {
      return;
    }
    this.kept.splice(i, 1);
    if (this.live?.kind === 'hint') {
      // There may be room for it now.
      this.follow();
    } else {
      this.paint();
    }
  }

  /** The live chip's pin: keep it as a reference of its own and clear the selection for the next one. */
  keep(): boolean {
    const live = this.live;
    if (live?.kind !== 'ready') {
      return false;
    }
    this.kept.push({ reference: live.reference, picks: live.picks });
    this.live = null;
    this.notice = null;
    this.host.clearSelection();
    this.paint();
    return true;
  }

  /** The live chip's ×: the selection clears, and the chip with it. */
  dismissLive(): void {
    this.host.clearSelection();
  }

  /**
   * "One at a time" on a refused selection of several entities: each one
   * resolved on its own; those that synthesize are kept, one reference each,
   * the others counted in a notice. The selection clears if any was kept.
   */
  async oneAtATime(): Promise<number> {
    const live = this.live;
    if (live?.kind !== 'refused' || !live.oneAtATime || live.busy) {
      return 0;
    }
    this.live = { ...live, busy: true };
    this.notice = null;
    this.paint();
    const seq = this.selectionSeq;
    const generation = this.generation;
    const stale = () => seq !== this.selectionSeq || generation !== this.generation;
    let kept = 0;
    const run = (async () => {
      const reasons: string[] = [];
      for (const pick of live.picks) {
        if (this.kept.length >= MAX_REFERENCES) {
          reasons.push(FULL_HINT);
          break;
        }
        const built = this.build(await this.resolveSafely([pick]), this.nextNumber());
        if (stale()) {
          return;
        }
        if (built.ok === false) {
          reasons.push(built.reason);
          continue;
        }
        this.kept.push({ reference: built.reference, picks: [pick] });
        kept++;
      }
      const failed = live.picks.length - kept;
      if (kept === 0) {
        this.live = { ...live, reason: reasons[0] ?? 'Nothing could be attached.', busy: false };
        this.paint();
        return;
      }
      if (failed > 0) {
        this.notice = `${failed} of ${live.picks.length} could not be attached: ${reasons[0]}`;
      }
      this.live = null;
      this.host.clearSelection();
      this.paint();
    })();
    await this.track(run);
    return kept;
  }

  destroy(): void {
    this.cancelTimer();
    for (const unsubscribe of this.unsubscribes) {
      unsubscribe();
    }
    this.el.remove();
  }

  // ---------------------------------------------------------------------------

  private onSelectionChanged(): void {
    if (this.host.selection().length > 0) {
      this.notice = null;
    }
    this.follow();
  }

  private onRender(): void {
    this.generation++;
    if (this.kept.length > 0) {
      this.kept.length = 0;
      this.notice = MODEL_CHANGED_NOTICE;
    }
    this.follow();
  }

  /** The live chip for the selection as it stands now (a resolve is scheduled, not run). */
  private follow(): void {
    this.selectionSeq++;
    this.cancelTimer();
    const selection = this.active ? this.host.selection().filter((e) => e.sub.type === 'face' || e.sub.type === 'edge') : [];
    if (selection.length === 0) {
      this.live = null;
    } else {
      const picks = selection.map(toPick);
      const label = picksLabel(picks);
      if (selection.some((e) => e.instanceId)) {
        this.live = { kind: 'refused', picks, label, reason: INSTANCE_REASON, oneAtATime: false, busy: false };
      } else if (this.host.isRolledBack()) {
        this.live = { kind: 'hint', label, hint: ROLLED_BACK_HINT };
      } else if (this.options.accept?.(picks)) {
        this.live = { kind: 'hint', label, hint: this.options.accept(picks)! };
      } else if (this.nextNumber() > MAX_REFERENCES) {
        this.live = { kind: 'hint', label, hint: FULL_HINT };
      } else {
        this.live = { kind: 'pending', n: this.nextNumber(), picks, label };
        this.timer = setTimeout(() => this.resolveLive(), RESOLVE_DEBOUNCE_MS);
      }
    }
    this.paint();
  }

  private resolveLive(): void {
    this.cancelTimer();
    const live = this.live;
    if (live?.kind !== 'pending') {
      return;
    }
    const seq = this.selectionSeq;
    const generation = this.generation;
    void this.track((async () => {
      const outcome = await this.resolveSafely(live.picks);
      if (seq !== this.selectionSeq || generation !== this.generation) {
        return;
      }
      const built = this.build(outcome, live.n);
      this.live = built.ok === true
        ? { kind: 'ready', reference: built.reference, picks: live.picks }
        : { kind: 'refused', picks: live.picks, label: live.label, reason: built.reason, oneAtATime: live.picks.length > 1 && !this.options.single, busy: false };
      if (built.ok === true && this.options.single) {
        // The one reference there is: this selection takes the place of the one kept.
        this.kept.length = 0;
      }
      this.paint();
    })());
  }

  /** Remember `run` as the work under way, until it ends. */
  private async track(run: Promise<void>): Promise<void> {
    this.inflight = run;
    try {
      await run;
    } finally {
      if (this.inflight === run) {
        this.inflight = null;
      }
    }
  }

  private async resolveSafely(picks: ReferencePick[]): Promise<ResolveOutcome> {
    try {
      return await this.resolve(picks);
    } catch (err) {
      return { ok: false, reason: `The selection could not be resolved: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private build(outcome: ResolveOutcome, n: number): ReferenceBuild {
    if (outcome.ok === false) {
      return { ok: false, reason: outcome.reason };
    }
    return buildSceneReference(outcome.answer, { n, color: referenceColor(n), file: this.host.currentFile() ?? '' });
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** The lowest number (and colour) no kept reference holds. */
  private nextNumber(): number {
    // The one reference of a `single` takes the place of the one kept, number included.
    const used = new Set([...(this.options.single ? [] : this.kept.map((p) => p.reference.n)), ...(this.options.reserved?.() ?? [])]);
    let n = 1;
    while (used.has(n)) {
      n++;
    }
    return n;
  }

  /** The kept references and the live one if it synthesized, in number order. */
  private attached(): PendingReference[] {
    const all = [...this.kept];
    if (this.live?.kind === 'ready') {
      all.push({ reference: this.live.reference, picks: this.live.picks });
    }
    return all.sort((a, b) => a.reference.n - b.reference.n);
  }

  private paint(): void {
    const chips: { order: number; el: HTMLElement }[] = this.kept.map((p) => ({ order: p.reference.n, el: this.keptChip(p.reference) }));
    if (this.live) {
      const live = this.live;
      const order = live.kind === 'ready' ? live.reference.n : live.kind === 'pending' ? live.n : Number.MAX_SAFE_INTEGER;
      chips.push({ order, el: this.liveChip(live) });
    }
    chips.sort((a, b) => a.order - b.order);
    this.chips.replaceChildren(...chips.map((c) => c.el));
    this.chips.classList.toggle('hidden', chips.length === 0);
    this.noticeEl.textContent = this.notice ?? '';
    this.noticeEl.classList.toggle('hidden', this.notice === null);
    this.el.classList.toggle('hidden', chips.length === 0 && this.notice === null);
    this.options.onChange?.();
  }

  private keptChip(reference: SceneReference): HTMLElement {
    const chip = this.chip(reference.color.hex, 'kept');
    chip.dataset.n = String(reference.n);
    chip.dataset.color = reference.color.name;
    chip.append(
      this.tokenLabel(reference.n, `${referenceToken(reference.n)} ${referenceLabel(reference.kind, reference.count)}`, reference.selector.source),
      this.iconButton('×', 'remove-reference', 'Remove', `Remove reference ${reference.n}`, () => this.remove(reference.n)),
    );
    return chip;
  }

  private liveChip(live: LiveReference): HTMLElement {
    const color = live.kind === 'ready' ? live.reference.color : live.kind === 'pending' ? referenceColor(live.n) : null;
    const chip = this.chip(color?.hex ?? null, live.kind);
    chip.classList.add('chat-reference-live');
    chip.dataset.ref = 'live-reference';
    if (color) {
      chip.dataset.color = color.name;
    }
    const dismiss = this.iconButton('×', 'dismiss-live', 'Clear the selection', 'Clear the selection', () => this.dismissLive());
    switch (live.kind) {
      case 'pending':
      case 'ready': {
        const n = live.kind === 'ready' ? live.reference.n : live.n;
        chip.dataset.n = String(n);
        const text = live.kind === 'ready'
          ? `${referenceToken(n)} ${referenceLabel(live.reference.kind, live.reference.count)}`
          : `${referenceToken(n)} ${live.label}`;
        const keep = this.iconButton(ChatIcons.PIN, 'keep-reference', 'Keep this and select more', `Keep reference ${n} and select more`, () => this.keep());
        keep.classList.add('chat-reference-keep');
        keep.disabled = live.kind === 'pending';
        if (live.kind === 'pending') {
          chip.setAttribute('aria-busy', 'true');
        }
        chip.append(this.tokenLabel(n, text, live.kind === 'ready' ? live.reference.selector.source : null), ...(this.options.single ? [] : [keep]), dismiss);
        break;
      }
      case 'refused': {
        const reason = this.reason(live.reason, 'refusal');
        chip.append(this.plainLabel(live.label), reason);
        if (live.oneAtATime) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'chat-reference-action';
          button.dataset.ref = 'one-at-a-time';
          button.textContent = 'One at a time';
          button.title = 'Attach each face or edge that can be described as a reference of its own';
          button.disabled = live.busy;
          button.addEventListener('click', () => void this.oneAtATime());
          chip.append(button);
        }
        chip.append(dismiss);
        break;
      }
      case 'hint':
        chip.append(this.plainLabel(live.label), this.reason(live.hint, 'live-hint'), dismiss);
        break;
    }
    return chip;
  }

  private chip(hex: string | null, state: string): HTMLSpanElement {
    const chip = document.createElement('span');
    chip.className = 'chat-reference-chip';
    chip.dataset.state = state;
    const dot = document.createElement('span');
    dot.className = 'chat-reference-dot';
    if (hex) {
      dot.style.backgroundColor = hex;
      chip.style.setProperty('--chat-reference-color', hex);
    }
    chip.append(dot);
    return chip;
  }

  /** The chip's "[n] 4 edges": clicking it puts `[n]` in the message, where the caret was. */
  private tokenLabel(n: number, text: string, selector: string | null): HTMLButtonElement {
    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'chat-reference-label truncate';
    label.dataset.ref = 'reference-label';
    label.textContent = text;
    const hint = `Click to put ${referenceToken(n)} in the message`;
    label.title = selector ? `${selector}\n${hint}` : hint;
    label.addEventListener('click', () => {
      this.tokens.insertToken(referenceToken(n));
      this.tokens.focus();
    });
    return label;
  }

  private plainLabel(text: string): HTMLSpanElement {
    const label = document.createElement('span');
    label.className = 'chat-reference-label';
    label.textContent = text;
    return label;
  }

  private reason(text: string, ref: string): HTMLSpanElement {
    const el = document.createElement('span');
    el.className = 'chat-reference-reason truncate';
    el.dataset.ref = ref;
    el.textContent = text;
    el.title = text;
    return el;
  }

  private iconButton(content: string, ref: string, title: string, label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chat-reference-remove';
    button.dataset.ref = ref;
    button.title = title;
    button.setAttribute('aria-label', label);
    if (content.startsWith('<svg')) {
      button.innerHTML = content;
    } else {
      button.textContent = content;
    }
    button.addEventListener('click', onClick);
    return button;
  }
}

function toPick(entity: SelectedEntityLike): ReferencePick {
  return { shapeId: entity.shapeId, kind: entity.sub.type as 'face' | 'edge', index: entity.sub.index };
}

/** "4 edges", "1 face", "3 faces and edges": what the picks are, before the synthesizer answers. */
function picksLabel(picks: readonly ReferencePick[]): string {
  const faces = picks.filter((p) => p.kind === 'face').length;
  const kind: SceneReference['kind'] = faces === picks.length ? 'face' : faces === 0 ? 'edge' : 'mixed';
  return referenceLabel(kind, picks.length);
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

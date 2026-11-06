import { postAssemblyPreview, type AssemblyPreviewAnswer, type AssemblyPreviewBody, type PreviewDetail } from '../../api';
import type { PanelChange } from '../create-feature/feature-panel';
import { PreviewRequests, type PreviewEdit } from './preview-requests';
import { PreviewTimings } from './preview-timings';

/** How {@link AssemblyPreviewRunner.settle} came out: the full-detail answer of the edit Apply would write, or why Apply must not go on. */
export type SettledPreview =
  | { ok: true; answer: AssemblyPreviewAnswer | null }
  | { ok: false; message: string };

export type PreviewRunnerOptions = {
  /** The dialog's token. */
  token: () => string;
  /** The edit the form describes now, or why it can't be previewed (a row that doesn't read). */
  edit: () => PreviewEdit | { error: string };
  /** The newest request's answer; an older request's, or one a newer request or render replaces, never arrives. */
  onAnswer: (answer: AssemblyPreviewAnswer, request: AssemblyPreviewBody) => void;
  /** "Updating…": the newest request has waited longer than {@link AssemblyPreviewRunner.BUSY_MS}. */
  onBusy: (busy: boolean) => void;
  /** Sends one request (tests fake it). */
  send?: (body: AssemblyPreviewBody, signal: AbortSignal) => Promise<AssemblyPreviewAnswer>;
};

type Sent = { seq: number; key: string; body: AssemblyPreviewBody; at: number; answer: Promise<AssemblyPreviewAnswer | null> };

/**
 * When an assembly dialog's preview asks the server to render (G4, P3/P4):
 * the timing and tier of every `POST /api/assembly-preview`, and which
 * answers the dialog hears.
 *
 * The rules:
 * - **Typing debounces**: a change sends a `'preview'`-tier request
 *   {@link TYPING_MS} after the last one. **A drag throttles** (a slider's
 *   `continuous` change): one request at once, then at most one per
 *   {@link DRAG_MS} while it moves, the last position always sent.
 * - **Settles at full**: {@link SETTLE_MS} after the last change, a
 *   `'full'`-tier request of the form as it stands — unless the last full
 *   answer was already for exactly that edit.
 * - **Latest wins**: every request takes a sequence number; only the newest
 *   one's answer reaches {@link PreviewRunnerOptions.onAnswer}. A
 *   `superseded` answer is dropped too, except `ended` (the preview is over,
 *   which the dialog must hear) — the server already coalesces, and a newer
 *   request or render will speak.
 * - **Updating…** shows while the newest request has waited more than
 *   {@link BUSY_MS}, and goes with its answer.
 * - **Apply** first {@link settle}s: the timers stop and a full request of
 *   the current edit is sent (or the last full answer of it reused), so the
 *   server serves Apply's render from that preview.
 * - Every answer's timings go to {@link PreviewTimings}, stale ones marked.
 */
export class AssemblyPreviewRunner {
  static readonly TYPING_MS = 150;
  static readonly DRAG_MS = 100;
  static readonly SETTLE_MS = 400;
  static readonly BUSY_MS = 150;

  private seq = 0;
  /** The newest request sent, and whether its answer is in. */
  private latest: Sent | null = null;
  private latestAnswered = true;
  /** The last full-tier answer of the newest edit: what {@link settle} reuses. */
  private lastFull: { key: string; seq: number; answer: AssemblyPreviewAnswer } | null = null;
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private busyTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSentAt = -Infinity;
  private abort = new AbortController();
  private stopped = false;
  private busy = false;
  private readonly send: (body: AssemblyPreviewBody, signal: AbortSignal) => Promise<AssemblyPreviewAnswer>;

  constructor(private readonly options: PreviewRunnerOptions) {
    this.send = options.send ?? postAssemblyPreview;
  }

  /** Whether a request ever went out — a dialog that sent none has no preview to end. */
  get hasSent(): boolean {
    return this.seq > 0;
  }

  /** A value changed: schedule the preview-tier request (debounced, or throttled for a drag) and the full one after it. */
  changed(change: PanelChange = {}): void {
    if (this.stopped) {
      return;
    }
    if (change.continuous) {
      this.throttle();
    } else {
      this.clearPreviewTimer();
      this.previewTimer = setTimeout(() => {
        this.previewTimer = null;
        this.request('preview');
      }, AssemblyPreviewRunner.TYPING_MS);
    }
    this.scheduleSettle();
  }

  /** Preview the form now (a dialog that just opened, or one whose preview a render replaced), settling at full after. */
  kick(): void {
    if (this.stopped) {
      return;
    }
    this.clearPreviewTimer();
    this.request('preview');
    this.scheduleSettle();
  }

  /**
   * Apply's step before writing: the timers stop, and the full-tier answer
   * of the edit as it stands comes back — the last one when it was for
   * exactly this edit and nothing was sent since, else a fresh request's.
   * Not ok when the edit can't be read, doesn't compile, the server refuses
   * it, or the preview ended.
   */
  async settle(): Promise<SettledPreview> {
    this.clearPreviewTimer();
    this.clearSettleTimer();
    const edit = this.options.edit();
    if ('error' in edit) {
      return { ok: false, message: edit.error };
    }
    const key = PreviewRequests.keyOf(edit);
    const latest = this.latest;
    let answer: AssemblyPreviewAnswer | null;
    if (this.lastFull !== null && this.lastFull.key === key && this.lastFull.seq === latest?.seq) {
      answer = this.lastFull.answer;
    } else if (latest && !this.latestAnswered && latest.key === key && latest.body.detail === 'full') {
      // The full request of this very edit is on its way: its answer is the one.
      answer = await latest.answer;
    } else {
      answer = await this.dispatch('full', edit);
    }
    if (answer === null) {
      return { ok: false, message: 'The dialog closed.' };
    }
    return AssemblyPreviewRunner.verdict(answer);
  }

  /** The dialog closed: no timer fires, no answer is heard. */
  stop(): void {
    this.stopped = true;
    this.clearPreviewTimer();
    this.clearSettleTimer();
    this.clearBusyTimer();
    this.abort.abort();
    this.setBusy(false);
  }

  /** Whether an answer lets Apply go on, and if not, why. */
  private static verdict(answer: AssemblyPreviewAnswer): SettledPreview {
    switch (answer.state) {
      case 'rendered':
      case 'build-error':
        return { ok: true, answer };
      case 'compile-error':
        return { ok: false, message: `The result doesn't compile: ${answer.compileError?.message ?? 'compile error'}` };
      case 'refused':
        return { ok: false, message: answer.reason };
      case 'superseded':
        // A render that started later will show the editor's code; Apply
        // still writes this edit into it.
        return answer.reason === 'ended' ? { ok: false, message: 'The preview ended.' } : { ok: true, answer: null };
    }
  }

  /** A drag: a request at once when the last one left long enough ago, else one at the end of the interval. */
  private throttle(): void {
    if (this.previewTimer !== null) {
      return;
    }
    const wait = this.lastSentAt + AssemblyPreviewRunner.DRAG_MS - AssemblyPreviewRunner.now();
    if (wait <= 0) {
      this.request('preview');
      return;
    }
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null;
      this.request('preview');
    }, wait);
  }

  private scheduleSettle(): void {
    this.clearSettleTimer();
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.settleFull();
    }, AssemblyPreviewRunner.SETTLE_MS);
  }

  /** The idle full-tier request — skipped when the newest full answer is already for this edit. */
  private settleFull(): void {
    const edit = this.options.edit();
    if ('error' in edit) {
      return;
    }
    const key = PreviewRequests.keyOf(edit);
    const latest = this.latest;
    if (latest && latest.key === key && latest.body.detail === 'full') {
      return;
    }
    void this.dispatch('full', edit);
  }

  /** Send the form's edit at `detail`, unless it can't be read. */
  private request(detail: PreviewDetail): void {
    const edit = this.options.edit();
    if ('error' in edit) {
      return;
    }
    void this.dispatch(detail, edit);
  }

  /** One request: sequenced, timed, its answer heard only while it is the newest. Null once stopped. */
  private dispatch(detail: PreviewDetail, edit: PreviewEdit): Promise<AssemblyPreviewAnswer | null> {
    if (this.stopped) {
      return Promise.resolve(null);
    }
    const body = PreviewRequests.body(edit, this.options.token(), detail);
    const at = AssemblyPreviewRunner.now();
    const sent: Sent = { seq: ++this.seq, key: PreviewRequests.keyOf(edit), body, at, answer: Promise.resolve(null) };
    this.latest = sent;
    this.latestAnswered = false;
    this.lastSentAt = at;
    this.armBusy();
    sent.answer = this.hear(sent);
    return sent.answer;
  }

  /** `sent`'s answer, delivered while it is the newest request. */
  private async hear(sent: Sent): Promise<AssemblyPreviewAnswer | null> {
    const { body } = sent;
    const detail = body.detail;
    let answer: AssemblyPreviewAnswer;
    try {
      answer = await this.send(body, this.abort.signal);
    } catch {
      return null;
    }
    if (this.stopped) {
      return null;
    }
    const newest = this.latest?.seq === sent.seq;
    this.recordTimings(sent, answer, !newest);
    if (!newest) {
      return answer;
    }
    this.latestAnswered = true;
    this.clearBusyTimer();
    this.setBusy(false);
    if (detail === 'full' && (answer.state === 'rendered' || answer.state === 'build-error')) {
      this.lastFull = { key: sent.key, seq: sent.seq, answer };
    }
    if (answer.state !== 'superseded' || answer.reason === 'ended') {
      this.options.onAnswer(answer, body);
    }
    return answer;
  }

  private recordTimings(sent: Sent, answer: AssemblyPreviewAnswer, stale: boolean): void {
    const report = answer.state === 'rendered' || answer.state === 'build-error' ? answer.generated ?? undefined : undefined;
    PreviewTimings.record({
      at: AssemblyPreviewRunner.now(),
      token: sent.body.token,
      detail: sent.body.detail,
      state: answer.state,
      roundTripMs: AssemblyPreviewRunner.now() - sent.at,
      stale,
      ...('timings' in answer && answer.timings ? { timings: answer.timings } : {}),
      ...(report?.misses !== undefined ? { misses: report.misses } : {}),
      ...(report?.hits ? { hits: report.hits } : {}),
      ...(report?.layoutMs !== undefined ? { layoutMs: report.layoutMs } : {}),
      ...(report?.buildMs !== undefined ? { buildMs: report.buildMs } : {}),
    });
  }

  private armBusy(): void {
    this.clearBusyTimer();
    this.busyTimer = setTimeout(() => {
      this.busyTimer = null;
      if (!this.latestAnswered) {
        this.setBusy(true);
      }
    }, AssemblyPreviewRunner.BUSY_MS);
  }

  private setBusy(busy: boolean): void {
    if (this.busy === busy) {
      return;
    }
    this.busy = busy;
    this.options.onBusy(busy);
  }

  private clearPreviewTimer(): void {
    if (this.previewTimer !== null) {
      clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
  }

  private clearSettleTimer(): void {
    if (this.settleTimer !== null) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
  }

  private clearBusyTimer(): void {
    if (this.busyTimer !== null) {
      clearTimeout(this.busyTimer);
      this.busyTimer = null;
    }
  }

  /** Wall-clock ms: what the throttle and the round trips are measured in (fake timers move it too). */
  private static now(): number {
    return Date.now();
  }
}

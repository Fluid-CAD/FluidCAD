import type { AssemblyPreviewAnswer, AssemblyPreviewTimings, PreviewDetail } from '../../api';

/** One preview answer's numbers, as {@link PreviewTimings} keeps them. */
export type PreviewTimingRecord = {
  /** When the answer arrived (`Date.now()`). */
  at: number;
  token: string;
  detail: PreviewDetail;
  state: AssemblyPreviewAnswer['state'];
  /** Sent → answered, as the page saw it. */
  roundTripMs: number;
  /** The answer was for a request a newer one had already replaced on the page. */
  stale: boolean;
  /** The server's phases (absent on a superseded or refused answer). */
  timings?: AssemblyPreviewTimings;
  /** Generated templates built for this answer, and the ones kept or taken from the cache. */
  misses?: number;
  hits?: { kept: number; cached: number };
  layoutMs?: number;
  buildMs?: number;
};

declare global {
  interface Window {
    /** The last {@link PreviewTimings.CAPACITY} preview answers' timings, oldest first. */
    __fluidcadPreviewTimings?: PreviewTimingRecord[];
  }
}

/**
 * Every preview answer's timings, kept for measuring (generators S8):
 * a ring buffer on `window.__fluidcadPreviewTimings`, never logged unless
 * asked — `localStorage['fluidcad.previewTimings'] = '1'` prints one
 * compact `console.debug` line per answer.
 */
export class PreviewTimings {
  static readonly CAPACITY = 200;
  static readonly LOG_FLAG = 'fluidcad.previewTimings';

  /** Keep one answer's numbers (and print them, when the flag is on). */
  static record(record: PreviewTimingRecord): void {
    if (typeof window === 'undefined') {
      return;
    }
    const buffer = window.__fluidcadPreviewTimings ??= [];
    buffer.push(record);
    if (buffer.length > PreviewTimings.CAPACITY) {
      buffer.splice(0, buffer.length - PreviewTimings.CAPACITY);
    }
    if (PreviewTimings.logging()) {
      console.debug(PreviewTimings.line(record));
    }
  }

  /** What is kept, oldest first. */
  static entries(): readonly PreviewTimingRecord[] {
    return typeof window === 'undefined' ? [] : window.__fluidcadPreviewTimings ?? [];
  }

  /** `[preview] full rendered 182ms (server 160: eval 12 render 120 send 8, 1.1MB) built 2 kept 5` */
  static line(record: PreviewTimingRecord): string {
    const t = record.timings;
    const server = t
      ? ` (server ${t.totalMs}: eval ${t.evaluateMs ?? '-'} render ${t.renderMs ?? '-'} send ${t.sendMs ?? '-'}`
        + `${t.payloadBytes !== undefined ? `, ${(t.payloadBytes / 1e6).toFixed(2)}MB` : ''})`
      : '';
    const builds = record.misses !== undefined
      ? ` built ${record.misses} kept ${record.hits?.kept ?? 0} cached ${record.hits?.cached ?? 0}`
      : '';
    return `[preview] ${record.detail} ${record.state}${record.stale ? ' (stale)' : ''} ${Math.round(record.roundTripMs)}ms${server}${builds}`;
  }

  private static logging(): boolean {
    try {
      return window.localStorage?.getItem(PreviewTimings.LOG_FLAG) === '1';
    } catch {
      return false;
    }
  }
}

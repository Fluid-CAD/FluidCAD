import type { OpeningProject, OpeningStatus, PageWindowState } from '../start/contract.ts';

/**
 * Opening a project, as a pure transition function: the life of a desktop
 * window, and of a project `npx fluidcad` opens in a browser tab. Neither
 * Electron nor HTTP appears here: `shell/src/window/app-window.ts` and
 * `server/session-registry.ts` feed it events and act on what comes back, and
 * `tests/open-state.test.ts` walks every edge.
 *
 *               open                         ready
 *     home ──────────▶ opening ───────────────────────▶ project
 *      ▲  ◀── cancel ──┘  │ fail                           │ close-project
 *      │                  ▼                                │
 *      │ ◀── cancel ── failed ── retry ──▶ opening         │
 *      └───────────────────────────────────────────────────┘
 *     project ── reopen ──▶ opening   (a pin change, same window)
 *
 * `attempt` numbers every open. It only ever grows, and the asynchronous
 * results of an open — progress, ready, failure — carry the attempt they
 * belong to: a result for an open that was cancelled, or already replaced by
 * a retry, no longer matches and changes nothing.
 */

export type OpenPhase = 'home' | 'opening' | 'failed' | 'project';

export type OpenState =
  | { phase: 'home'; attempt: number }
  | { phase: 'opening'; attempt: number; project: OpeningProject; status: OpeningStatus }
  | { phase: 'failed'; attempt: number; project: OpeningProject; message: string }
  | { phase: 'project'; attempt: number; project: OpeningProject; url: string };

export type OpenEvent =
  /** `status` is where the open starts: `creating` for a new project, `resolving` otherwise. */
  | { type: 'open'; project: OpeningProject; status?: OpeningStatus }
  | { type: 'progress'; attempt: number; status: OpeningStatus }
  | { type: 'ready'; attempt: number; url: string }
  | { type: 'fail'; attempt: number; message: string }
  | { type: 'cancel' }
  | { type: 'retry'; status?: OpeningStatus }
  | { type: 'close-project' }
  | { type: 'reopen' };

export const INITIAL_STATE: OpenState = { phase: 'home', attempt: 0 };

function opening(project: OpeningProject, attempt: number, status: OpeningStatus = { step: 'resolving' }): OpenState {
  return { phase: 'opening', attempt, project, status };
}

/** Progress that says nothing new: the open is already at that step, with those numbers. */
function sameStatus(a: OpeningStatus, b: OpeningStatus): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The next state, or `state` itself (the same object) when the event does not apply or changes nothing. */
export function transition(state: OpenState, event: OpenEvent): OpenState {
  switch (event.type) {
    case 'open':
      return state.phase === 'home' || state.phase === 'failed' ? opening(event.project, state.attempt + 1, event.status) : state;
    case 'retry':
      return state.phase === 'failed' ? opening(state.project, state.attempt + 1, event.status) : state;
    case 'reopen':
      return state.phase === 'project' ? opening(state.project, state.attempt + 1) : state;
    case 'progress':
      return state.phase === 'opening' && state.attempt === event.attempt && !sameStatus(state.status, event.status)
        ? { ...state, status: event.status }
        : state;
    case 'ready':
      return state.phase === 'opening' && state.attempt === event.attempt
        ? { phase: 'project', attempt: state.attempt, project: state.project, url: event.url }
        : state;
    case 'fail':
      return state.phase === 'opening' && state.attempt === event.attempt
        ? { phase: 'failed', attempt: state.attempt, project: state.project, message: event.message }
        : state;
    case 'cancel':
      return state.phase === 'opening' || state.phase === 'failed' ? { phase: 'home', attempt: state.attempt } : state;
    case 'close-project':
      return state.phase === 'project' ? { phase: 'home', attempt: state.attempt } : state;
  }
}

/** The phases in which the window shows the start page (or its fallback). */
export function showsStartPage(phase: OpenPhase): boolean {
  return phase !== 'project';
}

/** What the start page is told; null while the window shows the project's own page. */
export function pageStateOf(state: OpenState): PageWindowState | null {
  switch (state.phase) {
    case 'home':
      return { phase: 'home' };
    case 'opening':
      return { phase: 'opening', project: state.project, status: state.status };
    case 'failed':
      return { phase: 'failed', project: state.project, message: state.message };
    case 'project':
      return null;
  }
}

/** The project a window (or session) holds in any phase but home. */
export function projectOf(state: OpenState): OpeningProject | null {
  return state.phase === 'home' ? null : state.project;
}

/**
 * Client for the FluidCAD viewer's embed protocol (FluidCAD-Viewer,
 * `app/src/embed.js`). The viewer runs the real engine in an iframe; this is
 * the page's side of the conversation — swap the model, follow the page's
 * theme, replay the build, all without navigating the frame so the WASM
 * engine boots once.
 */

const CHANNEL = 'fluidcad-viewer';

export type ViewerModel = {
  /** Workspace files by path. One entry is enough for a single-file model. */
  files: Record<string, string>;
  /** Which file the scene is built from. The suffix picks part vs assembly. */
  entry: string;
  /** Optional workspace label, shown only by hosts that mount the top bar. */
  name?: string;
};

export type ViewerReadyEvent = {
  protocolVersion: number;
  engine: {version?: string} | null;
  /** False when the frame could not build a viewport (no WebGL). */
  viewport: boolean;
};

export type ViewerSceneEvent = {
  entry: string | null;
  reason: 'load' | 'rollback' | 'recompute' | 'set-param' | 'reset-params';
  ms: number;
  sceneKind: 'part' | 'assembly';
  objects: number;
  rollbackStop: number | null;
  objectErrors: number;
  compileError: string | null;
};

export type ViewerReplayEvent = {
  state: 'idle' | 'playing' | 'paused' | 'done';
  step: number;
  total: number;
};

export type ViewerErrorEvent = {stage: string; message: string};

type EventMap = {
  ready: ViewerReadyEvent;
  scene: ViewerSceneEvent;
  replay: ViewerReplayEvent;
  error: ViewerErrorEvent;
};

export type ReplayCommand =
  | {mode: 'play'; intervalMs?: number; holdMs?: number; loop?: boolean}
  | {mode: 'pause' | 'resume' | 'stop'};

export class ViewerEmbed {
  private readonly frame: HTMLIFrameElement;
  private readonly origin: string;
  private readonly handlers = new Map<keyof EventMap, Set<(payload: never) => void>>();
  private readonly pending = new Map<number, {resolve: (v: unknown) => void; reject: (e: Error) => void}>();
  private nextId = 1;
  private readonly onMessage: (event: MessageEvent) => void;

  constructor(frame: HTMLIFrameElement, viewerUrl: string) {
    this.frame = frame;
    // postMessage needs an exact origin; a wildcard would broadcast the
    // model to whatever else happens to be listening.
    this.origin = new URL(viewerUrl, window.location.href).origin;
    this.onMessage = (event) => this.receive(event);
    window.addEventListener('message', this.onMessage);
  }

  dispose(): void {
    window.removeEventListener('message', this.onMessage);
    this.handlers.clear();
    this.pending.clear();
  }

  on<K extends keyof EventMap>(type: K, handler: (payload: EventMap[K]) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as (payload: never) => void);
    return () => set.delete(handler as (payload: never) => void);
  }

  /** Point the viewer at a different model. */
  load(model: ViewerModel): void {
    this.post({type: 'load', model});
  }

  setTheme(theme: 'light' | 'dark'): void {
    this.post({type: 'set-theme', theme});
  }

  replay(command: ReplayCommand): void {
    this.post({type: 'replay', ...command});
  }

  /** Roll the scene back to a feature index (the timeline's own numbering). */
  rollback(index: number): void {
    this.post({type: 'rollback', index});
  }

  fit(): void {
    this.post({type: 'fit'});
  }

  /**
   * Slide the rendered model inside the frame without moving the camera:
   * positive `x` moves it left, positive `y` up. For overlaying page content
   * on part of the viewport.
   */
  setViewOffset(x: number, y = 0): void {
    this.post({type: 'set-view-offset', x, y});
  }

  /**
   * Room the page has claimed inside the frame for its own overlays. The
   * scene keeps the whole frame; only the viewer's floating panels move.
   */
  setPanelInset(inset: {top?: number; bottom?: number}): void {
    this.post({type: 'set-panel-inset', ...inset});
  }

  /** Scene furniture: the ground grid and the world axis lines. */
  setSettings(settings: {grid?: boolean; axes?: boolean}): void {
    this.post({type: 'set-settings', ...settings});
  }

  /** A PNG of what the viewer is showing — how the posters are produced. */
  screenshot(options: Record<string, unknown> = {}): Promise<Blob> {
    return this.request<Blob>('screenshot', {options});
  }

  private request<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {resolve: resolve as (v: unknown) => void, reject});
      this.post({type, id, ...payload});
    });
  }

  private post(body: Record<string, unknown>): void {
    this.frame.contentWindow?.postMessage({channel: CHANNEL, v: 1, ...body}, this.origin);
  }

  private receive(event: MessageEvent): void {
    if (event.source !== this.frame.contentWindow || event.origin !== this.origin) {
      return;
    }
    const msg = event.data;
    if (!msg || typeof msg !== 'object' || msg.channel !== CHANNEL) {
      return;
    }
    if (msg.type === 'result') {
      const pending = this.pending.get(msg.id);
      if (!pending) {
        return;
      }
      this.pending.delete(msg.id);
      if (msg.ok) {
        pending.resolve(msg.value);
      } else {
        pending.reject(new Error(msg.error));
      }
      return;
    }
    const set = this.handlers.get(msg.type as keyof EventMap);
    if (set) {
      for (const handler of set) {
        (handler as (payload: unknown) => void)(msg);
      }
    }
  }
}

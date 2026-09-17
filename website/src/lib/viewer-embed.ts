/**
 * Client for the FluidCAD viewer's embed protocol (FluidCAD-Viewer,
 * `app/src/embed.js`). The viewer runs the real engine in an iframe; this is
 * the page's side of the conversation — swap the model, follow the page's
 * theme, replay the build, all without navigating the frame so the WASM
 * engine boots once.
 */

const CHANNEL = 'fluidcad-viewer';

export type ViewerAnimation = {
  /** Authored mate().name(), independent of declaration order. */
  mate: string;
  /** Occurrence path; omit when the name is unique across the assembly. */
  owner?: string;
  /** Open controls paused by default; true starts playback after load. */
  autoplay?: boolean;
};

export type ViewerModel = {
  /** Workspace files by path. One entry is enough for a single-file model. */
  files: Record<string, string>;
  /** Which file the scene is built from. The suffix picks part vs assembly. */
  entry: string;
  /** Optional workspace label, shown only by hosts that mount the top bar. */
  name?: string;
  /** Omission clears animation when switching models. */
  animation?: ViewerAnimation | null;
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

/** The named directions the viewer frames a model from. */
export type ViewerNamedView =
  | 'front'
  | 'back'
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'iso-ftr'
  | 'iso-fbr'
  | 'iso-ftl'
  | 'iso-fbl'
  | 'iso-btr'
  | 'iso-bbr'
  | 'iso-btl'
  | 'iso-bbl';

/**
 * Where the viewer looks from. `current` leaves the angle where it is; a
 * `x,y,z` string (or the object form) is the direction to look from, for an
 * angle none of the fourteen names — only its direction counts, since the
 * viewer stands off by the scene's own size.
 */
export type ViewerView =
  | 'current'
  | ViewerNamedView
  | `${number},${number},${number}`
  | {kind: 'direction'; direction: [number, number, number]}
  | {kind: 'look-from'; eye: [number, number, number]; target?: [number, number, number]};

/**
 * How the viewport frames the model — the page's standing answer, not a
 * per-call one. Mirrors `FitPolicy` in `fluidcad/viewer-ui`.
 */
export type ViewerFitPolicy = {
  /** The direction an automatic fit looks from. */
  view: ViewerView;
  /**
   * `sphere` frames the sphere around the model: the same from every angle,
   * and mostly empty space for anything longer than it is wide. `tight`
   * frames the model as it actually projects, in the viewport's own aspect
   * ratio, so a long model fills a wide frame.
   */
  mode: 'sphere' | 'tight';
  /** Air around the model, as a multiple of its framed extent. 1 is flush. */
  padding: number;
  /**
   * `once` frames the first model and then leaves the camera alone. `auto`
   * re-frames whenever the model or the viewport changes — and stops for
   * good once the visitor moves the camera themselves.
   */
  refit: 'once' | 'auto';
};

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

  /**
   * A one-off frame of whatever is in the scene. Anything passed applies to
   * this fit alone; {@link setFitPolicy} is what makes a framing stick.
   */
  fit(options: Partial<ViewerFitPolicy> = {}): void {
    this.post({type: 'fit', ...options});
  }

  /** Point the camera at the model from a given direction and frame it. */
  setView(view: ViewerView): void {
    this.post({type: 'set-view', view});
  }

  /**
   * The standing framing — see {@link ViewerFitPolicy}. Everything is
   * optional and merges into what the viewer already has, so a page can name
   * only the part it cares about. Sent before the model, it decides the
   * viewport's opening picture rather than correcting it afterwards.
   */
  setFitPolicy(policy: Partial<ViewerFitPolicy>): void {
    this.post({type: 'set-fit', ...policy});
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

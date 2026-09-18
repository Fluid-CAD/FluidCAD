import crypto from 'crypto';
import { WebSocket, WebSocketServer } from 'ws';
import type { CameraStateMessage, ServerToUIMessage } from './ws-protocol.ts';

/**
 * Shared HTTP+WS plumbing for server entry points to compose. The desktop
 * entry (`index.ts`) uses it directly; it's also exported via
 * `fluidcad/server/api` so downstream hosts (e.g. a hub runtime) can build
 * their own entry on top. The pieces here are mode-agnostic:
 *
 * - **WS client registry** with per-connection sessionId tracking. Hub mode
 *   dispatches param mutations to a specific sessionId; desktop ignores
 *   sessionId and broadcasts to every client.
 * - **Screenshot request/response coordinator** — the screenshot endpoint
 *   round-trips through a WS client to get a PNG. Same flow either side.
 * - **Camera state mirror** — the most recent camera-state message,
 *   exposed via getter for `/api/camera/state`.
 *
 * Mode-specific things (engine init, route mounting, file watching, IPC)
 * stay in the calling entry point.
 */

export interface UIClient {
  ws: WebSocket;
  sessionId: string;
  /** The page announced (`ui-hello`) that it acknowledges every scene it applies. */
  acksScenes: boolean;
  /** The newest scene version this page reported on screen (`scene-applied`). */
  appliedVersion: number;
}

/** How long one capture may take, from the moment a page is asked for it. */
const SCREENSHOT_TIMEOUT_MS = 10_000;
/** How long a screenshot waits for a page to finish applying the latest scene. */
const SCENE_APPLY_TIMEOUT_MS = 60_000;

export interface ServerCore {
  wss: WebSocketServer;
  uiClients: Set<UIClient>;
  /** Broadcast to every connected UI client. */
  broadcastToUI(msg: ServerToUIMessage): void;
  /** Send to the single UI client with the matching sessionId. No-op if absent. */
  sendToSession(sessionId: string, msg: ServerToUIMessage): void;
  /**
   * Capture the latest scene as PNG bytes. Waits until a page has that scene
   * on screen, then asks that one page — so a capture never shows the scene
   * before the render it followed, and its timeout measures the capture only.
   */
  requestScreenshot(options: Record<string, unknown>): Promise<Buffer>;
  /**
   * Whether some connected page has the latest broadcast scene on screen.
   * False with no page connected, and while every page is still applying it.
   */
  isLatestSceneApplied(): boolean;
  /**
   * Resolves true once some page has the latest broadcast scene on screen —
   * what lets a caller report "visible", not just "built". False at once
   * when no connected page acknowledges scenes (none open, or an older UI
   * bundle), and false when `timeoutMs` passes first.
   */
  awaitLatestSceneApplied(timeoutMs: number): Promise<boolean>;
  /** Latest camera-state observed from any UI client. */
  getLastCameraState(): CameraStateMessage | null;
  /**
   * Hook for the entry point to handle non-core UI→server messages. The core
   * already consumes `screenshot-result` and `camera-state`; everything else
   * is forwarded here (with the sender's sessionId for routing).
   */
  setMessageHandler(
    handler: (sessionId: string, msg: any, ws: WebSocket) => void | Promise<void>,
  ): void;
  /**
   * Hook for the entry point to seed a newly connected client. Called after
   * the core has registered the client and assigned its sessionId; useful for
   * sending initial scene-rendered, init-complete replay, etc.
   */
  setConnectionHandler(handler: (sessionId: string, ws: WebSocket) => void | Promise<void>): void;
  /**
   * Hook called after a UI client disconnects. The hub entry uses this to
   * drop per-session engine state.
   */
  setDisconnectHandler(handler: (sessionId: string) => void): void;
}

export interface ServerCoreOptions {
  /** Gate on WebSocket upgrades — the host guard, so a rebound page cannot open the scene stream either. */
  verifyClient?: (info: { req: import('http').IncomingMessage }) => boolean;
}

export function createServerCore(httpServer: import('http').Server, options: ServerCoreOptions = {}): ServerCore {
  const wss = new WebSocketServer({ server: httpServer, verifyClient: options.verifyClient });
  const uiClients = new Set<UIClient>();

  let lastSceneMessage: string | null = null;
  /** Version of the newest scene sent to the pages — 0 before the first one. */
  let sceneVersion = 0;
  /** Woken whenever which page shows what may have changed: an ack, a hello, a disconnect. */
  const sceneApplyWaiters = new Set<() => void>();
  let initCompleteMessage: string | null = null;
  /**
   * A render was announced (`processing-file`) and has not landed yet. A page
   * that connects in that window is told so it can show its spinner; one that
   * connects to a workspace with nothing rendering — an empty folder — is
   * not, and lands on an empty scene instead of waiting for a model that will
   * never come.
   */
  let renderInFlight = false;
  let lastCameraState: CameraStateMessage | null = null;
  let messageHandler: ((sessionId: string, msg: any, ws: WebSocket) => void | Promise<void>) | null = null;
  let connectionHandler: ((sessionId: string, ws: WebSocket) => void | Promise<void>) | null = null;
  let disconnectHandler: ((sessionId: string) => void) | null = null;

  const pendingScreenshots = new Map<string, {
    resolve: (data: Buffer) => void;
    reject: (err: Error) => void;
  }>();

  function broadcastToUI(msg: ServerToUIMessage) {
    // Every scene a page is handed — a render, or the scene closing — gets
    // the next version, so "is the latest scene on screen" has an answer.
    if (msg.type === 'scene-rendered' || msg.type === 'scene-closed') {
      msg = { ...msg, sceneVersion: ++sceneVersion };
    }
    const data = JSON.stringify(msg);
    if (msg.type === 'scene-rendered') {
      lastSceneMessage = data;
      renderInFlight = false;
    }
    if (msg.type === 'processing-file') {
      renderInFlight = true;
    }
    if (msg.type === 'scene-closed') {
      lastSceneMessage = null;
      renderInFlight = false;
    }
    if (msg.type === 'init-complete') {
      initCompleteMessage = data;
    }
    for (const client of uiClients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  function sendToSession(sessionId: string, msg: ServerToUIMessage) {
    const data = JSON.stringify(msg);
    for (const client of uiClients) {
      if (client.sessionId === sessionId && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  function openClients(): UIClient[] {
    return [...uiClients].filter(client => client.ws.readyState === WebSocket.OPEN);
  }

  /** A page that acknowledges scenes and has the latest one on screen. */
  function clientShowingLatestScene(): UIClient | undefined {
    return openClients().find(client => client.acksScenes && client.appliedVersion === sceneVersion);
  }

  function wakeSceneApplyWaiters(): void {
    for (const wake of [...sceneApplyWaiters]) {
      wake();
    }
  }

  /**
   * The page to capture from: one showing the latest scene, waited for while
   * pages that acknowledge scenes are still applying it. Null when no
   * connected page acknowledges scenes (an older UI bundle) — the caller
   * then asks every page, as it always did.
   */
  function awaitClientShowingLatestScene(): Promise<UIClient | null> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const settle = (): boolean => {
        const clients = openClients();
        if (clients.length === 0) {
          finish();
          reject(new Error('No UI client connected.'));
          return true;
        }
        if (!clients.some(client => client.acksScenes)) {
          finish();
          resolve(null);
          return true;
        }
        const ready = clientShowingLatestScene();
        if (ready) {
          finish();
          resolve(ready);
          return true;
        }
        return false;
      };
      const finish = () => {
        sceneApplyWaiters.delete(settle);
        if (timer) {
          clearTimeout(timer);
        }
      };
      if (settle()) {
        return;
      }
      sceneApplyWaiters.add(settle);
      timer = setTimeout(() => {
        finish();
        reject(new Error(`The viewer is still applying render v${sceneVersion}.`));
      }, SCENE_APPLY_TIMEOUT_MS);
    });
  }

  function awaitLatestSceneApplied(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (applied: boolean) => {
        sceneApplyWaiters.delete(settle);
        if (timer) {
          clearTimeout(timer);
        }
        resolve(applied);
      };
      const settle = (): void => {
        if (clientShowingLatestScene()) {
          finish(true);
        } else if (!openClients().some(client => client.acksScenes)) {
          finish(false);
        }
      };
      sceneApplyWaiters.add(settle);
      timer = setTimeout(() => finish(false), timeoutMs);
      settle();
    });
  }

  async function requestScreenshot(options: Record<string, unknown>): Promise<Buffer> {
    const target = await awaitClientShowingLatestScene();
    return captureFrom(target, options);
  }

  /** Ask one page (or, with none to single out, every page) for a capture. */
  function captureFrom(target: UIClient | null, options: Record<string, unknown>): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timeout = setTimeout(() => {
        pendingScreenshots.delete(requestId);
        reject(new Error('Screenshot request timed out.'));
      }, SCREENSHOT_TIMEOUT_MS);
      pendingScreenshots.set(requestId, {
        resolve(data) {
          clearTimeout(timeout);
          pendingScreenshots.delete(requestId);
          resolve(data);
        },
        reject(err) {
          clearTimeout(timeout);
          pendingScreenshots.delete(requestId);
          reject(err);
        },
      });
      const request: ServerToUIMessage = { type: 'take-screenshot', requestId, options };
      if (target) {
        target.ws.send(JSON.stringify(request));
      } else {
        broadcastToUI(request);
      }
    });
  }

  function handleCoreMessage(client: UIClient, msg: any): boolean {
    if (msg.type === 'ui-hello') {
      client.acksScenes = msg.sceneAcks === true;
      wakeSceneApplyWaiters();
      return true;
    }
    if (msg.type === 'scene-applied') {
      if (typeof msg.version === 'number' && msg.version > client.appliedVersion) {
        client.appliedVersion = msg.version;
        wakeSceneApplyWaiters();
      }
      return true;
    }
    if (msg.type === 'screenshot-result' && msg.requestId) {
      const pending = pendingScreenshots.get(msg.requestId);
      if (!pending) { return true; }
      if (msg.success && msg.data) {
        pending.resolve(Buffer.from(msg.data, 'base64'));
      } else {
        pending.reject(new Error(msg.error || 'Screenshot failed.'));
      }
      return true;
    }
    if (msg.type === 'camera-state') {
      if (
        Array.isArray(msg.position) && msg.position.length === 3 &&
        Array.isArray(msg.target) && msg.target.length === 3 &&
        Array.isArray(msg.up) && msg.up.length === 3
      ) {
        lastCameraState = {
          type: 'camera-state',
          position: msg.position,
          target: msg.target,
          up: msg.up,
          projection: msg.projection === 'perspective' ? 'perspective' : 'orthographic',
        };
      }
      return true;
    }
    return false;
  }

  wss.on('connection', (ws) => {
    const sessionId = crypto.randomUUID();
    const client: UIClient = { ws, sessionId, acksScenes: false, appliedVersion: 0 };
    uiClients.add(client);

    if (initCompleteMessage) {
      ws.send(initCompleteMessage);
    }
    if (lastSceneMessage) {
      ws.send(lastSceneMessage);
    }
    if (renderInFlight) {
      ws.send(JSON.stringify({ type: 'processing-file' } satisfies ServerToUIMessage));
    }

    if (connectionHandler) {
      Promise.resolve(connectionHandler(sessionId, ws)).catch((err) => {
        console.error('connectionHandler error:', err);
      });
    }

    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (handleCoreMessage(client, msg)) {
        return;
      }
      if (messageHandler) {
        Promise.resolve(messageHandler(sessionId, msg, ws)).catch((err) => {
          console.error('messageHandler error:', err);
        });
      }
    });

    ws.on('close', () => {
      uiClients.delete(client);
      wakeSceneApplyWaiters();
      if (disconnectHandler) {
        try {
          disconnectHandler(sessionId);
        } catch (err) {
          console.error('disconnectHandler error:', err);
        }
      }
    });
  });

  return {
    wss,
    uiClients,
    broadcastToUI,
    sendToSession,
    requestScreenshot,
    isLatestSceneApplied: () => clientShowingLatestScene() !== undefined,
    awaitLatestSceneApplied,
    getLastCameraState: () => lastCameraState,
    setMessageHandler(handler) { messageHandler = handler; },
    setConnectionHandler(handler) { connectionHandler = handler; },
    setDisconnectHandler(handler) { disconnectHandler = handler; },
  };
}

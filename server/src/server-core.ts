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
}

const SCREENSHOT_TIMEOUT_MS = 10_000;

export interface ServerCore {
  wss: WebSocketServer;
  uiClients: Set<UIClient>;
  /** Broadcast to every connected UI client. */
  broadcastToUI(msg: ServerToUIMessage): void;
  /** Send to the single UI client with the matching sessionId. No-op if absent. */
  sendToSession(sessionId: string, msg: ServerToUIMessage): void;
  /** Trigger a screenshot via the first connected UI client; resolves with PNG bytes. */
  requestScreenshot(options: Record<string, unknown>): Promise<Buffer>;
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

export function createServerCore(httpServer: import('http').Server): ServerCore {
  const wss = new WebSocketServer({ server: httpServer });
  const uiClients = new Set<UIClient>();

  let lastSceneMessage: string | null = null;
  let initCompleteMessage: string | null = null;
  let lastCameraState: CameraStateMessage | null = null;
  let messageHandler: ((sessionId: string, msg: any, ws: WebSocket) => void | Promise<void>) | null = null;
  let connectionHandler: ((sessionId: string, ws: WebSocket) => void | Promise<void>) | null = null;
  let disconnectHandler: ((sessionId: string) => void) | null = null;

  const pendingScreenshots = new Map<string, {
    resolve: (data: Buffer) => void;
    reject: (err: Error) => void;
  }>();

  function broadcastToUI(msg: ServerToUIMessage) {
    const data = JSON.stringify(msg);
    if (msg.type === 'scene-rendered') {
      lastSceneMessage = data;
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

  function requestScreenshot(options: Record<string, unknown>): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (uiClients.size === 0) {
        reject(new Error('No UI client connected.'));
        return;
      }
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
      broadcastToUI({ type: 'take-screenshot', requestId, options });
    });
  }

  function handleCoreMessage(_sessionId: string, msg: any, _ws: WebSocket): boolean {
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
    const client: UIClient = { ws, sessionId };
    uiClients.add(client);

    if (initCompleteMessage) {
      ws.send(initCompleteMessage);
    }
    if (lastSceneMessage) {
      ws.send(lastSceneMessage);
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
      if (handleCoreMessage(sessionId, msg, ws)) {
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
    getLastCameraState: () => lastCameraState,
    setMessageHandler(handler) { messageHandler = handler; },
    setConnectionHandler(handler) { connectionHandler = handler; },
    setDisconnectHandler(handler) { disconnectHandler = handler; },
  };
}

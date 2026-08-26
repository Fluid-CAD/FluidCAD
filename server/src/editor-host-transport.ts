import type { ServerCore } from './server-core.ts';
import type { HostRegistry } from './host-registry.ts';
import type { FeatureEditDispatcher } from './edit-dispatch.ts';
import type { DirtyBufferState } from './routes/editor.ts';

/**
 * The in-page editor host's transport. An IPC host talks over `process.send`;
 * the Monaco host in the page talks over the WebSocket it already has, and
 * this is the server side of that.
 *
 * Only three messages need a new pipe. `live-update` doesn't — `POST
 * /api/render` already is that route — and `apply-feature-edit` acks already
 * ride `POST /api/code/apply-feature` for every host.
 */

export interface EditorHostTransportDeps {
  core: ServerCore;
  hosts: HostRegistry;
  dispatcher: FeatureEditDispatcher;
  dirtyBufferState: DirtyBufferState;
}

/**
 * Tell every client what the winning host offers. A `false` is meaningful, not
 * merely absent: it's how the UI hides its history controls again when the page
 * that was hosting goes away.
 */
export function broadcastEditorCapabilities(core: ServerCore, hosts: HostRegistry): void {
  const capabilities = hosts.effectiveCapabilities();
  core.broadcastToUI({ type: 'editor-capabilities', undoRedo: capabilities?.undoRedo === true });
}

export function attachEditorHostTransport(deps: EditorHostTransportDeps): void {
  const { core, hosts, dispatcher, dirtyBufferState } = deps;

  // An IPC hello usually lands before the first UI connection (the extension
  // forks the server, then opens the webview), so late joiners get a replay.
  // Nothing is sent when no host ever announced — the UI's default is "no
  // editor", and a server without one must not claim otherwise.
  core.setConnectionHandler((_sessionId, ws) => {
    const capabilities = hosts.effectiveCapabilities();
    if (capabilities) {
      ws.send(JSON.stringify({ type: 'editor-capabilities', ...capabilities }));
    }
  });

  core.setMessageHandler((sessionId, msg, ws) => {
    switch (msg?.type) {
      case 'editor-hello': {
        hosts.attachUiHost(sessionId, (hostMsg) => {
          if (ws.readyState !== ws.OPEN) {
            return false;
          }
          ws.send(JSON.stringify({ type: 'host-message', message: hostMsg }));
          return true;
        });
        hosts.announce('ui', { undoRedo: msg.capabilities?.undoRedo === true });
        broadcastEditorCapabilities(core, hosts);
        break;
      }

      case 'editor-dirty-state': {
        if (Array.isArray(msg.dirtyFiles)) {
          dirtyBufferState.setDirtyFiles(
            msg.dirtyFiles.filter((p: unknown): p is string => typeof p === 'string'),
          );
        }
        break;
      }

      case 'edit-ack': {
        if (typeof msg.editId === 'string') {
          dispatcher.settle(msg.editId, typeof msg.error === 'string' ? msg.error : undefined);
        }
        break;
      }
    }
  });

  core.setDisconnectHandler((sessionId) => {
    // Only when the page that was hosting went away — an ordinary viewer tab
    // closing must not make the surviving clients rethink their toolbar.
    if (hosts.detachUiHost(sessionId)) {
      broadcastEditorCapabilities(core, hosts);
    }
  });
}

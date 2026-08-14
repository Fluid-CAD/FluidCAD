/**
 * Routes host-directed messages to whichever editor host is attached.
 *
 * There are three implementations of the host contract (see
 * `docs/desktop/00-architecture.md`): the VS Code extension and the Neovim
 * bridge over IPC, and the in-page Monaco host over the UI WebSocket. They all
 * receive the same messages; only the pipe differs. Route call sites keep
 * calling one `(msg) => boolean` and never learn which one answered.
 *
 * **The IPC host wins when both are attached.** A VS Code webview showing the
 * new UI has a real editor holding the buffer; the in-page host must not fight
 * it for the same file.
 */

export type HostSend = (msg: any) => boolean;

export type HostKind = 'ipc' | 'ui';

export type HostCapabilities = { undoRedo: boolean };

export class HostRegistry {
  /** Only one page hosts at a time — the most recent `editor-hello` wins. */
  private uiHost: { sessionId: string; send: HostSend } | null = null;
  private capabilities = new Map<HostKind, HostCapabilities>();

  /**
   * @param ipcSend today's `sendToExtension`: returns false when this process
   * was not forked with an IPC channel, which is exactly "no IPC host".
   */
  constructor(private readonly ipcSend: HostSend) {}

  attachUiHost(sessionId: string, send: HostSend): void {
    this.uiHost = { sessionId, send };
  }

  /** @returns true when `sessionId` was in fact the attached in-page host. */
  detachUiHost(sessionId: string): boolean {
    if (this.uiHost?.sessionId !== sessionId) {
      return false;
    }
    this.uiHost = null;
    this.capabilities.delete('ui');
    return true;
  }

  /** Record what a host announced in its `editor-hello`. */
  announce(kind: HostKind, capabilities: HostCapabilities): void {
    this.capabilities.set(kind, capabilities);
  }

  /**
   * What the UI should believe about editor-backed affordances (undo/redo).
   * Follows the same precedence as {@link send}, so the buttons describe the
   * host that would actually receive the click. Null when no host announced.
   */
  effectiveCapabilities(): HostCapabilities | null {
    return this.capabilities.get('ipc') ?? this.capabilities.get('ui') ?? null;
  }

  /**
   * @returns true when a host received the message.
   *
   * An IPC *channel* is not an editor: `fluidcad serve` forks this process
   * with one purely for lifecycle, so `process.send` existing would otherwise
   * swallow every edit before the page could see it. What identifies a host is
   * its `editor-hello`. The final fallback is deliberate — it is exactly the
   * pre-registry behaviour, so a host that never announces (an extension older
   * than the hello handshake) keeps receiving edits.
   */
  send(msg: any): boolean {
    if (this.capabilities.has('ipc')) {
      return this.ipcSend(msg);
    }
    if (this.uiHost) {
      return this.uiHost.send(msg);
    }
    return this.ipcSend(msg);
  }
}

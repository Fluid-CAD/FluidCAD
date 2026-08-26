import { describe, it, expect } from 'vitest';
import { HostRegistry } from '../src/host-registry.ts';

// Three implementations of the host contract share one router-facing send.
// What matters here is the precedence rule: a VS Code webview showing the new
// UI has both an IPC host and a page that can host, and the real editor must
// win — the in-page host must never fight it for the same buffer.

describe('host registry', () => {
  it('reports no host when neither pipe is attached', () => {
    const hosts = new HostRegistry(() => false);
    expect(hosts.send({ type: 'undo' })).toBe(false);
    expect(hosts.effectiveCapabilities()).toBeNull();
  });

  it('routes to the in-page host when there is no IPC host', () => {
    const received: any[] = [];
    const hosts = new HostRegistry(() => false);
    hosts.attachUiHost('session-1', (msg) => { received.push(msg); return true; });

    expect(hosts.send({ type: 'undo', editId: 'e1' })).toBe(true);
    expect(received).toEqual([{ type: 'undo', editId: 'e1' }]);
  });

  it('gives the IPC host precedence when both announced', () => {
    const ipc: any[] = [];
    const ui: any[] = [];
    const hosts = new HostRegistry((msg) => { ipc.push(msg); return true; });
    hosts.attachUiHost('session-1', (msg) => { ui.push(msg); return true; });
    hosts.announce('ui', { undoRedo: true });
    hosts.announce('ipc', { undoRedo: true });

    hosts.send({ type: 'apply-feature-edit' });
    expect(ipc).toHaveLength(1);
    expect(ui).toEqual([]);
  });

  it('does not treat a bare IPC channel as an editor', () => {
    // `fluidcad serve` forks this process with an IPC channel for lifecycle
    // messages only. Without a hello it is not a host, and edits must reach
    // the page instead of vanishing into the CLI.
    const ipc: any[] = [];
    const ui: any[] = [];
    const hosts = new HostRegistry((msg) => { ipc.push(msg); return true; });
    hosts.attachUiHost('session-1', (msg) => { ui.push(msg); return true; });
    hosts.announce('ui', { undoRedo: true });

    expect(hosts.send({ type: 'undo' })).toBe(true);
    expect(ipc).toEqual([]);
    expect(ui).toHaveLength(1);
  });

  it('falls back to the raw IPC channel when nothing announced at all', () => {
    // Pre-registry behaviour, kept for an extension older than the handshake.
    const ipc: any[] = [];
    const hosts = new HostRegistry((msg) => { ipc.push(msg); return true; });
    expect(hosts.send({ type: 'undo' })).toBe(true);
    expect(ipc).toHaveLength(1);
  });

  it('reports the winning host capabilities, not the last announced', () => {
    const hosts = new HostRegistry(() => true);
    hosts.attachUiHost('session-1', () => true);
    hosts.announce('ui', { undoRedo: false });
    hosts.announce('ipc', { undoRedo: true });
    expect(hosts.effectiveCapabilities()).toEqual({ undoRedo: true });

    // …and the other way round: the page announcing later doesn't demote the
    // extension.
    hosts.announce('ui', { undoRedo: true });
    expect(hosts.effectiveCapabilities()).toEqual({ undoRedo: true });
  });

  it('falls back to the in-page host when the socket has closed', () => {
    const hosts = new HostRegistry(() => false);
    hosts.attachUiHost('session-1', () => false);
    expect(hosts.send({ type: 'undo' })).toBe(false);
  });

  it('detaches only the session that was hosting', () => {
    const hosts = new HostRegistry(() => false);
    hosts.attachUiHost('session-1', () => true);
    hosts.announce('ui', { undoRedo: true });

    expect(hosts.detachUiHost('session-2')).toBe(false);
    expect(hosts.send({ type: 'undo' })).toBe(true);

    expect(hosts.detachUiHost('session-1')).toBe(true);
    expect(hosts.send({ type: 'undo' })).toBe(false);
    expect(hosts.effectiveCapabilities()).toBeNull();
  });

  it('replaces the in-page host when a second page says hello', () => {
    const first: any[] = [];
    const second: any[] = [];
    const hosts = new HostRegistry(() => false);
    hosts.attachUiHost('session-1', (msg) => { first.push(msg); return true; });
    hosts.attachUiHost('session-2', (msg) => { second.push(msg); return true; });

    hosts.send({ type: 'undo' });
    expect(first).toEqual([]);
    expect(second).toHaveLength(1);
  });
});

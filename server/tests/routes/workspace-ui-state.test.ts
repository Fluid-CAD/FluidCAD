import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { createWorkspaceStateRouter, WorkspaceUiStateStore } from '../../src/routes/workspace-state.ts';

/**
 * `GET`/`PATCH /api/workspace/ui-state` (hub-plan H12): what a surface
 * remembers for one project across reloads and restarts, in its
 * `.fluidcad/ui-state.json`, beside the editor's tabs. The Hub panel's
 * install target is the first key.
 */

let servers: http.Server[] = [];
let workspace: string;

async function serve(dir: string): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use('/api', createWorkspaceStateRouter(dir));
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/api`;
}

async function patch(base: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/workspace/ui-state`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-state-'));
});

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers = [];
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('the per-project UI state', () => {
  it('starts with nothing remembered, keeps the Hub panel’s install target in .fluidcad/ui-state.json, and reads it back after a restart', async () => {
    const base = await serve(workspace);
    expect(await (await fetch(`${base}/workspace/ui-state`)).json()).toEqual({ hubInstallTarget: null });
    expect(await patch(base, { hubInstallTarget: 'project' })).toEqual({ status: 200, body: { hubInstallTarget: 'project' } });
    const file = path.join(workspace, '.fluidcad', 'ui-state.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ hubInstallTarget: 'project' });
    // A new engine for the same project (an app restart) reads it back.
    const again = await serve(workspace);
    expect(await (await fetch(`${again}/workspace/ui-state`)).json()).toEqual({ hubInstallTarget: 'project' });
    expect(await patch(again, { hubInstallTarget: 'library' })).toEqual({ status: 200, body: { hubInstallTarget: 'library' } });
  });

  it('keeps each project’s choice apart', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-state-other-'));
    try {
      await patch(await serve(workspace), { hubInstallTarget: 'project' });
      expect(WorkspaceUiStateStore.read(other)).toEqual({ hubInstallTarget: null });
      expect(WorkspaceUiStateStore.read(workspace)).toEqual({ hubInstallTarget: 'project' });
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('refuses an unknown key or value and writes nothing; a broken file reads as nothing remembered', async () => {
    const base = await serve(workspace);
    expect(await patch(base, { hubInstallTarget: 'desk' })).toEqual({ status: 400, body: { error: '"desk" isn\'t a value of hubInstallTarget.' } });
    expect(await patch(base, { theme: 'dark' })).toEqual({ status: 400, body: { error: '"theme" isn\'t a UI state key: use hubInstallTarget.' } });
    expect(await patch(base, ['project'])).toEqual({ status: 400, body: { error: 'Send an object of the keys to change.' } });
    expect(fs.existsSync(path.join(workspace, '.fluidcad', 'ui-state.json'))).toBe(false);
    fs.mkdirSync(path.join(workspace, '.fluidcad'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.fluidcad', 'ui-state.json'), '{ not json');
    expect(WorkspaceUiStateStore.read(workspace)).toEqual({ hubInstallTarget: null });
    fs.writeFileSync(path.join(workspace, '.fluidcad', 'ui-state.json'), JSON.stringify({ hubInstallTarget: 42 }));
    expect(WorkspaceUiStateStore.read(workspace)).toEqual({ hubInstallTarget: null });
  });

  it('refuses a write without a workspace', async () => {
    const base = await serve('');
    expect(await patch(base, { hubInstallTarget: 'project' })).toEqual({ status: 400, body: { error: 'This server has no workspace to store state for.' } });
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { AGENT_ENTRY, createAgentRoutes } from '../../src/routes/agent.ts';
import type { AgentHostDeps } from '../../src/agent-host.ts';

let tmp: string;
let server: http.Server | null = null;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-agent-routes-'));
});

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const deps: AgentHostDeps = {
  workspacePath: '/w',
  port: 1,
  version: '0.0.0',
  startedAt: new Date(0).toISOString(),
  currentFile: () => null,
  renderState: () => ({ state: 'none' }),
  unit: () => 'mm',
  loadPreferences: async () => ({}) as any,
};

/** A stand-in runtime: answers `GET agents` and echoes what it was given. */
function writeStubEntry(): string {
  const file = path.join(tmp, 'agent-stub.mjs');
  const expressUrl = new URL(import.meta.resolve('express')).href;
  fs.writeFileSync(
    file,
    `import express from ${JSON.stringify(expressUrl)};
export function createAgentRouter(deps) {
  const router = express.Router();
  router.get('/agents', (req, res) => res.json({ agents: [], workspace: deps.workspacePath }));
  return router;
}
`,
  );
  return file;
}

async function start(entry: string): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use('/api', createAgentRoutes(deps, { entry }));
  app.get('/api/other', (_req, res) => res.json({ ok: true }));
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}

describe('api/agent routes', () => {
  it('loads the runtime on the first request and mounts it under api/agent', async () => {
    const base = await start(writeStubEntry());
    const res = await fetch(`${base}/agent/agents`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agents: [], workspace: '/w' });
  });

  it('answers 404 when the engine has no agent runtime', async () => {
    const base = await start(path.join(tmp, 'missing', 'index.js'));
    const res = await fetch(`${base}/agent/agents`);
    expect(res.status).toBe(404);
    // Other routes are untouched.
    expect((await fetch(`${base}/other`)).status).toBe(200);
  });

  it('refuses requests a browser made from another site (Sec-Fetch-Site)', async () => {
    const base = await start(writeStubEntry());
    const get = (site?: string) => fetch(`${base}/agent/agents`, { headers: site ? { 'Sec-Fetch-Site': site } : {} });
    expect((await get('cross-site')).status).toBe(403);
    expect((await get('same-site')).status).toBe(403);
    expect((await get('none')).status).toBe(403);
    expect((await get('same-origin')).status).toBe(200);
    // The CLI and other non-browser clients send none.
    expect((await get()).status).toBe(200);
    // The check covers the routes of an engine with no runtime too.
    const missing = await fetch(`${base}/agent/anything`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    expect(missing.status).toBe(403);
  });

  it('looks for agent/dist/index.js beside server/dist', () => {
    expect(AGENT_ENTRY.endsWith(path.join('agent', 'dist', 'index.js'))).toBe(true);
  });
});

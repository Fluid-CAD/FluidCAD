import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createWorkspaceStateRouter,
  readWorkspaceConfiguration,
  readWorkspaceEditorState,
  rememberWorkspaceConfiguration,
  writeWorkspaceEditorState,
} from '../src/routes/workspace-state.ts';

// `.fluidcad/editor-state.json` holds the tab strip and, per model file, the
// configuration it was showing. Each writer keeps the other's fields.

let ws: string;
const stateFile = () => join(ws, '.fluidcad', 'editor-state.json');
const stored = () => JSON.parse(readFileSync(stateFile(), 'utf8'));

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'fluidcad-editor-state-'));
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe('workspace editor state — configurations', () => {
  it('round-trips the configurations map beside the tabs', () => {
    writeWorkspaceEditorState(ws, { openTabs: ['a.part.js'], activeTab: 'a.part.js', configurations: { 'frame.assembly.js': 'Wide' } });
    expect(readWorkspaceEditorState(ws)).toEqual({
      openTabs: ['a.part.js'], activeTab: 'a.part.js', configurations: { 'frame.assembly.js': 'Wide' },
    });
    expect(readWorkspaceConfiguration(ws, 'frame.assembly.js')).toBe('Wide');
    expect(readWorkspaceConfiguration(ws, 'other.assembly.js')).toBeNull();
  });

  it('remembers and forgets a file\'s row without touching the tabs; an empty map is left out', () => {
    writeWorkspaceEditorState(ws, { openTabs: ['frame.assembly.js'], activeTab: 'frame.assembly.js' });
    rememberWorkspaceConfiguration(ws, 'frame.assembly.js', 'Wide');
    rememberWorkspaceConfiguration(ws, 'lid.part.js', 'Thin');
    expect(stored()).toEqual({
      openTabs: ['frame.assembly.js'], activeTab: 'frame.assembly.js',
      configurations: { 'frame.assembly.js': 'Wide', 'lid.part.js': 'Thin' },
    });
    rememberWorkspaceConfiguration(ws, 'frame.assembly.js', null);
    expect(stored().configurations).toEqual({ 'lid.part.js': 'Thin' });
    rememberWorkspaceConfiguration(ws, 'lid.part.js', null);
    expect(stored()).toEqual({ openTabs: ['frame.assembly.js'], activeTab: 'frame.assembly.js' });
  });

  it('starts from nothing when the file is absent or malformed, and drops non-string entries', () => {
    expect(readWorkspaceConfiguration(ws, 'x.part.js')).toBeNull();
    rememberWorkspaceConfiguration(ws, 'x.part.js', 'A');
    expect(stored()).toEqual({ openTabs: [], activeTab: null, configurations: { 'x.part.js': 'A' } });

    mkdirSync(join(ws, '.fluidcad'), { recursive: true });
    writeFileSync(stateFile(), '{ not json');
    expect(readWorkspaceEditorState(ws)).toEqual({ openTabs: [], activeTab: null });

    writeFileSync(stateFile(), JSON.stringify({ openTabs: [], activeTab: null, configurations: { ok: 'Wide', bad: 3, empty: '' } }));
    expect(readWorkspaceEditorState(ws).configurations).toEqual({ ok: 'Wide' });
    writeFileSync(stateFile(), JSON.stringify({ openTabs: [], activeTab: null, configurations: ['Wide'] }));
    expect(readWorkspaceEditorState(ws).configurations).toBeUndefined();
  });
});

describe('POST /api/workspace/editor-state', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    // The router reads the workspace lazily through a getter-less closure: it
    // captures the path at creation, so every request of this suite shares
    // the one made in beforeEach via a redirecting closure.
    app.use('/api', (req, res, next) => createWorkspaceStateRouter(ws)(req, res, next));
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('the tab strip\'s write keeps the configurations the server remembered', async () => {
    rememberWorkspaceConfiguration(ws, 'frame.assembly.js', 'Wide');
    const res = await fetch(`${baseUrl}/api/workspace/editor-state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ openTabs: ['frame.assembly.js', 'lid.part.js'], activeTab: 'lid.part.js' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      openTabs: ['frame.assembly.js', 'lid.part.js'], activeTab: 'lid.part.js', configurations: { 'frame.assembly.js': 'Wide' },
    });
    expect(stored().configurations).toEqual({ 'frame.assembly.js': 'Wide' });
    const read = await (await fetch(`${baseUrl}/api/workspace/editor-state`)).json();
    expect(read.configurations).toEqual({ 'frame.assembly.js': 'Wide' });
  });
});

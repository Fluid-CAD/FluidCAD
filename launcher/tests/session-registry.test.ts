import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setBuiltinEngineLocation } from '../src/engine/cache';
import { listRecentProjects } from '../src/projects/app-state';
import { SessionRegistry } from '../src/server/session-registry';
import type { SessionView } from '../src/start/contract';
import { eventually, fakeEnginePid, processGone, setDirtyFiles, writeFakePackage } from './fake-package';

/**
 * The projects `npx fluidcad` has open, driven against a fake engine: a new
 * project is set up and started, an open project is closed only without
 * unsaved changes, a crashed engine comes back once on its own port, and
 * everything stops on the way out.
 */

let root: string;
let registry: SessionRegistry;
let views: { path: string; view: SessionView }[];
let changes: number;
/** The recents each `changed` call could see: a start screen re-reads them then. */
let recentsAtChange: string[][];
const savedEnv: Record<string, string | undefined> = {};

function lastView(workspace: string): SessionView | undefined {
  return [...views].reverse().find((entry) => entry.path === workspace)?.view;
}

async function running(workspace: string): Promise<Extract<SessionView, { phase: 'running' }>> {
  await eventually(() => lastView(workspace)?.phase === 'running' || lastView(workspace)?.phase === 'failed');
  const view = lastView(workspace)!;
  if (view.phase !== 'running') {
    throw new Error(`expected running, got ${JSON.stringify(view)}`);
  }
  return view;
}

function project(name: string): string {
  const dir = path.join(root, 'projects', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'init.js'), '');
  fs.writeFileSync(path.join(dir, 'part.part.js'), '');
  return dir;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-sessions-'));
  for (const key of ['FLUIDCAD_HOME', 'FLUIDCAD_BUILTIN_ENGINE', 'FAKE_ENGINE_FAIL']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.FLUIDCAD_HOME = path.join(root, 'home');
  writeFakePackage(path.join(root, 'package'), '0.0.50');
  setBuiltinEngineLocation({ kind: 'package', packageRoot: path.join(root, 'package') });
  views = [];
  changes = 0;
  recentsAtChange = [];
  registry = new SessionRegistry({
    onView: (workspacePath, view) => views.push({ path: workspacePath, view }),
    changed: () => {
      changes += 1;
      recentsAtChange.push(listRecentProjects().map((entry) => entry.path));
    },
    log: () => undefined,
  });
});

afterEach(async () => {
  await registry.shutdown();
  setBuiltinEngineLocation(null);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('SessionRegistry', () => {
  it('sets a new project up in a folder that does not exist yet, then runs it', async () => {
    const workspace = path.join(root, 'projects', 'bracket');
    fs.mkdirSync(path.dirname(workspace), { recursive: true });
    expect(registry.open(workspace, { create: true })).toMatchObject({ phase: 'opening', status: { step: 'creating' } });
    expect(registry.isOpen(workspace)).toBe(true);

    const view = await running(workspace);
    expect(view).toMatchObject({ project: { name: 'bracket' }, version: '0.0.50', source: 'builtin' });
    expect(view.url).toMatch(/^http:\/\/localhost:\d+$/);
    expect(JSON.parse(fs.readFileSync(path.join(workspace, 'fluidcad.json'), 'utf8')).engine).toBe('0.0.50');
    expect(views.map((entry) => entry.view.phase === 'opening' && entry.view.status.step)).toEqual(
      expect.arrayContaining(['creating', 'resolving', 'starting']),
    );
    expect(listRecentProjects().map((entry) => entry.path)).toEqual([workspace]);
    // A start screen told of the change once the project runs finds it among the recents.
    expect(recentsAtChange.at(-1)).toEqual([workspace]);
  });

  it('answers a second open of a running project with where it is, without a second engine', async () => {
    const workspace = project('lantern');
    registry.open(workspace);
    const first = await running(workspace);
    const pid = fakeEnginePid(workspace);
    expect(registry.open(workspace)).toMatchObject({ phase: 'running', url: first.url });
    expect(fakeEnginePid(workspace)).toBe(pid);
  });

  it('reports a failed start, and tries again on retry', async () => {
    const workspace = project('clamp');
    process.env.FAKE_ENGINE_FAIL = '1';
    registry.open(workspace);
    await eventually(() => lastView(workspace)?.phase === 'failed');
    expect(lastView(workspace)).toMatchObject({ phase: 'failed', message: 'The fake engine was told to fail.' });
    expect(registry.isOpen(workspace)).toBe(true);

    delete process.env.FAKE_ENGINE_FAIL;
    registry.retry(workspace);
    await running(workspace);
  });

  it('forgets a cancelled open, and says so', async () => {
    const workspace = project('fork');
    registry.open(workspace);
    registry.cancel(workspace);
    expect(registry.isOpen(workspace)).toBe(false);
    expect(lastView(workspace)).toMatchObject({ phase: 'closed', project: { name: 'fork' } });
  });

  it('refuses to close a project with unsaved changes, and closes it once they are saved', async () => {
    const workspace = project('gearbox');
    registry.open(workspace);
    await running(workspace);
    const pid = fakeEnginePid(workspace);

    setDirtyFiles(workspace, ['gearbox.part.js', 'parts/lid.part.js']);
    const refused = await registry.close(workspace);
    expect(refused.ok).toBe(false);
    expect(refused.error).toBe('gearbox has unsaved changes in gearbox.part.js, parts/lid.part.js. Save them in its tab, then close it.');
    expect(registry.isOpen(workspace)).toBe(true);

    setDirtyFiles(workspace, []);
    expect(await registry.close(workspace)).toEqual({ ok: true });
    expect(registry.isOpen(workspace)).toBe(false);
    expect(lastView(workspace)).toMatchObject({ phase: 'closed' });
    await processGone(pid);
  });

  it('starts a crashed engine again on its own port, but not a second time right away', async () => {
    const workspace = project('bicycle');
    registry.open(workspace);
    const before = await running(workspace);

    process.kill(fakeEnginePid(workspace), 'SIGKILL');
    await eventually(() => views.filter((entry) => entry.path === workspace && entry.view.phase === 'running').length === 2);
    expect(lastView(workspace)).toMatchObject({ phase: 'running', url: before.url });

    process.kill(fakeEnginePid(workspace), 'SIGKILL');
    await eventually(() => lastView(workspace)?.phase === 'failed');
    expect(lastView(workspace)).toMatchObject({ phase: 'failed', message: expect.stringContaining('stopped again') });

    // Opening it once more is the user's call, and works.
    registry.open(workspace);
    await running(workspace);
  });

  it('hands a pin change the running project, refusing while it has unsaved changes', async () => {
    const workspace = project('hinge');
    expect(registry.reopenTarget(workspace)).toBeNull();
    registry.open(workspace);
    await running(workspace);
    const target = registry.reopenTarget(workspace)!;

    setDirtyFiles(workspace, ['hinge.part.js']);
    await expect(target.confirmTeardown()).rejects.toThrow('Save them in its tab, then switch.');
    setDirtyFiles(workspace, []);
    await expect(target.confirmTeardown()).resolves.toBe(true);

    const pid = fakeEnginePid(workspace);
    await target.reopenProject();
    expect(registry.isOpen(workspace)).toBe(false);
    await processGone(pid);
  });

  it('stops every engine on shutdown, and opens nothing after', async () => {
    const a = project('a');
    const b = project('b');
    registry.open(a);
    registry.open(b);
    await running(a);
    await running(b);
    const pids = [fakeEnginePid(a), fakeEnginePid(b)];

    await registry.shutdown();
    await Promise.all(pids.map((pid) => processGone(pid)));
    expect(() => registry.open(a)).toThrow('FluidCAD is stopping.');
  });
});

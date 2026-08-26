import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createWorkspaceWatcher, type WorkspaceFileEvent, type WorkspaceWatcher } from '../../src/files/workspace-watcher.ts';

// External edits — an agent writing through MCP, a `git checkout` — have to
// reach the in-page editor, so the server announces them over the UI socket.

let workspace: string;
let watcher: WorkspaceWatcher | null;
let events: WorkspaceFileEvent[];

async function untilEvent(match: (e: WorkspaceFileEvent) => boolean, timeoutMs = 4000): Promise<WorkspaceFileEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = events.find(match);
    if (hit) {
      return hit;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`no matching event; saw ${JSON.stringify(events)}`);
}

/** Chokidar's initial scan is async; give it a beat before mutating files. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 400));
}

describe('workspace watcher', () => {
  beforeEach(async () => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-watch-')));
    events = [];
    watcher = createWorkspaceWatcher(workspace, (event) => { events.push(event); });
    await settle();
  });

  afterEach(async () => {
    await watcher?.close();
    watcher = null;
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('reports an added, changed and removed file with workspace-relative paths', async () => {
    const file = path.join(workspace, 'part.fluid.js');

    fs.writeFileSync(file, 'const a = 1;');
    const added = await untilEvent((e) => e.type === 'file-added');
    expect(added.path).toBe('part.fluid.js');
    expect(added.absPath).toBe(file);
    expect(added.kind).toBe('model');
    expect(typeof added.mtimeMs).toBe('number');

    events = [];
    fs.writeFileSync(file, 'const a = 2;');
    expect((await untilEvent((e) => e.type === 'file-changed')).path).toBe('part.fluid.js');

    events = [];
    fs.unlinkSync(file);
    const removed = await untilEvent((e) => e.type === 'file-removed');
    expect(removed.path).toBe('part.fluid.js');
    expect(removed.mtimeMs).toBeUndefined();
  });

  it('stays quiet for node_modules and gitignored paths', async () => {
    fs.writeFileSync(path.join(workspace, '.gitignore'), 'ignored/\n');
    await untilEvent((e) => e.path === '.gitignore');

    fs.mkdirSync(path.join(workspace, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'ignored'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'node_modules', 'dep.js'), '');
    fs.writeFileSync(path.join(workspace, 'ignored', 'out.js'), '');
    // A file that must come through, written last — once it lands, the ignored
    // writes have had at least as long to arrive and didn't.
    fs.writeFileSync(path.join(workspace, 'watched.fluid.js'), '');

    await untilEvent((e) => e.path === 'watched.fluid.js');
    expect(events.map((e) => e.path)).not.toContain('node_modules/dep.js');
    expect(events.map((e) => e.path)).not.toContain('ignored/out.js');
  });
});

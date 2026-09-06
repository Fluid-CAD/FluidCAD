import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FluidCadServer } from '../src/fluidcad-server.ts';
import type { SceneHost } from '../src/host/scene-host.ts';

// A raw-path render (the save-triggered `process-file`, the in-page host's
// file open) ran the file from disk but left the live-render overlay empty,
// so `getCurrentCode()` — what feature/parse, the edit preflight and the
// side-ref resolvers read — answered null until the editor's first
// live-update. The timeline's double-click refused with "No live code
// buffer" and only worked on the second try, after the breakpoint the first
// gesture inserted had pushed a live-update.

/** Mirrors LocalSceneHost's buffer contract: keyed by the live-render id. */
class FakeHost implements SceneHost {
  buffers = new Map<string, string>();

  async init(): Promise<void> {}

  async loadModule(): Promise<Record<string, any>> {
    return {};
  }

  setBuffer(id: string, code: string): void {
    this.buffers.set(id, code);
  }

  getBuffer(fileName: string): string | null {
    return this.buffers.get(`virtual:live-render:${fileName}`) ?? null;
  }

  invalidateModule(): void {}
}

const fakeSceneManager = () => ({
  startScene: () => ({ getRenderedObjects: () => [], getAllSceneObjects: () => [] }),
  startAssemblyScene: () => ({ getRenderedObjects: () => [], getAllSceneObjects: () => [] }),
  setCurrentFile: () => {},
  renderScene: () => {},
  compare: (_prev: any, next: any) => next,
  getAssemblyData: () => null,
});

let workspace: string;
let file: string;
let server: FluidCadServer;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-live-buffer-'));
  file = path.join(workspace, 'bracket.fluid.js');
  server = new FluidCadServer(new FakeHost());
  server.setSceneManager(fakeSceneManager() as any);
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('the current code after a raw-path render', () => {
  it('is the disk content the render ran, not null', async () => {
    fs.writeFileSync(file, 'const a = 1;\n');
    await server.processFile(file);
    expect(server.getCurrentCode()).toBe('const a = 1;\n');
  });

  it('keeps the editor buffer once a live-update has arrived', async () => {
    fs.writeFileSync(file, 'const a = 1;\n');
    await server.updateLiveCode(file, 'const a = 2;\n');
    // The save-triggered process-file serves the overlay, exactly as the
    // module loader does — disk must not clobber it.
    await server.processFile(file);
    expect(server.getCurrentCode()).toBe('const a = 2;\n');
  });

  it('is replaced by a later live-update', async () => {
    fs.writeFileSync(file, 'const a = 1;\n');
    await server.processFile(file);
    await server.updateLiveCode(file, 'const a = 3;\n');
    expect(server.getCurrentCode()).toBe('const a = 3;\n');
  });

  it('stays null when the file cannot be read', async () => {
    await server.processFile(path.join(workspace, 'missing.fluid.js'));
    expect(server.getCurrentCode()).toBeNull();
  });
});

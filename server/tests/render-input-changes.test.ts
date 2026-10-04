import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FluidCadServer } from '../src/fluidcad-server/index.ts';
import { LocalSceneHost } from '../src/host/local-scene-host.ts';
import { RenderInputChanges } from '../src/files/render-input-changes.ts';

// Saving a module the open model imports — a `*.feature.js`, a helper, at any
// depth — re-renders the model; the model's own edits and unrelated files
// don't. The rule reads the server's record of what the last render was
// built from (its fingerprint) and the module graph, over a real Vite host.

describe('RenderInputChanges', () => {
  function rule(behind: (absPath: string) => boolean) {
    const asked: string[] = [];
    let renders = 0;
    const changes = new RenderInputChanges({
      isRenderBehind: (absPath) => {
        asked.push(absPath);
        return behind(absPath);
      },
      rerender: async () => {
        renders++;
      },
      delayMs: 10_000,
    });
    return { changes, asked, renders: () => renders };
  }

  it('renders once for a burst of changes, when one of them left the render behind', async () => {
    const { changes, renders } = rule(absPath => absPath.endsWith('.feature.js'));
    changes.note('/ws/notes.md');
    changes.note('/ws/standoff.feature.js');
    changes.note('/ws/bracket.feature.js');
    expect(await changes.flush()).toBe(true);
    expect(renders()).toBe(1);
    // Nothing pending: the next window starts empty.
    expect(await changes.flush()).toBe(false);
    expect(renders()).toBe(1);
  });

  it('asks only when the window closes, and renders nothing for changes the render does not read', async () => {
    let behind = false;
    const { changes, asked, renders } = rule(() => behind);
    changes.note('/ws/helper.js');
    expect(asked).toEqual([]);
    behind = true;
    expect(await changes.flush()).toBe(true);
    expect(asked).toEqual(['/ws/helper.js']);

    behind = false;
    changes.note('/ws/helper.js');
    expect(await changes.flush()).toBe(false);
    expect(renders()).toBe(1);
  });

  it('closes the window on its own', async () => {
    let renders = 0;
    const changes = new RenderInputChanges({
      isRenderBehind: () => true,
      rerender: async () => {
        renders++;
      },
      delayMs: 5,
    });
    changes.note('/ws/standoff.feature.js');
    changes.note('/ws/standoff.feature.js');
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(renders).toBe(1);
    changes.dispose();
  });
});

/** The engine as the render path drives it, minus geometry: every scene is empty. */
function sceneManager() {
  const manager = {
    renders: 0,
    startScene: () => {
      manager.renders++;
      return { getRenderedObjects: () => [], getAllSceneObjects: () => [] };
    },
    startAssemblyScene: () => ({ getRenderedObjects: () => [], getAllSceneObjects: () => [] }),
    setCurrentFile: () => {},
    renderScene: () => {},
    compare: (_previous: unknown, next: unknown) => next,
    getAssemblyData: (): null => null,
  };
  return manager;
}

describe('FluidCadServer.isRenderBehind', () => {
  let root: string;
  let host: LocalSceneHost;
  let server: FluidCadServer;
  let manager: ReturnType<typeof sceneManager>;

  const at = (rel: string) => path.join(root, rel).replace(/\\/g, '/');
  const MODEL_CODE = [
    `import { HEIGHT } from './parts/plate.js';`,
    `export const height = HEIGHT;`,
    ``,
  ].join('\n');

  /** Write a file and move its mtime forward, so a same-tick rewrite still reads as a change. */
  function write(rel: string, content: string): void {
    const file = at(rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    const later = new Date(Date.now() + 2000 + Math.random() * 1000);
    fs.utimesSync(file, later, later);
  }

  /** Render the model the way a live update does, reporting a compile error the way index.ts does. */
  async function render(code = MODEL_CODE): Promise<boolean> {
    try {
      await server.updateLiveCode(at('model.part.js'), code);
      server.setCompileError(null);
      return true;
    } catch (err: any) {
      server.setCompileError({ message: err?.message ?? String(err), filePath: at('model.part.js') });
      return false;
    }
  }

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fluidcad-render-inputs-'));
    host = new LocalSceneHost();
    await host.init(root);
  });

  afterAll(async () => {
    await host?.server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    write('standoff.feature.js', `export const STANDOFF = { height: 10 };\n`);
    write('parts/plate.js', `import { STANDOFF } from '../standoff.feature.js';\nexport const HEIGHT = STANDOFF.height + 3;\n`);
    write('notes.js', `export const unrelated = 1;\n`);
    fs.rmSync(at('later.feature.js'), { force: true });
    write('model.part.js', MODEL_CODE);
    server = new FluidCadServer(host);
    manager = sceneManager();
    server.setSceneManager(manager as any);
  });

  it('answers false with no model open', () => {
    expect(server.isRenderBehind(at('standoff.feature.js'))).toBe(false);
  });

  it('is behind once a module the model imports, at any depth, changes', async () => {
    expect(await render()).toBe(true);
    expect(server.isRenderBehind(at('standoff.feature.js'))).toBe(false);

    write('standoff.feature.js', `export const STANDOFF = { height: 12 };\n`);
    expect(server.isRenderBehind(at('standoff.feature.js'))).toBe(true);
    // The model's own edits arrive through its host; unrelated files never count.
    expect(server.isRenderBehind(at('model.part.js'))).toBe(false);
    expect(server.isRenderBehind(at('notes.js'))).toBe(false);

    // The same buffer renders again, built from the new module.
    const before = manager.renders;
    expect(await render()).toBe(true);
    expect(manager.renders).toBe(before + 1);
    expect(server.isRenderBehind(at('standoff.feature.js'))).toBe(false);

    write('parts/plate.js', `import { STANDOFF } from '../standoff.feature.js';\nexport const HEIGHT = STANDOFF.height + 4;\n`);
    expect(server.isRenderBehind(at('parts/plate.js'))).toBe(true);
  });

  it('is not behind for a write that leaves the content as it was', async () => {
    expect(await render()).toBe(true);
    write('standoff.feature.js', `export const STANDOFF = { height: 10 };\n`);
    expect(server.isRenderBehind(at('standoff.feature.js'))).toBe(false);
  });

  it('keeps watching a module that broke the render, so fixing it renders again', async () => {
    expect(await render()).toBe(true);
    write('standoff.feature.js', `export const STANDOFF = { height: ;\n`);
    expect(server.isRenderBehind(at('standoff.feature.js'))).toBe(true);
    expect(await render()).toBe(false);

    write('standoff.feature.js', `export const STANDOFF = { height: 14 };\n`);
    expect(server.isRenderBehind(at('standoff.feature.js'))).toBe(true);
    expect(await render()).toBe(true);
    expect(server.isRenderBehind(at('standoff.feature.js'))).toBe(false);
  });

  it('retries a model that does not compile when any workspace script appears or changes', async () => {
    const importsLater = `import { LATER } from './later.feature.js';\nexport const later = LATER;\n`;
    expect(await render(importsLater)).toBe(false);
    write('later.feature.js', `export const LATER = 1;\n`);
    expect(server.isRenderBehind(at('later.feature.js'))).toBe(true);
    expect(server.isRenderBehind(at('readme.md'))).toBe(false);
    expect(await render(importsLater)).toBe(true);
    expect(server.isRenderBehind(at('notes.js'))).toBe(false);
  });

  it('drives one re-render through the rule for a saved feature module', async () => {
    expect(await render()).toBe(true);
    const changes = new RenderInputChanges({
      isRenderBehind: (absPath) => server.isRenderBehind(absPath),
      rerender: async () => {
        await render();
      },
      delayMs: 10_000,
    });
    write('standoff.feature.js', `export const STANDOFF = { height: 16 };\n`);
    changes.note(at('notes.js'));
    changes.note(at('standoff.feature.js'));
    changes.note(at('model.part.js'));
    const before = manager.renders;
    expect(await changes.flush()).toBe(true);
    expect(manager.renders).toBe(before + 1);

    changes.note(at('standoff.feature.js'));
    expect(await changes.flush()).toBe(false);
    changes.dispose();
  });
});

import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'http';
import { setupOC, render } from '../../lib/tests/setup.js';
import { getSceneManager } from '../../lib/scene-manager.js';
import sketch from '../../lib/core/sketch.js';
import extrude from '../../lib/core/extrude.js';
import { testRect } from '../../lib/tests/helpers/profiles.js';
import { getOC } from '../../lib/oc/init.js';
import { KernelTraps } from '../../lib/oc/kernel-traps.js';
import { Feature, defineFeature } from '../../lib/sdk/index.js';
import type { Shape } from '../../lib/sdk/kernel.js';
import type { SceneObject } from '../../lib/common/scene-object.js';
import { FluidCadServer } from '../src/fluidcad-server/index.ts';
import { EngineHealth, type FeatureDisclosure } from '../src/engine-health.ts';
import { createEngineRouter } from '../src/routes/engine.ts';
import type { ServerToUIMessage, UIEngineSuspectMessage } from '../src/ws-protocol.ts';

// The crash guard, server side: a trap of the OpenCascade kernel fails its
// statement's row (the kernel's part), marks the engine suspect, tells every
// page — now and on connect — and names raw OpenCascade on the row when the
// statement's feature reaches it. The process lives on.

/** A feature whose raw code reads through a pointer to memory that isn't there: the deliberate trap. */
function defineDangling() {
  class Dangling extends Feature.with({ face: { picker: 'face' } }) {
    static id = 'acme.dangling';
    buildTool(): Shape[] {
      // Past the end of any 32-bit wasm heap: the read traps before it can touch anything.
      getOC().OCJS.getStandard_FailureData(0xFFFFFFFD);
      return [];
    }
  }
  return defineFeature(Dangling, { label: 'Dangling pointer', group: 'create', call: ['face'] });
}

/** What the catalog would say: the dangling feature reaches raw OpenCascade, nothing else is listed. */
async function catalog(type: string): Promise<FeatureDisclosure | null> {
  return type === 'acme.dangling' ? { label: 'Dangling pointer', usesOcct: true } : null;
}

const RAW_NOTE = '\nDangling pointer 1 uses raw OpenCascade (fluidcad/sdk/occt) — the likeliest cause: its code freed, or reached past, '
  + 'memory the engine still needed.';

let stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) {
    stop();
  }
});

function healthWatching(restart: ConstructorParameters<typeof EngineHealth>[0]['restart'] = { kind: 'none' }) {
  const sent: ServerToUIMessage[] = [];
  const health = new EngineHealth({ broadcast: msg => sent.push(msg), feature: catalog, restart });
  stops.push(health.watch(KernelTraps));
  return { health, sent };
}

/** A 20 × 20 × 10 plate, the deliberate trap on its top face, and a second plate on the plate. */
function renderTrap() {
  sketch('xy', () => {
    testRect(20, 20, { at: [-10, -10] });
  });
  const plate = extrude(10) as unknown as { endFaces(): never };
  const bad = defineDangling()(plate.endFaces()) as unknown as SceneObject;
  sketch('xy', () => {
    testRect(4, 4, { at: [30, 30] });
  });
  extrude(4);
  const scene = render();
  const result = scene.getRenderedObjects() as any[];
  return { scene, bad, data: { result, objectErrors: FluidCadServer.collectObjectErrors(result) } };
}

describe('the engine after its kernel trapped', () => {
  setupOC();

  it('fails the statement on its row, naming raw OpenCascade, and marks the engine suspect — the process lives on', async () => {
    const { health, sent } = healthWatching();
    const { bad, data } = renderTrap();

    const index = data.result.findIndex(row => row.id === bad.id);
    const row = data.result[index];
    expect(row).toMatchObject({ type: 'acme.dangling', hasError: true, kernelTrap: true });
    expect(data.objectErrors).toEqual([expect.objectContaining({ index, message: row.errorMessage })]);
    const kernelMessage = row.errorMessage;

    await health.explain(data);
    expect(row.errorMessage).toBe(kernelMessage + RAW_NOTE);
    expect(data.objectErrors[0].message).toBe(kernelMessage + RAW_NOTE);
    // A render served again from the cache carries its rows as they were.
    await health.explain(data);
    expect(row.errorMessage).toBe(kernelMessage + RAW_NOTE);

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const suspect: UIEngineSuspectMessage = {
      type: 'engine-suspect',
      message: 'Dangling pointer crashed the OpenCascade kernel (memory access out of bounds). Dangling pointer uses raw '
        + 'OpenCascade (fluidcad/sdk/occt), the likeliest cause. The engine\'s memory may be damaged: restart it before you trust what it builds.',
      featureType: 'acme.dangling',
      featureName: 'Dangling pointer',
      usesOcct: true,
      traps: 1,
      restart: null,
      hint: 'Restart the engine: close the project and open it again, or restart the command that serves this page.',
    };
    expect(sent[0]).toEqual(suspect);
    expect(health.suspect).toEqual(suspect);

    // A page that connects later hears it too.
    const replayed: ServerToUIMessage[] = [];
    health.replay(msg => replayed.push(msg));
    expect(replayed).toEqual([suspect]);

    // The rest of the model built, and the next render runs.
    expect(data.result.filter(r => r.hasError)).toHaveLength(1);
    getSceneManager().startScene();
    sketch('xy', () => {
      testRect(10, 10);
    });
    extrude(5);
    expect(render().getAllSceneObjects().filter(o => o.getError())).toEqual([]);
  });

  it('counts the traps that follow the first, and says how this host restarts', async () => {
    const { health, sent } = healthWatching();
    renderTrap();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    getSceneManager().startScene();
    renderTrap();
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ featureType: 'acme.dangling', traps: 2 });

    health.noteEditor('neovim');
    expect(sent[2]).toMatchObject({ traps: 2, restart: null, hint: 'Restart the engine: run :FluidCadStop, then :FluidCadStart, in Neovim.' });
    health.noteEditor('vscode');
    expect(health.suspect?.hint).toBe('Restart the engine: run "Developer: Reload Window" in VS Code.');
  });

  it('offers the restart when the engine\'s host restarts it on an exit code', async () => {
    expect(EngineHealth.restartFromEnv({ [EngineHealth.RESTART_EXIT_CODE_ENV]: '75' })).toEqual({ kind: 'exit', exitCode: 75 });
    expect(EngineHealth.restartFromEnv({})).toEqual({ kind: 'none' });
    expect(EngineHealth.restartFromEnv({ [EngineHealth.RESTART_EXIT_CODE_ENV]: 'soon' })).toEqual({ kind: 'none' });

    const { sent } = healthWatching({ kind: 'exit', exitCode: 75 });
    renderTrap();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ restart: 'engine', hint: null });
  });

  it('leaves the row of a built-in statement as the kernel wrote it, and tells a trap from an ordinary error out of a render', async () => {
    const { health, sent } = healthWatching();
    const row = { type: 'extrude', name: 'Extrude', hasError: true, kernelTrap: true, errorMessage: 'Extrude crashed the OpenCascade kernel (unreachable).' };
    await health.explain({ result: [row] });
    expect(row.errorMessage).toBe('Extrude crashed the OpenCascade kernel (unreachable).');

    expect(health.noteError(new Error('Unexpected token'), KernelTraps)).toBe(false);
    expect(health.noteError(new WebAssembly.RuntimeError('unreachable'), KernelTraps)).toBe(true);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      message: 'The OpenCascade kernel crashed (unreachable). The engine\'s memory may be damaged: restart it before you trust what it builds.',
      featureType: null,
      usesOcct: false,
    });
  });
});

describe('POST /api/engine/restart', () => {
  function listen(app: express.Express): Promise<{ server: http.Server; baseUrl: string }> {
    const created = http.createServer(app);
    return new Promise((resolve) => {
      created.listen(0, '127.0.0.1', () => {
        const addr = created.address();
        resolve({ server: created, baseUrl: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}` });
      });
    });
  }

  async function restart(health: EngineHealth, exit: (code: number) => void) {
    const app = express();
    app.use('/api', createEngineRouter(health, { exit, exitDelayMs: 0 }));
    const { server, baseUrl } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/api/engine/restart`, { method: 'POST' });
      return { status: res.status, body: await res.json() };
    } finally {
      server.close();
    }
  }

  it('ends the engine with its host\'s restart code once the answer has left', async () => {
    const exits: number[] = [];
    const health = new EngineHealth({ broadcast: () => {}, feature: catalog, restart: { kind: 'exit', exitCode: 75 } });
    expect(await restart(health, code => exits.push(code))).toEqual({ status: 200, body: { restarting: true } });
    await vi.waitFor(() => expect(exits).toEqual([75]));
  });

  it('refuses where the engine can\'t restart itself, saying how to', async () => {
    const exits: number[] = [];
    const health = new EngineHealth({ broadcast: () => {}, feature: catalog, restart: { kind: 'none' } });
    health.noteEditor('neovim');
    expect(await restart(health, code => exits.push(code))).toEqual({
      status: 409,
      body: { error: 'This engine can\'t restart itself. Restart the engine: run :FluidCadStop, then :FluidCadStart, in Neovim.' },
    });
    expect(exits).toEqual([]);
  });
});

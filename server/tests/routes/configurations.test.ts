import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createConfigurationsRouter } from '../../src/routes/configurations.ts';
import { createApplyFeatureRouter } from '../../src/routes/apply-feature/index.ts';
import { FeatureEditDispatcher } from '../../src/edit-dispatch.ts';
import type { FluidCadServer } from '../../src/fluidcad-server/index.ts';

// `GET /api/configurations` answers the current file's table and active row;
// `POST /api/configurations/select` switches the session and re-renders,
// fanning the render out the way `/set-param` does. The row edits
// (`/add`, `/save`, `/rename`, `/remove`) rewrite the `configurations()`
// statement through the acked apply-feature round trip — the fake editor
// below plays the host — and then move the session. The engine is stubbed;
// the session semantics are covered in ../configurations-session.test.ts.

const FILE = '/ws/frame.assembly.js';

const TABLE_CODE = [
  `import { assembly, configurations, param } from 'fluidcad/core';`,
  `export const frame = assembly('Frame', () => {`,
  `  const configuration = configurations({`,
  `    Compact: { Width: 500 },`,
  `    Wide: { Width: 1200 },`,
  `  });`,
  `  const width = param('Width', 700);`,
  `  const depth = param('Depth', 400);`,
  `});`,
  ``,
].join('\n');

const BARE_CODE = [
  `import { assembly, param } from 'fluidcad/core';`,
  `export const frame = assembly('Frame', () => {`,
  `  const width = param('Width', 700);`,
  `  const depth = param('Depth', 400);`,
  `});`,
  ``,
].join('\n');

let server: http.Server;
let baseUrl: string;
let currentFile: string;
let buffer: string;
let selected: [string, string][];
let restored: [string, Record<string, unknown>][];
let overrides: Record<string, unknown>;
let active: string;
let names: string[];
let rows: Record<string, Record<string, unknown>>;
let definitions: { label: string; kind: string; defaultValue: unknown; currentValue: unknown }[];
let recomputes: number;
let relayed: any[];
let broadcast: any[];

function summary() {
  return { active, names, rows, modified: Object.keys(overrides).length > 0 };
}

const engine = {
  getCurrentFileName: () => currentFile,
  getCurrentCode: () => buffer,
  getLiveBuffer: (filePath: string) => (filePath === currentFile ? buffer : null),
  getConfigurations: () => summary(),
  selectConfiguration: (sessionId: string, name: string) => {
    selected.push([sessionId, name]);
    overrides = {};
  },
  restoreParamOverrides: (sessionId: string, record: Record<string, unknown>) => {
    restored.push([sessionId, { ...record }]);
    overrides = { ...record };
  },
  getParamOverrides: () => ({ ...overrides }),
  getParamDefinitions: () => definitions,
  recomputeCurrentFile: async () => {
    recomputes++;
    return {
      absPath: currentFile,
      sceneKind: 'assembly',
      unit: 'mm',
      declaredUnit: null,
      projectUnit: 'mm',
      result: [{ name: 'frame' }],
      rollbackStop: 0,
      params: [{ label: 'Width', kind: 'assembly', defaultValue: 700, currentValue: 1200, configuredValue: 1200, controlType: 'number' }],
      configurations: summary(),
      objectErrors: [],
      objectWarnings: [],
    };
  },
} as unknown as FluidCadServer;

async function get(path: string) {
  const res = await fetch(`${baseUrl}/api${path}`);
  return { status: res.status, body: await res.json() };
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** Play the editor host: apply each relayed spec to the buffer and ack it, until `pending` settles. */
async function actAsEditor(pending: Promise<{ status: number; body: any }>): Promise<{ status: number; body: any }> {
  let done = false;
  const settled = pending.then((value) => {
    done = true;
    return value;
  });
  let handled = 0;
  while (!done) {
    const msg = relayed.filter((m) => m.type === 'apply-feature-edit')[handled];
    if (!msg) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      continue;
    }
    handled++;
    const res = await fetch(`${baseUrl}/api/code/apply-feature`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: buffer, spec: msg.spec }),
    });
    const result = await res.json();
    if (typeof result.newCode === 'string' && !result.error) {
      buffer = result.newCode;
    }
  }
  return settled;
}

describe('configuration routes', () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    const send = (msg: any) => {
      relayed.push(msg);
      return true;
    };
    const dispatcher = new FeatureEditDispatcher(engine, send, { ackTimeoutMs: 500 });
    app.use('/api', createConfigurationsRouter(engine, send, (msg) => broadcast.push(msg), dispatcher));
    app.use('/api', createApplyFeatureRouter(engine, send, { dispatcher }));
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    currentFile = FILE;
    buffer = TABLE_CODE;
    selected = [];
    restored = [];
    overrides = {};
    active = 'Wide';
    names = ['Compact', 'Wide'];
    rows = { Compact: { Width: 500 }, Wide: { Width: 1200 } };
    definitions = [
      { label: 'Width', kind: 'assembly', defaultValue: 700, currentValue: 1200 },
      { label: 'Depth', kind: 'assembly', defaultValue: 400, currentValue: 400 },
    ];
    recomputes = 0;
    relayed = [];
    broadcast = [];
  });

  it('GET answers the current file\'s summary', async () => {
    const { status, body } = await get('/configurations');
    expect(status).toBe(200);
    expect(body).toEqual({ active: 'Wide', names: ['Compact', 'Wide'], rows, modified: false });
  });

  it('GET with no scene answers Default and no rows', async () => {
    currentFile = '';
    const { status, body } = await get('/configurations');
    expect(status).toBe(200);
    expect(body).toEqual({ active: 'Default', names: [], rows: {}, modified: false });
  });

  it('select switches the session, re-renders, broadcasts the render with its configurations and answers the summary', async () => {
    const { status, body } = await post('/configurations/select', { name: 'Wide' });
    expect(status).toBe(200);
    expect(body).toEqual({ success: true, configurations: summary() });
    expect(selected).toEqual([[FILE, 'Wide']]);
    expect(recomputes).toBe(1);
    expect(broadcast).toHaveLength(1);
    expect(broadcast[0]).toMatchObject({
      type: 'scene-rendered',
      absPath: FILE,
      sceneKind: 'assembly',
      unit: 'mm',
      configurations: summary(),
    });
    expect(broadcast[0].params[0]).toMatchObject({ label: 'Width', currentValue: 1200, configuredValue: 1200 });
    expect(relayed).toHaveLength(1);
    expect(relayed[0]).toMatchObject({ type: 'scene-rendered', absPath: FILE });
  });

  it.each([{}, { name: '' }, { name: '   ' }, { name: 3 }])('select refuses %j', async (payload) => {
    const { status, body } = await post('/configurations/select', payload);
    expect(status).toBe(400);
    expect(body.error).toContain('name');
    expect(selected).toEqual([]);
    expect(recomputes).toBe(0);
  });

  it('select with no scene is a 404 and selects nothing', async () => {
    currentFile = '';
    const { status, body } = await post('/configurations/select', { name: 'Wide' });
    expect(status).toBe(404);
    expect(body.error).toBe('No active scene');
    expect(selected).toEqual([]);
  });

  describe('add', () => {
    it('derives the row from the render — every label whose value differs from its literal — and selects it', async () => {
      overrides = { Depth: 650 };
      definitions[1].currentValue = 650;
      const result = await actAsEditor(post('/configurations/add', { name: 'Deep' }));
      expect(result.status).toBe(200);
      expect(relayed[0].spec.configurationEdit).toEqual({ kind: 'add', name: 'Deep', values: { Width: 1200, Depth: 650 } });
      expect(buffer).toContain(`    Wide: { Width: 1200 },\n    Deep: { Width: 1200, Depth: 650 },\n  });`);
      expect(selected).toEqual([[FILE, 'Deep']]);
      expect(result.body).toEqual({
        success: true,
        configurations: {
          active: 'Deep',
          names: ['Compact', 'Wide', 'Deep'],
          rows: { ...rows, Deep: { Width: 1200, Depth: 650 } },
          modified: false,
        },
      });
      // The edit landed and the host's save re-renders: no recompute of a stale buffer here.
      expect(recomputes).toBe(0);
    });

    it('skips global parameters and writes an empty row on an untouched Default', async () => {
      active = 'Default';
      definitions = [
        { label: 'Width', kind: 'assembly', defaultValue: 700, currentValue: 700 },
        { label: 'Wall', kind: 'global', defaultValue: 3, currentValue: 5 },
      ];
      const result = await actAsEditor(post('/configurations/add', { name: 'Copy' }));
      expect(result.status).toBe(200);
      expect(relayed[0].spec.configurationEdit).toEqual({ kind: 'add', name: 'Copy', values: {} });
      expect(buffer).toContain(`    Copy: {},\n  });`);
    });

    it('takes explicit values, creating the statement and its import in a file without a table', async () => {
      buffer = BARE_CODE;
      active = 'Default';
      names = [];
      rows = {};
      const result = await actAsEditor(post('/configurations/add', { name: 'Wide', values: { Width: 1200, Lid: { expr: 'hasLid' } } }));
      expect(result.status).toBe(200);
      expect(buffer).toContain(`import { configurations, assembly, param } from 'fluidcad/core';`);
      expect(buffer).toContain(`  const configuration = configurations({\n    Wide: { Width: 1200, Lid: hasLid },\n  });\n  const width`);
      expect(result.body.configurations).toEqual({
        active: 'Wide', names: ['Wide'], rows: { Wide: { Width: 1200, Lid: 'hasLid' } }, modified: false,
      });
      expect(selected).toEqual([[FILE, 'Wide']]);
    });

    it('400s with the editor\'s refusal — a duplicate or reserved name — before the editor is touched', async () => {
      let result = await post('/configurations/add', { name: 'Wide' });
      expect(result.status).toBe(400);
      expect(result.body.error).toBe('a configuration named "Wide" already exists');
      result = await post('/configurations/add', { name: 'Default' });
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('reserved');
      result = await post('/configurations/add', { name: 'X', values: { Width: { bad: true } } });
      expect(result.status).toBe(400);
      expect(result.body.error).toContain("'Width'");
      result = await post('/configurations/add', { name: 'X', values: [1] });
      expect(result.status).toBe(400);
      expect(relayed).toEqual([]);
      expect(selected).toEqual([]);
    });

    it.each([{}, { name: '' }, { name: 4 }])('add refuses %j', async (payload) => {
      const { status, body } = await post('/configurations/add', payload);
      expect(status).toBe(400);
      expect(body.error).toContain('name');
    });

    it('404s with no scene', async () => {
      currentFile = '';
      const { status } = await post('/configurations/add', { name: 'Deep' });
      expect(status).toBe(404);
    });
  });

  describe('save', () => {
    it('writes the touched labels into the active row and clears the session layer', async () => {
      overrides = { Width: 1300, Depth: 650 };
      const result = await actAsEditor(post('/configurations/save', {}));
      expect(result.status).toBe(200);
      expect(relayed[0].spec.configurationEdit).toEqual({ kind: 'set', name: 'Wide', values: { Width: 1300, Depth: 650 } });
      expect(buffer).toContain(`    Wide: { Width: 1300, Depth: 650 },`);
      expect(buffer).toContain(`    Compact: { Width: 500 },`);
      expect(selected).toEqual([[FILE, 'Wide']]);
      expect(overrides).toEqual({});
      expect(result.body).toEqual({
        success: true,
        configurations: {
          active: 'Wide',
          names: ['Compact', 'Wide'],
          rows: { Compact: { Width: 500 }, Wide: { Width: 1300, Depth: 650 } },
          modified: false,
        },
      });
    });

    it('takes explicit values', async () => {
      const result = await actAsEditor(post('/configurations/save', { values: { Depth: 900 } }));
      expect(result.status).toBe(200);
      expect(buffer).toContain(`    Wide: { Width: 1200, Depth: 900 },`);
    });

    it('refuses on Default', async () => {
      active = 'Default';
      overrides = { Width: 1300 };
      const { status, body } = await post('/configurations/save', {});
      expect(status).toBe(400);
      expect(body.error).toContain('Default');
      expect(relayed).toEqual([]);
      expect(selected).toEqual([]);
    });

    it('refuses with nothing touched', async () => {
      const { status, body } = await post('/configurations/save', {});
      expect(status).toBe(400);
      expect(body.error).toContain('Nothing to save');
      expect(relayed).toEqual([]);
    });
  });

  describe('rename', () => {
    it('renames the row; the active name follows with its tweaks', async () => {
      overrides = { Depth: 650 };
      const result = await actAsEditor(post('/configurations/rename', { from: 'Wide', to: 'Broad' }));
      expect(result.status).toBe(200);
      expect(relayed[0].spec.configurationEdit).toEqual({ kind: 'rename', from: 'Wide', to: 'Broad' });
      expect(buffer).toContain(`    Broad: { Width: 1200 },`);
      expect(selected).toEqual([[FILE, 'Broad']]);
      expect(restored).toEqual([[FILE, { Depth: 650 }]]);
      expect(result.body).toEqual({
        success: true,
        configurations: {
          active: 'Broad',
          names: ['Compact', 'Broad'],
          rows: { Compact: { Width: 500 }, Broad: { Width: 1200 } },
          modified: true,
        },
      });
    });

    it('leaves the session alone when another row is renamed', async () => {
      const result = await actAsEditor(post('/configurations/rename', { from: 'Compact', to: 'Small' }));
      expect(result.status).toBe(200);
      expect(buffer).toContain(`    Small: { Width: 500 },`);
      expect(selected).toEqual([]);
      expect(result.body.configurations).toMatchObject({ active: 'Wide', names: ['Small', 'Wide'] });
    });

    it('400s an unknown row, a taken name and a malformed body', async () => {
      let result = await post('/configurations/rename', { from: 'Huge', to: 'Broad' });
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('no configuration named "Huge"');
      result = await post('/configurations/rename', { from: 'Wide', to: 'Compact' });
      expect(result.status).toBe(400);
      expect(result.body.error).toBe('a configuration named "Compact" already exists');
      result = await post('/configurations/rename', { from: 'Wide' });
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('to');
      expect(relayed).toEqual([]);
    });
  });

  describe('remove', () => {
    it('removes the active row and goes back to Default', async () => {
      const result = await actAsEditor(post('/configurations/remove', { name: 'Wide' }));
      expect(result.status).toBe(200);
      expect(relayed[0].spec.configurationEdit).toEqual({ kind: 'remove', name: 'Wide' });
      expect(buffer).not.toContain('Wide');
      expect(buffer).toContain(`    Compact: { Width: 500 },\n  });`);
      expect(selected).toEqual([[FILE, 'Default']]);
      expect(result.body).toEqual({
        success: true,
        configurations: { active: 'Default', names: ['Compact'], rows: { Compact: { Width: 500 } }, modified: false },
      });
    });

    it('removes another row without moving the session', async () => {
      overrides = { Depth: 650 };
      const result = await actAsEditor(post('/configurations/remove', { name: 'Compact' }));
      expect(result.status).toBe(200);
      expect(selected).toEqual([]);
      expect(result.body.configurations).toEqual({ active: 'Wide', names: ['Wide'], rows: { Wide: { Width: 1200 } }, modified: true });
    });

    it('400s an unknown row', async () => {
      const { status, body } = await post('/configurations/remove', { name: 'Huge' });
      expect(status).toBe(400);
      expect(body.error).toContain('no configuration named "Huge"');
      expect(relayed).toEqual([]);
    });
  });
  describe('table', () => {
    it('GET answers the live code\'s table, expression cells by their text', async () => {
      buffer = TABLE_CODE.replace('Compact: { Width: 500 }', 'Compact: { Width: base / 2, Depth: 300 }');
      const { status, body } = await get('/configurations/table');
      expect(status).toBe(200);
      expect(body).toEqual({
        table: {
          line: 3,
          rows: {
            Compact: { Width: { text: 'base / 2' }, Depth: { literal: 300, text: '300' } },
            Wide: { Width: { literal: 1200, text: '1200' } },
          },
        },
      });
    });

    it('GET answers a null table without one, and 404s with no scene', async () => {
      buffer = BARE_CODE;
      expect(await get('/configurations/table')).toEqual({ status: 200, body: { table: null } });
      currentFile = '';
      expect((await get('/configurations/table')).status).toBe(404);
    });

    it('commits renames, sets, unsets and a new row as one edit; the active name follows', async () => {
      overrides = { Depth: 650 };
      const result = await actAsEditor(post('/configurations/table', {
        renames: { Wide: 'Broad' },
        rows: { Broad: { Width: 1300, Depth: 800 }, Compact: { Width: null }, Tall: { Depth: 900 } },
      }));
      expect(result.status).toBe(200);
      expect(relayed.filter((m) => m.type === 'apply-feature-edit')).toHaveLength(1);
      expect(relayed[0].spec.configurationEdit).toEqual({
        kind: 'table',
        renames: { Wide: 'Broad' },
        rows: { Broad: { Width: 1300, Depth: 800 }, Compact: { Width: null }, Tall: { Depth: 900 } },
      });
      expect(buffer).toContain([
        `  const configuration = configurations({`,
        `    Compact: {},`,
        `    Broad: { Width: 1300, Depth: 800 },`,
        `    Tall: { Depth: 900 },`,
        `  });`,
      ].join('\n'));
      expect(selected).toEqual([[FILE, 'Broad']]);
      expect(restored).toEqual([[FILE, { Depth: 650 }]]);
      expect(result.body).toEqual({
        success: true,
        configurations: {
          active: 'Broad',
          names: ['Compact', 'Broad', 'Tall'],
          rows: { Compact: {}, Broad: { Width: 1300, Depth: 800 }, Tall: { Depth: 900 } },
          modified: true,
        },
      });
    });

    it('removes the active row and goes back to Default', async () => {
      const result = await actAsEditor(post('/configurations/table', { rows: {}, removed: ['Wide'] }));
      expect(result.status).toBe(200);
      expect(buffer).not.toContain('Wide');
      expect(selected).toEqual([[FILE, 'Default']]);
      expect(result.body.configurations).toEqual({
        active: 'Default', names: ['Compact'], rows: { Compact: { Width: 500 } }, modified: false,
      });
    });

    it('400s with the editor\'s refusal before the editor is touched', async () => {
      let result = await post('/configurations/table', { rows: {}, renames: { Wide: 'Compact' } });
      expect(result.status).toBe(400);
      expect(result.body.error).toBe('a configuration named "Compact" already exists');
      result = await post('/configurations/table', { rows: {}, removed: ['Huge'] });
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('no configuration named "Huge"');
      result = await post('/configurations/table', { rows: { Default: { Width: 1 } } });
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('reserved');
      expect(relayed).toEqual([]);
      expect(selected).toEqual([]);
    });

    it.each([
      [{}, 'rows'],
      [{ rows: [] }, 'rows'],
      [{ rows: { Wide: 3 } }, 'rows["Wide"]'],
      [{ rows: { Wide: { Width: { bad: true } } } }, "'Width'"],
      [{ rows: {}, renames: { Wide: 3 } }, 'renames'],
      [{ rows: {}, removed: 'Wide' }, 'removed'],
    ])('400s a malformed body %j', async (payload, message) => {
      const { status, body } = await post('/configurations/table', payload);
      expect(status).toBe(400);
      expect(body.error).toContain(message);
      expect(relayed).toEqual([]);
    });

    it('404s with no scene', async () => {
      currentFile = '';
      const { status } = await post('/configurations/table', { rows: {} });
      expect(status).toBe(404);
    });
  });
});

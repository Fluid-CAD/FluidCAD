import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createConfigurationsRouter } from '../../src/routes/configurations.ts';
import { createApplyFeatureRouter } from '../../src/routes/apply-feature/index.ts';
import { FeatureEditDispatcher } from '../../src/edit-dispatch.ts';
import type { FluidCadServer } from '../../src/fluidcad-server/index.ts';
import { ParamKey } from '../../../lib/dist/index.js';

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
/** The render's tables per body — left undefined by the assembly cases, as a server predating them answered. */
let tables: { body: string; names: string[]; rows: Record<string, Record<string, unknown>> }[] | undefined;
let definitions: {
  label: string;
  kind: string;
  defaultValue: unknown;
  currentValue: unknown;
  body?: string;
  part?: { filePath: string; line: number; column: number };
}[];
let recomputes: number;
let relayed: any[];
let broadcast: any[];

function summary() {
  return { active, names, rows, ...(tables ? { tables } : {}), modified: Object.keys(overrides).length > 0 };
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
  getParamOverrideEntries: () => Object.entries(overrides).map(([id, value]) => ({ key: ParamKey.parse(id), value })),
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
    tables = undefined;
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
      expect(relayed[0].spec.configurationEdit).toEqual({ kind: 'add', name: 'Deep', bodies: [{ values: { Width: 1200, Depth: 650 } }] });
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
      expect(relayed[0].spec.configurationEdit).toEqual({ kind: 'add', name: 'Copy', bodies: [] });
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
      expect(relayed[0].spec.configurationEdit).toEqual({ kind: 'set', name: 'Wide', bodies: [{ values: { Width: 1300, Depth: 650 } }] });
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
      expect(body.error).toContain('or Duplicate… to make a new one');
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
        tables: [{
          body: 'Frame',
          line: 3,
          rows: {
            Compact: { Width: { text: 'base / 2' }, Depth: { literal: 300, text: '300' } },
            Wide: { Width: { literal: 1200, text: '1200' } },
          },
        }],
      });
    });

    it('GET answers no tables without one, and 404s with no scene', async () => {
      buffer = BARE_CODE;
      expect(await get('/configurations/table')).toEqual({ status: 200, body: { tables: [] } });
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
        bodies: [{ rows: { Broad: { Width: 1300, Depth: 800 }, Compact: { Width: null }, Tall: { Depth: 900 } } }],
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

  // A part file with two part() bodies (plans/part-configurations-research.md
  // D1): rows are file-wide, each part's cells live in its own table, and a
  // cell is keyed by its part + label as the Parameters panel keys its rows.
  describe('a part file with two parts', () => {
    const PAIR = '/ws/pair.part.js';
    const PAIR_CODE = [
      `import { part, param, configurations, extrude } from 'fluidcad/core';`,
      ``,
      `export const plate = part('Plate', () => {`,
      `  const configuration = configurations({`,
      `    Wide: { Width: 80 },`,
      `    Thin: { Depth: 2 },`,
      `  });`,
      `  const width = param('Width', 40);`,
      `  const depth = param('Depth', 5);`,
      `  extrude(width);`,
      `});`,
      ``,
      `export const lid = part('Lid', () => {`,
      `  const width = param('Width', 20);`,
      `  extrude(width);`,
      `});`,
      ``,
    ].join('\n');
    const PLATE = { filePath: PAIR, line: 3, column: 21 };
    const LID = { filePath: PAIR, line: 13, column: 19 };
    const plateWidth = ParamKey.of('Plate', 'Width').id;
    const lidWidth = ParamKey.of('Lid', 'Width').id;
    const plateDepth = ParamKey.of('Plate', 'Depth').id;

    beforeEach(() => {
      currentFile = PAIR;
      buffer = PAIR_CODE;
      active = 'Default';
      names = ['Wide', 'Thin'];
      rows = { Wide: { Width: 80 }, Thin: { Depth: 2 } };
      tables = [{ body: 'Plate', names: ['Wide', 'Thin'], rows: { Wide: { Width: 80 }, Thin: { Depth: 2 } } }];
      definitions = [
        { label: 'Width', kind: 'part', body: 'Plate', part: PLATE, defaultValue: 40, currentValue: 40 },
        { label: 'Depth', kind: 'part', body: 'Plate', part: PLATE, defaultValue: 5, currentValue: 5 },
        { label: 'Width', kind: 'part', body: 'Lid', part: LID, defaultValue: 20, currentValue: 20 },
      ];
    });

    it('Add with one part changed writes the row into that part\'s table alone, creating it', async () => {
      overrides = { [lidWidth]: 30 };
      definitions[2].currentValue = 30;
      const result = await actAsEditor(post('/configurations/add', { name: 'Tall', part: PLATE }));
      expect(result.status).toBe(200);
      expect(relayed.filter((m) => m.type === 'apply-feature-edit')).toHaveLength(1);
      expect(relayed[0].spec.configurationEdit).toEqual({
        kind: 'add',
        name: 'Tall',
        bodies: [{ body: 'Lid', part: { line: 13, column: 19 }, values: { Width: 30 } }],
        home: { body: 'Plate', part: { line: 3, column: 21 } },
      });
      expect(buffer).toContain(`    Thin: { Depth: 2 },\n  });`);
      expect(buffer).toContain(`export const lid = part('Lid', () => {\n  const configuration = configurations({\n    Tall: { Width: 30 },\n  });\n  const width`);
      expect(selected).toEqual([[PAIR, 'Tall']]);
      expect(result.body.configurations).toEqual({
        active: 'Tall',
        names: ['Wide', 'Thin', 'Tall'],
        rows: { Wide: { Width: 80 }, Thin: { Depth: 2 }, Tall: { Width: 30 } },
        tables: [
          { body: 'Plate', names: ['Wide', 'Thin'], rows: { Wide: { Width: 80 }, Thin: { Depth: 2 } } },
          { body: 'Lid', names: ['Tall'], rows: { Tall: { Width: 30 } } },
        ],
        modified: false,
      });
    });

    it('Add with both parts\' Width changed writes each part\'s cell into its own table', async () => {
      definitions[0].currentValue = 90;
      definitions[2].currentValue = 45;
      const result = await actAsEditor(post('/configurations/add', { name: 'Big', part: LID }));
      expect(result.status).toBe(200);
      expect(buffer).toContain(`    Thin: { Depth: 2 },\n    Big: { Width: 90 },\n  });`);
      expect(buffer).toContain(`  const configuration = configurations({\n    Big: { Width: 45 },\n  });\n  const width = param('Width', 20);`);
      expect(result.body.configurations.tables).toEqual([
        { body: 'Plate', names: ['Wide', 'Thin', 'Big'], rows: { Wide: { Width: 80 }, Thin: { Depth: 2 }, Big: { Width: 90 } } },
        { body: 'Lid', names: ['Big'], rows: { Big: { Width: 45 } } },
      ]);
    });

    it('Add with nothing changed puts the empty row into the Add-to part', async () => {
      const result = await actAsEditor(post('/configurations/add', { name: 'Blank', part: LID }));
      expect(result.status).toBe(200);
      expect(relayed[0].spec.configurationEdit).toEqual({
        kind: 'add', name: 'Blank', bodies: [], home: { body: 'Lid', part: { line: 13, column: 19 } },
      });
      expect(buffer).toContain(`part('Lid', () => {\n  const configuration = configurations({\n    Blank: {},\n  });`);
      expect(result.body.configurations.names).toEqual(['Wide', 'Thin', 'Blank']);
      expect(result.body.configurations.tables[1]).toEqual({ body: 'Lid', names: ['Blank'], rows: { Blank: {} } });
    });

    it('Add with nothing changed and no part named is the editor\'s 400', async () => {
      const { status, body } = await post('/configurations/add', { name: 'Blank' });
      expect(status).toBe(400);
      expect(body.error).toContain('several part() bodies');
      expect(relayed).toEqual([]);
    });

    it('400s a part of another file and a malformed part', async () => {
      let result = await post('/configurations/add', { name: 'Blank', part: { filePath: '/ws/other.part.js', line: 3, column: 0 } });
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('current file');
      result = await post('/configurations/add', { name: 'Blank', part: { line: 0 } });
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('part must be');
      expect(relayed).toEqual([]);
    });

    it('explicit values are keyed by part + label; a bare label two parts declare is refused, one part\'s is that part\'s', async () => {
      let result = await post('/configurations/add', { name: 'X', values: { Width: 1 }, part: PLATE });
      expect(result.status).toBe(400);
      expect(result.body.error).toBe(`Parameter 'Width' is declared by 'Plate' and 'Lid' — key its cell by its part: ["Plate","Width"] or ["Lid","Width"].`);
      result = await actAsEditor(post('/configurations/add', { name: 'X', values: { Depth: 7, [lidWidth]: 11 } }));
      expect(result.status).toBe(200);
      expect(buffer).toContain(`    X: { Depth: 7 },`);
      expect(buffer).toContain(`    X: { Width: 11 },`);
    });

    it('Save writes each part\'s overrides into the active row of its own table', async () => {
      active = 'Wide';
      overrides = { [plateDepth]: 6, [lidWidth]: 33 };
      const result = await actAsEditor(post('/configurations/save', {}));
      expect(result.status).toBe(200);
      expect(relayed[0].spec.configurationEdit).toEqual({
        kind: 'set',
        name: 'Wide',
        bodies: [
          { body: 'Plate', part: { line: 3, column: 21 }, values: { Depth: 6 } },
          { body: 'Lid', part: { line: 13, column: 19 }, values: { Width: 33 } },
        ],
      });
      expect(buffer).toContain(`    Wide: { Width: 80, Depth: 6 },`);
      expect(buffer).toContain(`part('Lid', () => {\n  const configuration = configurations({\n    Wide: { Width: 33 },\n  });`);
      expect(selected).toEqual([[PAIR, 'Wide']]);
      expect(result.body.configurations).toEqual({
        active: 'Wide',
        names: ['Wide', 'Thin'],
        rows: { Wide: { Width: 33 }, Thin: { Depth: 2 } },
        tables: [
          { body: 'Plate', names: ['Wide', 'Thin'], rows: { Wide: { Width: 80, Depth: 6 }, Thin: { Depth: 2 } } },
          { body: 'Lid', names: ['Wide'], rows: { Wide: { Width: 33 } } },
        ],
        modified: false,
      });
    });

    describe('with a table in each part', () => {
      beforeEach(() => {
        buffer = PAIR_CODE.replace(
          `export const lid = part('Lid', () => {\n`,
          `export const lid = part('Lid', () => {\n  configurations({\n    Wide: { Width: 30 },\n  });\n`,
        );
        tables = [
          { body: 'Plate', names: ['Wide', 'Thin'], rows: { Wide: { Width: 80 }, Thin: { Depth: 2 } } },
          { body: 'Lid', names: ['Wide'], rows: { Wide: { Width: 30 } } },
        ];
        rows = { Wide: { Width: 30 }, Thin: { Depth: 2 } };
        definitions[2].part = { ...LID, line: 13 };
      });

      it('GET answers both tables, each under its part', async () => {
        const { body } = await get('/configurations/table');
        expect(body.tables.map((t: any) => [t.body, Object.keys(t.rows)])).toEqual([['Plate', ['Wide', 'Thin']], ['Lid', ['Wide']]]);
      });

      it('rename renames the row in both tables; a name either table has is refused', async () => {
        let result = await post('/configurations/rename', { from: 'Thin', to: 'Wide' });
        expect(result.status).toBe(400);
        expect(result.body.error).toBe('a configuration named "Wide" already exists');
        result = await actAsEditor(post('/configurations/rename', { from: 'Wide', to: 'Broad' }));
        expect(result.status).toBe(200);
        expect(buffer).toContain(`    Broad: { Width: 80 },`);
        expect(buffer).toContain(`    Broad: { Width: 30 },`);
        expect(result.body.configurations.tables.map((t: any) => t.names)).toEqual([['Broad', 'Thin'], ['Broad']]);
      });

      it('remove takes the row out of both tables, Lid\'s emptied statement with it, the import kept', async () => {
        active = 'Wide';
        const result = await actAsEditor(post('/configurations/remove', { name: 'Wide' }));
        expect(result.status).toBe(200);
        expect(buffer).toContain(`import { part, param, configurations, extrude } from 'fluidcad/core';`);
        expect(buffer).toContain(`  const configuration = configurations({\n    Thin: { Depth: 2 },\n  });`);
        expect(buffer).toContain(`export const lid = part('Lid', () => {\n  const width = param('Width', 20);`);
        expect(selected).toEqual([[PAIR, 'Default']]);
        expect(result.body.configurations).toEqual({
          active: 'Default',
          names: ['Thin'],
          rows: { Thin: { Depth: 2 } },
          tables: [{ body: 'Plate', names: ['Thin'], rows: { Thin: { Depth: 2 } } }],
          modified: false,
        });
      });

      it('the grid commits cells keyed by part + label as ONE edit across both tables', async () => {
        const result = await actAsEditor(post('/configurations/table', {
          rows: {
            Wide: { [plateWidth]: 85, [lidWidth]: null },
            Thin: { [lidWidth]: 18 },
            Blank: {},
          },
          part: LID,
        }));
        expect(result.status).toBe(200);
        expect(relayed.filter((m) => m.type === 'apply-feature-edit')).toHaveLength(1);
        expect(relayed[0].spec.configurationEdit).toEqual({
          kind: 'table',
          bodies: [
            { body: 'Plate', part: { line: 3, column: 21 }, rows: { Wide: { Width: 85 } } },
            { body: 'Lid', part: { line: 13, column: 19 }, rows: { Wide: { Width: null }, Thin: { Width: 18 }, Blank: {} } },
          ],
          home: { body: 'Lid', part: { line: 13, column: 19 } },
        });
        expect(buffer).toContain(`    Wide: { Width: 85 },\n    Thin: { Depth: 2 },\n  });`);
        expect(buffer).toContain(`  configurations({\n    Wide: {},\n    Thin: { Width: 18 },\n    Blank: {},\n  });`);
        expect(result.body.configurations.tables).toEqual([
          { body: 'Plate', names: ['Wide', 'Thin'], rows: { Wide: { Width: 85 }, Thin: { Depth: 2 } } },
          { body: 'Lid', names: ['Wide', 'Thin', 'Blank'], rows: { Wide: {}, Thin: { Width: 18 }, Blank: {} } },
        ]);
        expect(result.body.configurations.names).toEqual(['Wide', 'Thin', 'Blank']);
      });
    });

    it('ignores a parameter of a part from another file', async () => {
      definitions.push({ label: 'Hinge', kind: 'part', body: 'Hinge', part: { filePath: '/ws/hinge.part.js', line: 1, column: 0 }, defaultValue: 1, currentValue: 9 });
      definitions[0].currentValue = 41;
      const result = await actAsEditor(post('/configurations/add', { name: 'Odd', part: PLATE }));
      expect(result.status).toBe(200);
      expect(relayed[0].spec.configurationEdit.bodies).toEqual([{ body: 'Plate', part: { line: 3, column: 21 }, values: { Width: 41 } }]);
      const refused = await post('/configurations/add', { name: 'Odder', values: { [ParamKey.of('Hinge', 'Hinge').id]: 2 } });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe(`'Hinge' of 'Hinge' is no parameter of this file's parts — a configuration sets the parameters of the file that declares it.`);
    });
  });
});

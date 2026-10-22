import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createParamsRouter } from '../../src/routes/params.ts';
import { createApplyFeatureRouter } from '../../src/routes/apply-feature/index.ts';
import { FeatureEditDispatcher } from '../../src/edit-dispatch.ts';
import type { FluidCadServer } from '../../src/fluidcad-server/index.ts';
import { ParamKey } from '../../../lib/dist/index.js';

// `POST /api/params/value` — the Parameters panel's committed value on a
// host that edits source. On a configuration row it becomes the row's cell
// in the declaring part's table; on Default (every file's only
// configuration when it has no table) the `param()` literal. Each request is
// ONE acked apply-feature edit — one undo step in the host — and a refusal
// leaves the source as it was. The fake editor below plays the host; the
// engine is stubbed with the last render's definitions and summary.

const BRACKET = '/ws/bracket.part.js';

const BRACKET_CODE = [
  `import { part, param, configurations, extrude } from 'fluidcad/core';`,
  ``,
  `export const bracket = part('Bracket', () => {`,
  `  const configuration = configurations({`,
  `    M8: { Screw: 'M8', Width: 50 },`,
  `    M10: { Screw: 'M10', Width: 60, Gusset: true },`,
  `  });`,
  `  const screw = param('Screw', 'M6', 'select', { options: [{ label: 'M6', value: 'M6' }, { label: 'M8', value: 'M8' }, { label: 'M10', value: 'M10' }] });`,
  `  const width = param('Width', 40, 'number', { min: 20, max: 120 });`,
  `  const thickness = param('Thickness', 5, 'slider', { min: 3, max: 10, step: 0.5 });`,
  `  const gusset = param('Gusset', false);`,
  `  extrude(width + thickness);`,
  `});`,
  ``,
].join('\n');

let server: http.Server;
let baseUrl: string;
let currentFile: string;
let buffer: string;
let active: string;
let names: string[];
let rows: Record<string, Record<string, unknown>>;
let tables: { body: string; names: string[]; rows: Record<string, Record<string, unknown>> }[];
let definitions: any[];
let forgotten: [string, string][];
let relayed: any[];

const engine = {
  getCurrentFileName: () => currentFile,
  getCurrentCode: () => buffer,
  getLiveBuffer: (filePath: string) => (filePath === currentFile ? buffer : null),
  getConfigurations: () => ({ active, names, rows, tables, modified: false }),
  getParamDefinitions: () => definitions,
  forgetParam: (sessionId: string, key: ParamKey) => {
    forgotten.push([sessionId, key.id]);
  },
  recomputeCurrentFile: async () => null,
} as unknown as FluidCadServer;

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

/** The apply-feature edits the host received — one per request is one undo step each. */
const edits = () => relayed.filter((m) => m.type === 'apply-feature-edit');

const at = (filePath: string, line: number) => ({ filePath, line, column: 16 });

function bracketDefinitions() {
  const part = { filePath: BRACKET, line: 3, column: 23 };
  return [
    {
      label: 'Screw', kind: 'part', body: 'Bracket', part, sourceLocation: at(BRACKET, 8), controlType: 'select',
      defaultValue: 'M6', currentValue: 'M8', configuredValue: 'M8',
      options: [{ label: 'M6', value: 'M6' }, { label: 'M8', value: 'M8' }, { label: 'M10', value: 'M10' }],
    },
    {
      label: 'Width', kind: 'part', body: 'Bracket', part, sourceLocation: at(BRACKET, 9), controlType: 'number',
      defaultValue: 40, currentValue: 50, configuredValue: 50, min: 20, max: 120,
    },
    {
      label: 'Thickness', kind: 'part', body: 'Bracket', part, sourceLocation: at(BRACKET, 10), controlType: 'slider',
      defaultValue: 5, currentValue: 5, min: 3, max: 10, step: 0.5,
    },
    {
      label: 'Gusset', kind: 'part', body: 'Bracket', part, sourceLocation: at(BRACKET, 11), controlType: 'auto',
      defaultValue: false, currentValue: false,
    },
  ];
}

describe('POST /params/value', () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    const send = (msg: any) => {
      relayed.push(msg);
      return true;
    };
    const dispatcher = new FeatureEditDispatcher(engine, send, { ackTimeoutMs: 500 });
    app.use('/api', createParamsRouter(engine, send, () => {}, dispatcher));
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
    currentFile = BRACKET;
    buffer = BRACKET_CODE;
    active = 'M8';
    names = ['M8', 'M10'];
    rows = { M8: { Screw: 'M8', Width: 50 }, M10: { Screw: 'M10', Width: 60, Gusset: true } };
    tables = [{ body: 'Bracket', names: ['M8', 'M10'], rows: { ...rows } }];
    definitions = bracketDefinitions();
    forgotten = [];
    relayed = [];
  });

  describe('on a configuration row', () => {
    it('writes the value into the row\'s cell — ONE edit, the rest of the table as it was', async () => {
      const result = await actAsEditor(post('/params/value', { label: 'Width', body: 'Bracket', value: 55, configuration: 'M8' }));
      expect(result.status).toBe(200);
      expect(edits()).toHaveLength(1);
      expect(edits()[0].spec.configurationEdit).toEqual({
        kind: 'set', name: 'M8', bodies: [{ body: 'Bracket', part: { line: 3, column: 23 }, values: { Width: 55 } }],
      });
      expect(buffer).toContain(`    M8: { Screw: 'M8', Width: 55 },`);
      expect(buffer).toContain(`    M10: { Screw: 'M10', Width: 60, Gusset: true },`);
      expect(buffer).toContain(`param('Width', 40, 'number', { min: 20, max: 120 })`);
      expect(result.body).toMatchObject({ success: true, value: 55 });
      expect(result.body.configurations.rows.M8).toEqual({ Screw: 'M8', Width: 55 });
      expect(result.body.configurations.active).toBe('M8');
      expect(forgotten).toEqual([[BRACKET, ParamKey.of('Bracket', 'Width').id]]);
    });

    it('adds the cell for a parameter the row inherited, so the row now sets it', async () => {
      const result = await actAsEditor(post('/params/value', { label: 'Thickness', body: 'Bracket', value: 6.5 }));
      expect(result.status).toBe(200);
      expect(buffer).toContain(`    M8: { Screw: 'M8', Width: 50, Thickness: 6.5 },`);
      expect(result.body.configurations.tables[0].rows.M8).toEqual({ Screw: 'M8', Width: 50, Thickness: 6.5 });
    });

    it('a select or a toggle writes its own type — a numeric text is a number, "true" a boolean', async () => {
      let result = await actAsEditor(post('/params/value', { label: 'Screw', value: 'M10' }));
      expect(result.status).toBe(200);
      expect(buffer).toContain(`    M8: { Screw: 'M10', Width: 50 },`);
      result = await actAsEditor(post('/params/value', { label: 'Gusset', value: 'true' }));
      expect(result.status).toBe(200);
      expect(buffer).toContain(`    M8: { Screw: 'M10', Width: 50, Gusset: true },`);
      result = await actAsEditor(post('/params/value', { label: 'Width', value: '64' }));
      expect(result.body.value).toBe(64);
      expect(buffer).toContain(`Width: 64`);
      expect(edits()).toHaveLength(3);
    });

    it('null clears the cell: the row inherits the default again', async () => {
      const result = await actAsEditor(post('/params/value', { label: 'Width', body: 'Bracket', value: null, configuration: 'M8' }));
      expect(result.status).toBe(200);
      expect(edits()).toHaveLength(1);
      expect(edits()[0].spec.configurationEdit).toEqual({
        kind: 'table', bodies: [{ body: 'Bracket', part: { line: 3, column: 23 }, rows: { M8: { Width: null } } }],
      });
      expect(buffer).toContain(`    M8: { Screw: 'M8' },`);
      expect(result.body.configurations.rows.M8).toEqual({ Screw: 'M8' });
    });

    it('refuses to clear a cell the row does not set, and refuses null on Default', async () => {
      let result = await post('/params/value', { label: 'Thickness', value: null });
      expect(result.status).toBe(400);
      expect(result.body.reason).toBe('M8 does not set Thickness — it already reads the default.');
      active = 'Default';
      result = await post('/params/value', { label: 'Width', value: null });
      expect(result.status).toBe(400);
      expect(result.body.reason).toContain('Default is the param() literals');
      expect(edits()).toEqual([]);
      expect(buffer).toBe(BRACKET_CODE);
    });

    it('refuses a non-literal table with the editor\'s message and leaves the source alone', async () => {
      buffer = BRACKET_CODE.replace(
        `  const configuration = configurations({\n    M8: { Screw: 'M8', Width: 50 },\n    M10: { Screw: 'M10', Width: 60, Gusset: true },\n  });`,
        `  const configuration = configurations(SIZES);`,
      );
      expect(buffer).toContain('configurations(SIZES)');
      const before = buffer;
      const result = await actAsEditor(post('/params/value', { label: 'Width', value: 55 }));
      expect(result.status).toBe(422);
      expect(result.body).toEqual({
        success: false,
        reason: 'the configurations() table is not an object literal — edit it in the code instead',
      });
      expect(buffer).toBe(before);
    });

    it('409s when the session shows another configuration than the panel did', async () => {
      const result = await post('/params/value', { label: 'Width', value: 55, configuration: 'M10' });
      expect(result.status).toBe(409);
      expect(result.body.reason).toBe('The configuration on screen is M8, not M10 — the value was not written.');
      expect(edits()).toEqual([]);
    });
  });

  describe('on Default', () => {
    beforeEach(() => {
      active = 'Default';
      for (const def of definitions) {
        def.currentValue = def.defaultValue;
        delete def.configuredValue;
      }
    });

    it('writes the param() literal and nothing else of the call — the pencil\'s default-value swap', async () => {
      const result = await actAsEditor(post('/params/value', { label: 'Width', body: 'Bracket', value: 64, configuration: 'Default' }));
      expect(result.status).toBe(200);
      expect(edits()).toHaveLength(1);
      expect(edits()[0].spec.paramEdit).toEqual({ kind: 'value', expectedLabel: 'Width', line: 9, value: 64 });
      expect(edits()[0].spec.filePath).toBe(BRACKET);
      expect(buffer).toContain(`  const width = param('Width', 64, 'number', { min: 20, max: 120 });`);
      expect(buffer).toContain(`    M8: { Screw: 'M8', Width: 50 },`);
      expect(result.body).toEqual({ success: true, value: 64 });
    });

    it('writes a select\'s, a slider\'s and a toggle\'s literal, one edit each', async () => {
      await actAsEditor(post('/params/value', { label: 'Screw', value: 'M10' }));
      await actAsEditor(post('/params/value', { label: 'Thickness', value: 7.5 }));
      await actAsEditor(post('/params/value', { label: 'Gusset', value: true }));
      expect(edits()).toHaveLength(3);
      expect(buffer).toContain(`param('Screw', 'M10', 'select', { options: [`);
      expect(buffer).toContain(`param('Thickness', 7.5, 'slider', { min: 3, max: 10, step: 0.5 })`);
      expect(buffer).toContain(`param('Gusset', true)`);
    });

    it('in a file with no configurations() table, Default is the only configuration: the literal', async () => {
      const PLAIN = '/ws/plate.part.js';
      currentFile = PLAIN;
      buffer = [
        `import { part, param, extrude } from 'fluidcad/core';`,
        `export const plate = part('Plate', () => {`,
        `  const width = param('Width', 40);`,
        `  extrude(width);`,
        `});`,
        ``,
      ].join('\n');
      names = [];
      rows = {};
      tables = [];
      definitions = [{
        label: 'Width', kind: 'part', body: 'Plate', part: { filePath: PLAIN, line: 2, column: 21 },
        sourceLocation: at(PLAIN, 3), controlType: 'auto', defaultValue: 40, currentValue: 40,
      }];
      const result = await actAsEditor(post('/params/value', { label: 'Width', value: 45 }));
      expect(result.status).toBe(200);
      expect(buffer).toContain(`  const width = param('Width', 45);`);
      expect(buffer).not.toContain('configurations');
    });

    it('refuses a default that is not a plain value, leaving the source alone', async () => {
      buffer = BRACKET_CODE.replace(`param('Gusset', false)`, `param('Gusset', width > 50)`);
      const before = buffer;
      const result = await actAsEditor(post('/params/value', { label: 'Gusset', value: true }));
      expect(result.status).toBe(422);
      expect(result.body.reason).toBe('the default of "Gusset" is not a plain value (width > 50) — edit it in the code');
      expect(buffer).toBe(before);
    });
  });

  describe('validation, before any edit', () => {
    it.each([
      [{ label: 'Width', value: 10 }, 'Width must be at least 20.'],
      [{ label: 'Width', value: 500 }, 'Width must be at most 120.'],
      [{ label: 'Width', value: 'wide' }, 'Width needs a number.'],
      [{ label: 'Width', value: '' }, 'Width needs a number.'],
      [{ label: 'Width', value: [1, 2] }, 'Width takes one value, not a list.'],
      [{ label: 'Screw', value: 'M12' }, 'M12 is not one of Screw\'s options.'],
      [{ label: 'Gusset', value: 'maybe' }, 'Gusset is on or off — true or false.'],
    ])('%j → 400 %s', async (payload, reason) => {
      const result = await post('/params/value', payload);
      expect(result.status).toBe(400);
      expect(result.body).toEqual({ success: false, reason });
      expect(edits()).toEqual([]);
      expect(forgotten).toEqual([]);
    });

    it('400s a malformed body, 404s an unknown parameter and no scene', async () => {
      expect((await post('/params/value', { value: 3 })).status).toBe(400);
      expect((await post('/params/value', { label: 'Width' })).status).toBe(400);
      expect((await post('/params/value', { label: 'Width', value: 3, body: '' })).status).toBe(400);
      const unknown = await post('/params/value', { label: 'Height', value: 3 });
      expect(unknown.status).toBe(404);
      expect(unknown.body.reason).toBe(`'Height' is no parameter of the model on screen.`);
      currentFile = '';
      expect((await post('/params/value', { label: 'Width', value: 30 })).status).toBe(404);
      expect(edits()).toEqual([]);
    });

    it('sends a project parameter to its own column', async () => {
      definitions.push({ label: 'Wall', kind: 'global', defaultValue: 3, currentValue: 3, controlType: 'number' });
      const result = await post('/params/value', { label: 'Wall', value: 4 });
      expect(result.status).toBe(400);
      expect(result.body.reason).toContain('project parameter');
    });
  });

  describe('a part file with two parts', () => {
    const PAIR = '/ws/shelf.part.js';
    const PAIR_CODE = [
      `import { part, param, configurations, extrude } from 'fluidcad/core';`,
      ``,
      `export const bracket = part('Bracket', () => {`,
      `  const configuration = configurations({`,
      `    Heavy: { Width: 80 },`,
      `  });`,
      `  const width = param('Width', 40);`,
      `  extrude(width);`,
      `});`,
      ``,
      `export const plate = part('Backing plate', () => {`,
      `  const width = param('Width', 20);`,
      `  extrude(width);`,
      `});`,
      ``,
    ].join('\n');
    const BRACKET_PART = { filePath: PAIR, line: 3, column: 23 };
    const PLATE_PART = { filePath: PAIR, line: 11, column: 21 };

    beforeEach(() => {
      currentFile = PAIR;
      buffer = PAIR_CODE;
      active = 'Heavy';
      names = ['Heavy'];
      rows = { Heavy: { Width: 80 } };
      tables = [{ body: 'Bracket', names: ['Heavy'], rows: { Heavy: { Width: 80 } } }];
      definitions = [
        {
          label: 'Width', kind: 'part', body: 'Bracket', part: BRACKET_PART, sourceLocation: at(PAIR, 7),
          controlType: 'auto', defaultValue: 40, currentValue: 80, configuredValue: 80,
        },
        {
          label: 'Width', kind: 'part', body: 'Backing plate', part: PLATE_PART, sourceLocation: at(PAIR, 12),
          controlType: 'auto', defaultValue: 20, currentValue: 20,
        },
      ];
    });

    it('a row value of the second part goes into that part\'s own table, created first in its body', async () => {
      const result = await actAsEditor(post('/params/value', { label: 'Width', body: 'Backing plate', value: 30, configuration: 'Heavy' }));
      expect(result.status).toBe(200);
      expect(edits()).toHaveLength(1);
      expect(buffer).toContain(`    Heavy: { Width: 80 },`);
      expect(buffer).toContain(
        `export const plate = part('Backing plate', () => {\n  const configuration = configurations({\n    Heavy: { Width: 30 },\n  });\n  const width = param('Width', 20);`,
      );
      expect(result.body.configurations.tables).toEqual([
        { body: 'Bracket', names: ['Heavy'], rows: { Heavy: { Width: 80 } } },
        { body: 'Backing plate', names: ['Heavy'], rows: { Heavy: { Width: 30 } } },
      ]);
      expect(forgotten).toEqual([[PAIR, ParamKey.of('Backing plate', 'Width').id]]);
    });

    it('on Default the literal of the right part\'s Width, by its line', async () => {
      active = 'Default';
      const result = await actAsEditor(post('/params/value', { label: 'Width', body: 'Backing plate', value: 25 }));
      expect(result.status).toBe(200);
      expect(buffer).toContain(`  const width = param('Width', 40);`);
      expect(buffer).toContain(`  const width = param('Width', 25);`);
      expect(buffer.indexOf(`param('Width', 25)`)).toBeGreaterThan(buffer.indexOf('Backing plate'));
    });

    it('a bare label both parts declare is refused', async () => {
      const result = await post('/params/value', { label: 'Width', value: 30 });
      expect(result.status).toBe(400);
      expect(result.body.reason).toBe(`Parameter 'Width' is declared by 'Bracket' and 'Backing plate' — name the part (body) whose parameter to set.`);
      expect(edits()).toEqual([]);
    });
  });
});

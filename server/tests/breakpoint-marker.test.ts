import { describe, expect, it } from 'vitest';
import {
  addBreakpoint,
  clearBreakpoints,
  removeBreakpoint,
  toggleBreakpoint,
} from '../src/code-editor/index.ts';
import { applyFeatureEdit, type ApplyFeatureEditSpec } from '../src/apply-feature-edit/index.ts';
import { TimelineBreakpoint } from '../src/timeline-breakpoint.ts';
import { FeatureCatalog } from '../src/feature-catalog/catalog.ts';
import type { ScannedFeature } from '../src/feature-catalog/scan.ts';

// An edit dialog opens by placing `breakpoint();` after the edited statement
// (the host round-trips its buffer through /api/code/add-breakpoint) and
// closes by taking it out again: Exit and Escape through
// /api/code/clear-breakpoints, Apply inside the rewrite (`clearBreakpoints`
// on the spec). The in-page Monaco host, VS Code and Neovim all send their
// buffer text to these same functions, so the pair is tested on text alone:
// whatever opening adds, closing takes back, byte for byte.

function src(...lines: string[]): string {
  return lines.join('\n');
}

function crlf(code: string): string {
  return code.replace(/\n/g, '\r\n');
}

/** 1-based line of the first line holding `text`. */
function lineOf(code: string, text: string): number {
  const index = code.split('\n').findIndex(line => line.includes(text));
  if (index < 0) {
    throw new Error(`no line holds ${text}`);
  }
  return index + 1;
}

type SessionCase = {
  name: string;
  /** The file before the dialog opened. */
  code: string;
  /** Text on the edited statement's first line. */
  statement: string;
  /** The file while the dialog is open. */
  open: string;
  /** Whether the shell on the statement's line can be applied (a shell edit). */
  appliesShell: boolean;
};

const CORE = `import { sketch, rect, extrude, shell } from 'fluidcad/core';`;
const PLATE = [``, `sketch('xy', () => {`, `  rect(40, 30);`, `});`, `const e = extrude(10);`];
const SHELL = `shell(-2, e.endFaces());`;

const CASES: SessionCase[] = [
  {
    name: 'a statement followed by code',
    code: src(CORE, ...PLATE, SHELL, `extrude(5);`, ``),
    statement: SHELL,
    open: src(CORE.replace('{ ', '{ breakpoint, '), ...PLATE, SHELL, `breakpoint();`, `extrude(5);`, ``),
    appliesShell: true,
  },
  {
    name: 'a statement followed by a blank line',
    code: src(CORE, ...PLATE, SHELL, ``, `extrude(5);`, ``),
    statement: SHELL,
    open: src(CORE.replace('{ ', '{ breakpoint, '), ...PLATE, SHELL, `breakpoint();`, ``, `extrude(5);`, ``),
    appliesShell: true,
  },
  {
    name: 'the last statement of a part body',
    code: src(
      `import { part, sketch, rect, extrude, shell } from 'fluidcad/core';`,
      ``,
      `export const box = part('Box', () => {`,
      `  sketch('xy', () => {`,
      `    rect(40, 30);`,
      `  });`,
      `  const e = extrude(10);`,
      `  ${SHELL}`,
      `});`,
      ``,
    ),
    statement: SHELL,
    open: src(
      `import { breakpoint, part, sketch, rect, extrude, shell } from 'fluidcad/core';`,
      ``,
      `export const box = part('Box', () => {`,
      `  sketch('xy', () => {`,
      `    rect(40, 30);`,
      `  });`,
      `  const e = extrude(10);`,
      `  ${SHELL}`,
      `  breakpoint();`,
      `});`,
      ``,
    ),
    appliesShell: true,
  },
  {
    name: 'the last statement of a file ending in a line break',
    code: src(CORE, ...PLATE, SHELL, ``),
    statement: SHELL,
    open: src(CORE.replace('{ ', '{ breakpoint, '), ...PLATE, SHELL, `breakpoint();`, ``),
    appliesShell: true,
  },
  {
    // Neovim sends its buffer lines joined by \n, with no final line break.
    name: 'the last statement of a buffer with no final line break',
    code: src(CORE, ...PLATE, SHELL),
    statement: SHELL,
    open: src(CORE.replace('{ ', '{ breakpoint, '), ...PLATE, SHELL, `breakpoint();`),
    appliesShell: true,
  },
  {
    name: 'a statement over several lines, indented by its first line',
    code: src(
      `import { part, sketch, rect, extrude, shell, fillet } from 'fluidcad/core';`,
      ``,
      `export const box = part('Box', () => {`,
      `  sketch('xy', () => {`,
      `    rect(40, 30);`,
      `  });`,
      `  const e = extrude(10);`,
      `  shell(-2, e.endFaces())`,
      `    .name('Walls');`,
      `  fillet(1);`,
      `});`,
      ``,
    ),
    statement: `shell(-2, e.endFaces())`,
    open: src(
      `import { breakpoint, part, sketch, rect, extrude, shell, fillet } from 'fluidcad/core';`,
      ``,
      `export const box = part('Box', () => {`,
      `  sketch('xy', () => {`,
      `    rect(40, 30);`,
      `  });`,
      `  const e = extrude(10);`,
      `  shell(-2, e.endFaces())`,
      `    .name('Walls');`,
      `  breakpoint();`,
      `  fillet(1);`,
      `});`,
      ``,
    ),
    appliesShell: true,
  },
  {
    name: 'a 2D statement inside a sketch body',
    code: src(CORE, ``, `sketch('xy', () => {`, `  const r = rect(40, 30);`, `  circle(5);`, `});`, ``),
    statement: `const r = rect`,
    open: src(CORE.replace('{ ', '{ breakpoint, '), ``, `sketch('xy', () => {`, `  const r = rect(40, 30);`, `  breakpoint();`, `  circle(5);`, `});`, ``),
    appliesShell: false,
  },
  {
    name: 'a file importing nothing from the core',
    code: src(`import { base } from './base.part.js';`, ``, `const e = base;`, SHELL, `extrude(5);`, ``),
    statement: SHELL,
    open: src(
      `import { base } from './base.part.js';`,
      `import { breakpoint } from 'fluidcad/core';`,
      ``,
      `const e = base;`,
      SHELL,
      `breakpoint();`,
      `extrude(5);`,
      ``,
    ),
    appliesShell: true,
  },
  {
    name: 'a file with no imports at all',
    code: src(`const e = extrude(10);`, SHELL, `extrude(5);`, ``),
    statement: SHELL,
    open: src(`import { breakpoint } from 'fluidcad/core';`, `const e = extrude(10);`, SHELL, `breakpoint();`, `extrude(5);`, ``),
    appliesShell: true,
  },
  {
    name: 'an import list hugging its braces',
    code: src(`import {sketch, rect, extrude, shell} from 'fluidcad/core';`, ...PLATE, SHELL, `extrude(5);`, ``),
    statement: SHELL,
    open: src(`import {breakpoint, sketch, rect, extrude, shell} from 'fluidcad/core';`, ...PLATE, SHELL, `breakpoint();`, `extrude(5);`, ``),
    appliesShell: true,
  },
  {
    name: 'an import list over several lines',
    code: src(`import {`, `  sketch,`, `  rect,`, `  extrude,`, `  shell,`, `} from 'fluidcad/core';`, ...PLATE, SHELL, `extrude(5);`, ``),
    statement: SHELL,
    open: src(`import {`, `  breakpoint,`, `  sketch,`, `  rect,`, `  extrude,`, `  shell,`, `} from 'fluidcad/core';`, ...PLATE, SHELL, `breakpoint();`, `extrude(5);`, ``),
    appliesShell: true,
  },
];

/** The shell edit a dialog applies: the thickness changes, the faces stay. */
function shellEdit(code: string, statement: string, clear: boolean): ApplyFeatureEditSpec {
  return {
    feature: 'shell',
    filePath: '/ws/model.part.js',
    producers: [],
    parts: [],
    imports: [],
    edit: { line: lineOf(code, statement), column: 0 },
    value: -3,
    ...(clear ? { clearBreakpoints: true } : {}),
  };
}

describe.each([
  ['\\n', (code: string) => code],
  ['\\r\\n', crlf],
])('an edit session\'s breakpoint, with %s line breaks', (_label, lineBreaks) => {
  describe.each(CASES)('$name', (sessionCase) => {
    const code = lineBreaks(sessionCase.code);
    const open = lineBreaks(sessionCase.open);
    const markerRow = lineOf(open, 'breakpoint();') - 1;

    it('opening puts the marker on a line of its own, and nothing else', async () => {
      const placed = await addBreakpoint(code, lineOf(code, sessionCase.statement) - 1);
      expect(placed.newCode).toBe(open);
      expect(placed.breakpointLine).toBe(markerRow);
    });

    it('Exit, Escape and Continue give the file back byte for byte', async () => {
      expect((await clearBreakpoints(open)).newCode).toBe(code);
    });

    it('so do the gutter toggle and the timeline bar', async () => {
      expect((await removeBreakpoint(open, markerRow)).newCode).toBe(code);
      expect((await toggleBreakpoint(open, markerRow)).newCode).toBe(code);
      const resumed = await TimelineBreakpoint.apply(open, TimelineBreakpoint.capture(open, null));
      expect(resumed.error).toBeUndefined();
      expect(resumed.newCode).toBe(code);
    });

    if (sessionCase.appliesShell) {
      it('Apply leaves only the statement\'s own change', async () => {
        const applied = await applyFeatureEdit(open, shellEdit(open, sessionCase.statement, true));
        const direct = await applyFeatureEdit(code, shellEdit(code, sessionCase.statement, false));
        expect(applied.error).toBeUndefined();
        expect(direct.error).toBeUndefined();
        expect(direct.newCode).toContain('shell(-3, e.endFaces())');
        expect(applied.newCode).toBe(direct.newCode);
      });
    }
  });
});

describe('an edit session\'s breakpoint, across sessions', () => {
  const code = src(CORE, ...PLATE, SHELL, `extrude(5);`, ``);

  it('only ever changes the statement, however many dialogs open and close', async () => {
    let current = code;
    for (let session = 0; session < 3; session++) {
      const open = (await addBreakpoint(current, lineOf(current, 'shell(') - 1)).newCode;
      current = (await clearBreakpoints(open)).newCode;
      expect(current).toBe(code);
    }
    const open = (await addBreakpoint(current, lineOf(current, 'shell(') - 1)).newCode;
    const applied = await applyFeatureEdit(open, shellEdit(open, 'shell(', true));
    expect(applied.newCode).toBe(code.replace('shell(-2', 'shell(-3'));
    const reopened = (await addBreakpoint(applied.newCode, lineOf(applied.newCode, 'shell(') - 1)).newCode;
    expect((await clearBreakpoints(reopened)).newCode).toBe(applied.newCode);
  });

  it('removal reads the marker from the text, wherever an edit in between moved it', async () => {
    const open = (await addBreakpoint(code, lineOf(code, 'shell(') - 1)).newCode;
    // A rewrite above the marker, longer by two lines.
    const moved = open.replace(`  rect(40, 30);\n`, `  rect(40, 30);\n  circle(4);\n  circle(6);\n`);
    expect((await clearBreakpoints(moved)).newCode).toBe(code.replace(`  rect(40, 30);\n`, `  rect(40, 30);\n  circle(4);\n  circle(6);\n`));
  });

  it('keeps the import while the file still calls breakpoint() elsewhere', async () => {
    const twoStops = src(`import { breakpoint, extrude } from 'fluidcad/core';`, `extrude(5);`, `breakpoint();`, `extrude(6);`, `breakpoint();`, ``);
    expect((await removeBreakpoint(twoStops, 4)).newCode).toBe(
      src(`import { breakpoint, extrude } from 'fluidcad/core';`, `extrude(5);`, `breakpoint();`, `extrude(6);`, ``),
    );
  });

  it('takes an unused breakpoint import along — the leftover an older session wrote', async () => {
    // Before markers were taken back whole, closing a dialog left the import
    // behind. Opening leaves it alone (nothing to add), closing removes it.
    const leftover = src(`import { extrude, breakpoint, shell } from 'fluidcad/core';`, `const e = extrude(10);`, SHELL, ``);
    const open = (await addBreakpoint(leftover, 2)).newCode;
    expect(open).toBe(src(`import { extrude, breakpoint, shell } from 'fluidcad/core';`, `const e = extrude(10);`, SHELL, `breakpoint();`, ``));
    expect((await clearBreakpoints(open)).newCode).toBe(src(`import { extrude, shell } from 'fluidcad/core';`, `const e = extrude(10);`, SHELL, ``));
  });

  it('evens out an import list an older writer left lopsided, once, then round-trips it exactly', async () => {
    // The old marker writer turned `{ extrude, shell }` into
    // `{breakpoint, extrude, shell }`; the user's pcb-plate.part.js still
    // reads that way, with more specifiers in front.
    const lopsided = src(`import {extrude, breakpoint, shell } from 'fluidcad/core';`, `const e = extrude(10);`, SHELL, ``);
    const session = async (file: string) => (await clearBreakpoints((await addBreakpoint(file, 2)).newCode)).newCode;
    const first = await session(lopsided);
    expect(first).toBe(src(`import {extrude, shell } from 'fluidcad/core';`, `const e = extrude(10);`, SHELL, ``));
    const second = await session(first);
    expect(second).toBe(src(`import { extrude, shell } from 'fluidcad/core';`, `const e = extrude(10);`, SHELL, ``));
    expect(await session(second)).toBe(second);
  });

  it('keeps the code a hand-written marker shares its line with', async () => {
    const inline = src(`import { breakpoint, extrude, fillet } from 'fluidcad/core';`, `extrude(5); breakpoint(); fillet(2);`, ``);
    expect((await clearBreakpoints(inline)).newCode).toBe(src(`import { extrude, fillet } from 'fluidcad/core';`, `extrude(5);  fillet(2);`, ``));
  });

  it('two markers on the last lines go without touching the line before them', async () => {
    const stops = src(`import { breakpoint } from 'fluidcad/core';`, `extrude(5);`, `breakpoint();`, `breakpoint();`);
    expect((await clearBreakpoints(stops)).newCode).toBe(`extrude(5);`);
  });
});

// A custom feature's edit goes through the same apply transform with the same
// `clearBreakpoints` flag; its statement is written by the feature's call
// shape, so it is checked on its own.
const BOLT_CIRCLE_META = {
  id: 'acme.boltCircle', label: 'Bolt circle', group: 'create', kind: 'tool', operations: ['remove'],
  defaultOperation: 'remove',
  params: {
    around: { picker: 'axis', label: 'Around axis' },
    count: { type: 'integer', default: 4, min: 1, label: 'Holes' },
  },
  call: ['around', { count: 'count' }],
  hasOnChange: false, ghost: true, contexts: ['part'],
} as unknown as ScannedFeature['meta'];

function boltCatalog(): FeatureCatalog {
  return new FeatureCatalog({
    workspacePath: '/ws',
    scan: async (absPath) => absPath === '/ws/bolt-circle.feature.js'
      ? { file: absPath, features: [{ exportName: 'boltCircle', meta: BOLT_CIRCLE_META }], deps: [] }
      : { file: absPath, features: [], error: `cannot load ${absPath}`, deps: [] },
    builtIns: async () => ({}),
  });
}

describe('a custom feature\'s edit session', () => {
  const code = src(
    `import { sketch, rect, extrude } from 'fluidcad/core';`,
    `import { boltCircle } from './bolt-circle.feature.js';`,
    ``,
    `export const plate = part('Plate', () => {`,
    `  sketch('xy', () => { rect(40, 40); });`,
    `  extrude(4);`,
    `  boltCircle('z', { count: 8 });`,
    `  extrude(2);`,
    `});`,
    ``,
  );

  function countEdit(file: string, clear: boolean): ApplyFeatureEditSpec {
    return {
      feature: 'custom',
      filePath: '/ws/plate.part.js',
      producers: [],
      parts: [],
      imports: [],
      edit: {
        line: lineOf(file, 'boltCircle('),
        column: 2,
        custom: { id: 'acme.boltCircle', values: { around: { kind: 'keep' }, count: { kind: 'value', value: 6 } } },
      },
      ...(clear ? { clearBreakpoints: true } : {}),
    };
  }

  it('opens and closes without a trace, and Apply changes only the count', async () => {
    const open = (await addBreakpoint(code, lineOf(code, 'boltCircle(') - 1)).newCode;
    expect(open).toContain(`  boltCircle('z', { count: 8 });\n  breakpoint();\n  extrude(2);\n`);
    expect((await clearBreakpoints(open)).newCode).toBe(code);

    const applied = await applyFeatureEdit(open, countEdit(open, true), { callees: boltCatalog() });
    expect(applied.error).toBeUndefined();
    expect(applied.newCode).toBe(code.replace(`{ count: 8 }`, `{ count: 6 }`));
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { listCandidateFiles } from '../src/part-catalog/walk.ts';

let ws: string;

function write(rel: string, contents: string) {
  const abs = join(ws, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, contents);
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'fluidcad-walk-'));
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe('listCandidateFiles — units', () => {
  it('reads each candidate\'s unit() statically, falling back to the project unit', async () => {
    write('inch.part.js', "import { part } from 'fluidcad';\nunit('in');\nexport const a = part('a', () => {});\n");
    write('plain.part.js', "import { part } from 'fluidcad';\nexport const b = part('b', () => {});\n");
    write('sub.assembly.js', "export const s = assembly('s', () => {});\n");

    const files = await listCandidateFiles(ws, undefined, 'cm');
    const byPath = Object.fromEntries(files.map(f => [f.path, f.unit]));
    expect(byPath).toEqual({ 'inch.part.js': 'in', 'plain.part.js': 'cm', 'sub.assembly.js': 'cm' });
  });

  it('reads the unit from a live buffer over the disk content', async () => {
    write('p.part.js', "import { part } from 'fluidcad';\nexport const a = part('a', () => {});\n");
    const files = await listCandidateFiles(
      ws,
      () => "import { part } from 'fluidcad';\nunit('ft');\nexport const a = part('a', () => {});\n",
    );
    expect(files).toEqual([{ path: 'p.part.js', absPath: join(ws, 'p.part.js'), unit: 'ft' }]);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PackageArchive, PackageArchiveError } from '../../src/packages/package-archive.ts';
import { TreeHash } from '../../src/packages/tree-hash.ts';

/**
 * The package format's conformance fixtures (hub-research HD12): the hub
 * vendors what `scripts/package-conformance.mjs` writes and checks its own
 * validator against it. Here the script runs again, as the hub runs it (a
 * child process over the compiled server, so `npm run build:server` after a
 * server change), into a temp dir, and its output must equal the verdicts
 * kept in `fixtures/conformance/`. A change to the format — the manifest
 * pack writes, the tree hash, a refusal — fails here until the fixtures are
 * re-exported:
 *
 *   node scripts/package-conformance.mjs --out server/tests/fixtures/conformance --no-archives
 *   (in the hub) node scripts/conformance-sync.mjs
 */

const REPO = path.resolve(import.meta.dirname, '../../..');
const SCRIPT = path.join(REPO, 'scripts', 'package-conformance.mjs');
const COMPILED = path.join(REPO, 'server', 'dist', 'packages', 'package-archive.js');
const KEPT = path.join(REPO, 'server', 'tests', 'fixtures', 'conformance');

type Verdict = {
  about: string;
  verdict: string;
  integrity?: string;
  warnings?: { code: string; message: string }[];
  hub: string;
};
type Expected = { package: { name: string; version: string; scope: string }; engineVersion: string; archives: Record<string, Verdict> };
type Vectors = { cases: { name: string; files: { path: string; base64: string }[]; integrity: string }[] };

let scratch: string;
let out: string;
let run: { status: number | null; stdout: string; stderr: string };

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T;

beforeAll(() => {
  expect(fs.existsSync(COMPILED), 'server/dist is not built: run `npm run build:server`').toBe(true);
  scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fluidcad-conformance-test-'));
  out = path.join(scratch, 'conformance');
  const result = spawnSync(process.execPath, [SCRIPT, '--out', out], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, FLUIDCAD_PACKAGES: path.join(scratch, 'library'), FLUIDCAD_HOME: path.join(scratch, 'home') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  run = { status: result.status, stdout: result.stdout, stderr: result.stderr };
}, 120_000);

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('package conformance fixtures', () => {
  it('regenerate: every archive gives the verdict it is meant to give', () => {
    expect(run.stderr).not.toMatch(/Error/);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/Wrote \d+ conformance archives' verdicts and archives/);
  });

  it('match the verdicts kept in fixtures/conformance (re-export them after a format change)', () => {
    expect(readJson<Expected>(path.join(out, 'expected.json'))).toEqual(readJson<Expected>(path.join(KEPT, 'expected.json')));
  });

  it('match the tree-hash vectors kept in fixtures/conformance, and the sources hash them the same', () => {
    const vectors = readJson<Vectors>(path.join(out, 'tree-hash-vectors.json'));
    expect(vectors).toEqual(readJson<Vectors>(path.join(KEPT, 'tree-hash-vectors.json')));
    for (const vector of vectors.cases) {
      const files = vector.files.map((f) => ({ path: f.path, bytes: Buffer.from(f.base64, 'base64') }));
      expect(TreeHash.ofFiles(files), vector.name).toBe(vector.integrity);
    }
  });

  it('cover the valid package, every PackageArchive refusal and the hub-only codes', () => {
    const { archives } = readJson<Expected>(path.join(KEPT, 'expected.json'));
    const verdicts = new Set(Object.values(archives).map((a) => a.verdict));
    expect([...verdicts].sort()).toEqual([
      'bad-manifest', 'blocked-import', 'files-mismatch', 'model-archive', 'newer-manifest', 'no-manifest',
      'not-a-zip', 'ok', 'too-large', 'unsafe-path',
    ]);
    const hubOnly = Object.values(archives).filter((a) => a.verdict === 'ok' && a.hub !== 'ok').map((a) => a.hub);
    expect([...new Set(hubOnly)].sort()).toEqual(['bad-params', 'no-models', 'outside-layout', 'scope-mismatch', 'wrong-folder']);
    for (const verdict of Object.values(archives)) {
      if (verdict.verdict !== 'ok') {
        expect(verdict.hub).toBe(verdict.verdict);
      }
    }
  });

  it('inspect from the sources as the compiled script saw them, integrity included', async () => {
    const expected = readJson<Expected>(path.join(out, 'expected.json'));
    const root = path.join(scratch, 'inspect-root');
    fs.mkdirSync(root, { recursive: true });
    for (const [file, verdict] of Object.entries(expected.archives)) {
      const bytes = fs.readFileSync(path.join(out, 'archives', file));
      try {
        const inspection = await PackageArchive.inspect(bytes, { root, engineVersion: expected.engineVersion });
        PackageArchive.discard(inspection.token);
        expect({ file, verdict: 'ok', integrity: inspection.integrity, warnings: inspection.warnings })
          .toEqual({ file, verdict: verdict.verdict, integrity: verdict.integrity, warnings: verdict.warnings });
      } catch (err) {
        if (!(err instanceof PackageArchiveError)) {
          throw err;
        }
        expect({ file, verdict: err.code }).toEqual({ file, verdict: verdict.verdict });
      }
    }
  });

  it('name the FluidCAD commit they came from', () => {
    const source = readJson<{ fluidcadVersion: string; commit: string; dirty: boolean }>(path.join(out, 'source.json'));
    expect(source.fluidcadVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof source.dirty).toBe('boolean');
  });
});

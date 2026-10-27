import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectPackage } from '../src/projects/project-package';
import { readProjectPin } from '../src/engine/project-pin';

/**
 * The start screen's "Package" badge reads a project's `fluidcad.json`
 * `package` block with a reader of its own; the frozen engine-pin parser
 * beside it reads the same file unchanged.
 */

let tmp: string;

function project(config: unknown): string {
  const dir = fs.mkdtempSync(path.join(tmp, 'p-'));
  fs.writeFileSync(path.join(dir, 'fluidcad.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return dir;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-project-package-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ProjectPackage', () => {
  it("reads a package workspace's name and version, and the engine pin reads the same file as before", () => {
    const dir = project({ engine: '0.0.46', package: { name: '@acme/gears', version: '1.2.0', exports: ['gear.feature.js'] } });
    expect(ProjectPackage.read(dir)).toEqual({ name: '@acme/gears', version: '1.2.0' });
    expect(readProjectPin(dir)).toEqual({ engine: '0.0.46', source: 'fluidcad.json' });
  });

  it('answers null for an ordinary project, a missing or unreadable file and a malformed block', () => {
    expect(ProjectPackage.read(project({ engine: '0.0.46' }))).toBeNull();
    expect(ProjectPackage.read(path.join(tmp, 'nowhere'))).toBeNull();
    expect(ProjectPackage.read(project('{ not json'))).toBeNull();
    expect(ProjectPackage.read(project({ package: 'gears' }))).toBeNull();
    expect(ProjectPackage.read(project({ package: { name: 'gears', version: '1.0.0' } }))).toBeNull();
    expect(ProjectPackage.read(project({ package: { name: '@acme/gears' } }))).toBeNull();
  });

  it("badges only the engine's grammar: letter-first parts, single dashes, a 2–39 character handle and a name of at most 64 (HD30)", () => {
    const badge = (name: string) => ProjectPackage.read(project({ package: { name, version: '0.1.0' } }));
    expect(badge('@acme/gears')).toEqual({ name: '@acme/gears', version: '0.1.0' });
    expect(badge(`@${'a'.repeat(39)}/${'k'.repeat(64)}`)).not.toBeNull();
    for (const name of ['@3d/kit', '@acme/3d-kit', '@acme/a--b', '@a/kit', `@${'a'.repeat(40)}/kit`, `@acme/${'k'.repeat(65)}`, '@acme-/kit', 'feature-tests']) {
      expect(badge(name), name).toBeNull();
    }
  });
});

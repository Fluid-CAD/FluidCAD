import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ProjectPackages } from '../../src/packages/project-packages.ts';
import { PackageRoots } from '../../src/packages/package-roots.ts';
import { PackageScaffold } from '../../src/packages/package-scaffold.ts';
import { ProjectScaffold } from '../../src/project-scaffold.ts';

// The overview's identity (ui-packages-plan N1): whether the open workspace
// is itself a package, from its `fluidcad.json`. The page's Publish button
// reads it (U6), and a block that is there but broken still counts (U7).
// FLUIDCAD_PACKAGES points at a temp library so nothing reads the user's.

let tmp: string;
let project: string;
let savedLibrary: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-project-packages-'));
  project = path.join(tmp, 'project');
  fs.mkdirSync(project);
  savedLibrary = process.env.FLUIDCAD_PACKAGES;
  process.env.FLUIDCAD_PACKAGES = path.join(tmp, 'library');
  PackageRoots.forget();
});

afterEach(() => {
  if (savedLibrary === undefined) {
    delete process.env.FLUIDCAD_PACKAGES;
  } else {
    process.env.FLUIDCAD_PACKAGES = savedLibrary;
  }
  PackageRoots.forget();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ProjectPackages.overview: the workspace as a package', () => {
  it('carries the block of a package workspace as its identity, with no problem', () => {
    PackageScaffold.write(project, { name: '@acme/kit', unit: null, engineVersion: '0.0.47' });

    const overview = ProjectPackages.overview(project);

    expect(overview.package).toEqual({ name: '@acme/kit', version: '0.1.0' });
    expect(overview.packageProblem).toBeUndefined();
    expect(overview.pins).toEqual([]);
  });

  it('gives a plain project null and no problem', () => {
    ProjectScaffold.write(project, { unit: null, engineVersion: '0.0.47' });

    const overview = ProjectPackages.overview(project);

    expect(overview.package).toBeNull();
    expect('packageProblem' in overview).toBe(false);
  });

  it('gives null outside a project', () => {
    const overview = ProjectPackages.overview(null);

    expect(overview.package).toBeNull();
    expect('packageProblem' in overview).toBe(false);
    expect(overview.project).toBeNull();
  });

  it('gives a block it cannot read as the problem sentence, with null identity (U7)', () => {
    fs.writeFileSync(path.join(project, 'fluidcad.json'), JSON.stringify({ engine: '0.0.47', package: { name: 'kit', version: '0.1.0' } }));

    const overview = ProjectPackages.overview(project);

    expect(overview.package).toBeNull();
    expect(overview.packageProblem).toBe('fluidcad.json has a "package" whose "name" "kit" needs your hub handle as its scope: write "@<your-handle>/kit".');
  });

  it('keeps the identity and the pins apart: a broken dependencies map leaves the block readable', () => {
    fs.writeFileSync(path.join(project, 'fluidcad.json'), JSON.stringify({ engine: '0.0.47', package: { name: '@acme/kit', version: '1.2.0' }, dependencies: 'nope' }));

    const overview = ProjectPackages.overview(project);

    expect(overview.package).toEqual({ name: '@acme/kit', version: '1.2.0' });
    expect(overview.packageProblem).toBeUndefined();
    expect(overview.pinsProblem).toBeDefined();
  });
});

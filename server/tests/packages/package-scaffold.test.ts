import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PackageScaffold } from '../../src/packages/package-scaffold.ts';
import { PackageAuthoring } from '../../src/packages/package-authoring.ts';
import { PackageLayout } from '../../src/packages/package-manifest.ts';
import { PackageName } from '../../src/packages/package-name.ts';
import { ProjectScaffold, ProjectScaffoldError } from '../../src/project-scaffold.ts';
import { readProjectConfig } from '../../src/project-config.ts';

// `fluidcad init --package` as the class the CLI (and, in Stage N2, the
// launcher's New Package) wraps: everything a plain project gets, laid out
// the way a package ships (U4), with the block; and the refusals that keep
// it from touching a folder it shouldn't.

let workspace: string;

const OPTIONS = { name: '@acme/kit', unit: null, engineVersion: '0.0.47' };

const read = (rel: string) => fs.readFileSync(path.join(workspace, rel), 'utf8');

/** Every entry under the workspace, workspace-relative POSIX, folders with a trailing slash, sorted. */
function tree(dir = workspace, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      const inside = tree(path.join(dir, entry.name), `${rel}/`);
      if (inside.length === 0) {
        out.push(`${rel}/`);
      } else {
        out.push(...inside);
      }
    } else {
      out.push(rel);
    }
  }
  return out.sort();
}

function refusal(run: () => unknown): ProjectScaffoldError {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(ProjectScaffoldError);
    return err as ProjectScaffoldError;
  }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-package-scaffold-'));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('PackageScaffold.write', () => {
  it('writes the project files in the package layout, the README and the block, and returns the plan', () => {
    const written = PackageScaffold.write(workspace, OPTIONS);

    expect(written).toEqual(PackageScaffold.plan());
    expect(written).toEqual(['init.js', 'fluidcad.json', 'parts/part1.part.js', 'features/', 'assemblies/', 'README.md', 'jsconfig.json', '.gitignore']);
    expect(tree()).toEqual(['.gitignore', 'README.md', 'assemblies/', 'features/', 'fluidcad.json', 'init.js', 'jsconfig.json', 'parts/part1.part.js']);
    // The project files are the plain scaffold's, byte for byte; only the part moved.
    expect(read('init.js')).toBe(ProjectScaffold.INIT_JS);
    expect(read('parts/part1.part.js')).toBe(ProjectScaffold.PART_JS);
    expect(read('jsconfig.json')).toBe('{\n  "compilerOptions": {\n    "checkJs": true,\n    "module": "node20",\n    "maxNodeModuleJsDepth": 8\n  }\n}\n');
    expect(read('.gitignore')).toBe('.fluidcad/\n');
    expect(read('README.md')).toBe('# @acme/kit\n');
    expect(read('fluidcad.json')).toBe('{\n  "engine": "0.0.47",\n  "package": {\n    "name": "@acme/kit",\n    "version": "0.1.0"\n  }\n}\n');
  });

  it('is a package the engine reads, whose one export is the starter part', () => {
    PackageScaffold.write(workspace, OPTIONS);

    const config = readProjectConfig(workspace);
    expect(config.package).toEqual({ name: '@acme/kit', version: PackageAuthoring.INITIAL_VERSION });
    expect(config.problems).toBeUndefined();
    expect(PackageLayout.exportsOf(workspace)).toEqual(['parts/part1.part.js']);
    expect(PackageLayout.misplacedIn(workspace)).toEqual([]);
  });

  it('writes the unit between the pin and the block when one is asked for', () => {
    PackageScaffold.write(workspace, { ...OPTIONS, unit: 'in' });

    expect(JSON.parse(read('fluidcad.json'))).toEqual({ engine: '0.0.47', unit: 'in', package: { name: '@acme/kit', version: '0.1.0' } });
    expect(Object.keys(JSON.parse(read('fluidcad.json')))).toEqual(['engine', 'unit', 'package']);
    expect(readProjectConfig(workspace).unit).toBe('in');
  });

  it('starts at the version package init starts at', () => {
    expect(PackageScaffold.INITIAL_VERSION).toBe(PackageAuthoring.INITIAL_VERSION);
    expect(PackageScaffold.INITIAL_VERSION).toBe('0.1.0');
  });

  it('refuses a name without its scope with the sentence saying to add the handle, writing nothing', () => {
    const err = refusal(() => PackageScaffold.write(workspace, { ...OPTIONS, name: 'kit' }));

    expect(err.message).toBe('"name" "kit" needs your hub handle as its scope: write "@<your-handle>/kit".');
    expect(tree()).toEqual([]);
  });

  it('refuses a name that follows neither grammar with the rule, writing nothing', () => {
    const err = refusal(() => PackageScaffold.write(workspace, { ...OPTIONS, name: '@acme/3d-kit' }));

    expect(err.message).toBe(`"@acme/3d-kit" is not a package name: ${PackageName.RULE}.`);
    expect(tree()).toEqual([]);
  });

  it('refuses a folder that holds anything visible, naming it, and writes nothing', () => {
    fs.writeFileSync(path.join(workspace, 'notes.txt'), 'x');

    const err = refusal(() => PackageScaffold.write(workspace, OPTIONS));

    expect(err.message).toBe('This directory is not empty (notes.txt). A new package needs an empty directory.');
    expect(tree()).toEqual(['notes.txt']);
  });

  it('refuses a project folder the same way, listing three entries and counting the rest', () => {
    ProjectScaffold.write(workspace, { unit: null, engineVersion: '0.0.47' });
    const before = tree();

    const err = refusal(() => PackageScaffold.write(workspace, OPTIONS));

    expect(err.message).toBe('This directory is not empty (fluidcad.json, init.js, jsconfig.json and 1 more). A new package needs an empty directory.');
    expect(tree()).toEqual(before);
  });

  it('lets dot-entries be: a .git folder stays, and a .gitignore gains the line', () => {
    fs.mkdirSync(path.join(workspace, '.git'));
    fs.writeFileSync(path.join(workspace, '.gitignore'), 'node_modules/\n');

    const written = PackageScaffold.write(workspace, OPTIONS);

    expect(written).toEqual(PackageScaffold.plan());
    expect(read('.gitignore')).toBe('node_modules/\n.fluidcad/\n');
    expect(fs.existsSync(path.join(workspace, '.git'))).toBe(true);
  });

  it('names the layout folders from PackageLayout', () => {
    expect(PackageScaffold.EMPTY_FOLDERS).toEqual(['features', 'assemblies']);
    expect(PackageScaffold.PART_FILE).toBe('parts/part1.part.js');
    expect(PackageScaffold.readme('@acme/kit')).toBe('# @acme/kit\n');
  });
});

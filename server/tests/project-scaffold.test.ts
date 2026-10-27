import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ProjectScaffold, ProjectScaffoldError } from '../src/project-scaffold.ts';
import { ProjectGitignore } from '../src/project-gitignore.ts';
import { ProjectJsconfig } from '../src/project-jsconfig.ts';
import { readProjectConfig } from '../src/project-config.ts';

// The plain project `fluidcad init` writes, as the class the CLI wraps
// (ui-packages-plan N1 moved the files here so the package scaffold builds
// on them). The bytes are pinned: `fluidcad init` must keep producing
// exactly what it produced before the move.

const INIT_JS = "import { init } from 'fluidcad'\n\nexport default await init()\n";
const PART_JS = "import { part } from 'fluidcad/core';\n\nexport const part1 = part('Part 1', () => {\n});\n";
const JSCONFIG = '{\n  "compilerOptions": {\n    "checkJs": true,\n    "module": "node20",\n    "maxNodeModuleJsDepth": 8\n  }\n}\n';

let workspace: string;

const read = (rel: string) => fs.readFileSync(path.join(workspace, rel), 'utf8');
const listing = () => fs.readdirSync(workspace).sort();

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-project-scaffold-'));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('ProjectScaffold', () => {
  it('writes exactly the five files, byte for byte, with the engine pin and no unit for mm', () => {
    const written = ProjectScaffold.write(workspace, { unit: null, engineVersion: '0.0.47' });

    expect(listing()).toEqual(['.gitignore', 'fluidcad.json', 'init.js', 'jsconfig.json', 'part1.part.js']);
    expect(written).toEqual(ProjectScaffold.plan());
    expect(read('init.js')).toBe(INIT_JS);
    expect(read('part1.part.js')).toBe(PART_JS);
    expect(read('jsconfig.json')).toBe(JSCONFIG);
    expect(read('.gitignore')).toBe('.fluidcad/\n');
    expect(read('fluidcad.json')).toBe('{\n  "engine": "0.0.47"\n}\n');
  });

  it('writes the unit after the pin when one is asked for', () => {
    ProjectScaffold.write(workspace, { unit: 'in', engineVersion: '0.0.47' });

    expect(read('fluidcad.json')).toBe('{\n  "engine": "0.0.47",\n  "unit": "in"\n}\n');
    expect(readProjectConfig(workspace)).toMatchObject({ engine: '0.0.47', unit: 'in', package: null });
  });

  it('plans the files in the order it writes them', () => {
    expect(ProjectScaffold.plan()).toEqual(['init.js', 'part1.part.js', ProjectJsconfig.FILENAME, ProjectGitignore.FILENAME, 'fluidcad.json']);
  });

  it('refuses a folder with an init.js before writing anything', () => {
    fs.writeFileSync(path.join(workspace, 'init.js'), 'mine');

    expect(() => ProjectScaffold.write(workspace, { unit: null, engineVersion: '0.0.47' })).toThrow(ProjectScaffoldError);
    expect(() => ProjectScaffold.write(workspace, { unit: null, engineVersion: '0.0.47' })).toThrow('init.js already exists in this directory.');
    expect(listing()).toEqual(['init.js']);
    expect(read('init.js')).toBe('mine');
  });

  it("keeps the user's part, jsconfig and pin, appends to their .gitignore, and still writes the unit", () => {
    fs.writeFileSync(path.join(workspace, 'part1.part.js'), 'mine');
    fs.writeFileSync(path.join(workspace, 'jsconfig.json'), '{}');
    fs.writeFileSync(path.join(workspace, '.gitignore'), 'dist/');
    fs.writeFileSync(path.join(workspace, 'fluidcad.json'), '{\n  "engine": "0.0.40"\n}\n');

    const written = ProjectScaffold.write(workspace, { unit: 'cm', engineVersion: '0.0.47' });

    expect(written).toEqual(['init.js', '.gitignore', 'fluidcad.json']);
    expect(read('part1.part.js')).toBe('mine');
    expect(read('jsconfig.json')).toBe('{}');
    expect(read('.gitignore')).toBe('dist/\n.fluidcad/\n');
    expect(JSON.parse(read('fluidcad.json'))).toEqual({ engine: '0.0.40', unit: 'cm' });
  });

  it('reports a .gitignore that already covers .fluidcad/ as not written', () => {
    fs.writeFileSync(path.join(workspace, '.gitignore'), '.fluidcad/\n');

    const written = ProjectScaffold.write(workspace, { unit: null, engineVersion: '0.0.47' });

    expect(written).toEqual(['init.js', 'part1.part.js', 'jsconfig.json', 'fluidcad.json']);
    expect(read('.gitignore')).toBe('.fluidcad/\n');
  });
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectsRoot, ProjectsRootError } from '../src/projects/projects-root';

/**
 * The folder every project lives in under `npx fluidcad --projects`: what it
 * lists, and which paths it lets through.
 */

let tmp: string;
let rootDir: string;

function project(name: string, where = rootDir): string {
  const folder = path.join(where, name);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'init.js'), '');
  return folder;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-root-'));
  rootDir = path.join(tmp, 'projects');
  fs.mkdirSync(rootDir);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ProjectsRoot', () => {
  it('has to be an existing folder', () => {
    expect(() => ProjectsRoot.open(path.join(tmp, 'nope'))).toThrow(ProjectsRootError);
    expect(() => ProjectsRoot.open(path.join(tmp, 'nope'))).toThrow('does not exist');
    fs.writeFileSync(path.join(tmp, 'file'), '');
    expect(() => ProjectsRoot.open(path.join(tmp, 'file'))).toThrow('is not a folder');
    expect(ProjectsRoot.open(rootDir).path).toBe(rootDir);
  });

  it('lists the subfolders that hold a project, by name, hidden ones left out', () => {
    project('bracket');
    project('Arm');
    project('.trash');
    fs.mkdirSync(path.join(rootDir, 'notes'));
    fs.writeFileSync(path.join(rootDir, 'README.md'), '');
    expect(ProjectsRoot.open(rootDir).list()).toEqual([
      { name: 'Arm', path: path.join(rootDir, 'Arm') },
      { name: 'bracket', path: path.join(rootDir, 'bracket') },
    ]);
  });

  it('lets a direct subfolder through, whether or not it exists yet', () => {
    const root = ProjectsRoot.open(rootDir);
    project('bracket');
    expect(root.confine(path.join(rootDir, 'bracket'))).toBe(path.join(rootDir, 'bracket'));
    expect(root.confine(path.join(rootDir, 'new-one'))).toBe(path.join(rootDir, 'new-one'));
    // Normalised on the way through, like every other path argument.
    expect(root.confine(path.join(rootDir, 'notes', '..', 'bracket'))).toBe(path.join(rootDir, 'bracket'));
    expect(root.projectPath('bracket')).toBe(path.join(rootDir, 'bracket'));
  });

  it('refuses everything that is not a direct subfolder', () => {
    const root = ProjectsRoot.open(rootDir);
    const refused = [
      rootDir,
      path.dirname(rootDir),
      path.join(tmp, 'elsewhere'),
      path.join(rootDir, '..', 'elsewhere'),
      path.join(rootDir, 'bracket', 'nested'),
      path.join(rootDir, '.hidden'),
      '/',
    ];
    for (const candidate of refused) {
      expect(() => root.confine(candidate), candidate).toThrow(ProjectsRootError);
      expect(() => root.confine(candidate), candidate).toThrow('is not a project in the projects folder');
    }
  });

  it('follows a link in the folder only when it stays in the folder', () => {
    const root = ProjectsRoot.open(rootDir);
    const outside = project('secret', tmp);
    fs.symlinkSync(outside, path.join(rootDir, 'escape'), 'dir');
    expect(() => root.confine(path.join(rootDir, 'escape'))).toThrow(ProjectsRootError);
    expect(root.list().map((entry) => entry.name)).toEqual([]);
  });

  it('is the same folder through a link to it', () => {
    const link = path.join(tmp, 'link');
    fs.symlinkSync(rootDir, link, 'dir');
    const root = ProjectsRoot.open(link);
    project('bracket');
    expect(root.confine(path.join(link, 'bracket'))).toBe(path.join(link, 'bracket'));
    expect(root.confine(path.join(rootDir, 'bracket'))).toBe(path.join(rootDir, 'bracket'));
  });
});

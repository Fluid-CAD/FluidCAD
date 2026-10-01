import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setBuiltinEngineLocation } from '../src/engine/cache';
import { inspectFolder, isValidFolderName, scaffoldProject } from '../src/projects/scaffold';
import { checkNewProject, defaultFolder, fileSystemRoots, listFolder } from '../src/server/folders';
import { rememberProject } from '../src/projects/app-state';
import { writeFakePackage } from './fake-package';

/**
 * New projects and the folders they go in: what a folder counts as, which
 * names can be folders, how a project is set up, and what the page's folder
 * picker is told.
 */

let root: string;
const savedEnv: Record<string, string | undefined> = {};

function dir(...parts: string[]): string {
  const full = path.join(root, ...parts);
  fs.mkdirSync(full, { recursive: true });
  return full;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-scaffold-'));
  for (const key of ['FLUIDCAD_HOME', 'FLUIDCAD_BUILTIN_ENGINE']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.FLUIDCAD_HOME = path.join(root, 'home');
  writeFakePackage(path.join(root, 'package'), '0.0.50');
  setBuiltinEngineLocation({ kind: 'package', packageRoot: path.join(root, 'package') });
});

afterEach(() => {
  setBuiltinEngineLocation(null);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('inspectFolder', () => {
  it('tells a missing, empty, project, non-empty and file path apart', () => {
    expect(inspectFolder(path.join(root, 'nope'))).toBe('missing');
    const empty = dir('empty');
    fs.writeFileSync(path.join(empty, '.DS_Store'), '');
    expect(inspectFolder(empty)).toBe('empty');
    const project = dir('project');
    fs.writeFileSync(path.join(project, 'bracket.part.js'), '');
    expect(inspectFolder(project)).toBe('project');
    const other = dir('other');
    fs.writeFileSync(path.join(other, 'notes.txt'), '');
    expect(inspectFolder(other)).toBe('not-empty');
    expect(inspectFolder(path.join(other, 'notes.txt'))).toBe('not-a-folder');
  });
});

describe('isValidFolderName', () => {
  it('takes a plain name and refuses what cannot be a folder everywhere', () => {
    for (const name of ['bracket', 'Gear box 2', 'v1.2', 'ünïcode']) {
      expect(isValidFolderName(name), name).toBe(true);
    }
    for (const name of ['', ' lead', 'trail ', 'dot.', '.', '..', 'a/b', 'a\\b', 'a:b', 'what?', 'con', 'LPT1', 'nul.txt', 'x\u0001']) {
      expect(isValidFolderName(name), name).toBe(false);
    }
  });
});

describe('scaffoldProject', () => {
  it('creates a missing folder and sets the project up in it, pinned to the launcher engine', async () => {
    const target = path.join(dir('cad'), 'bracket');
    await scaffoldProject(target);
    expect(fs.readdirSync(target).sort()).toEqual(['fluidcad.json', 'init.js', 'part1.part.js']);
    expect(JSON.parse(fs.readFileSync(path.join(target, 'fluidcad.json'), 'utf8'))).toEqual({ engine: '0.0.50' });
  });

  it('leaves a folder that already holds a project as it is', async () => {
    const project = dir('lantern');
    fs.writeFileSync(path.join(project, 'init.js'), 'mine');
    await scaffoldProject(project);
    expect(fs.readdirSync(project)).toEqual(['init.js']);
    expect(fs.readFileSync(path.join(project, 'init.js'), 'utf8')).toBe('mine');
  });

  it("refuses a folder with someone else's files in it", async () => {
    const other = dir('other');
    fs.writeFileSync(path.join(other, 'notes.txt'), '');
    await expect(scaffoldProject(other)).rejects.toThrow('is not empty');
    await expect(scaffoldProject(path.join(root, 'missing-parent', 'x'))).rejects.toThrow('could not be created');
  });
});

describe('the folder picker', () => {
  it('lists folders only, hidden and tooling ones left out, projects marked, sorted like a file manager', () => {
    const parent = dir('cad');
    for (const name of ['bracket', 'Zeta', 'alpha', 'item10', 'item9', '.git', 'node_modules']) {
      dir('cad', name);
    }
    fs.writeFileSync(path.join(parent, 'bracket', 'init.js'), '');
    fs.writeFileSync(path.join(parent, 'readme.md'), '');
    const listing = listFolder(parent);
    expect(listing.entries.map((entry) => entry.name)).toEqual(['alpha', 'bracket', 'item9', 'item10', 'Zeta']);
    expect(listing.entries.find((entry) => entry.name === 'bracket')?.project).toBe(true);
    expect(listing).toMatchObject({ path: parent, project: false, parent: root, home: os.homedir() });
    expect(listFolder(path.parse(root).root).parent).toBeNull();
  });

  it('says what a new project would do, before anything is created', () => {
    const parent = dir('cad');
    dir('cad', 'lantern');
    fs.writeFileSync(path.join(parent, 'lantern', 'init.js'), '');
    dir('cad', 'empty');
    expect(checkNewProject(parent, 'bracket')).toEqual({ path: path.join(parent, 'bracket'), state: 'missing' });
    expect(checkNewProject(parent, 'empty').state).toBe('empty');
    expect(checkNewProject(parent, 'lantern').state).toBe('project');
    expect(checkNewProject(parent, 'a/b').state).toBe('invalid-name');
    expect(checkNewProject(path.join(root, 'nowhere'), 'bracket').state).toBe('unreadable');
  });

  it('starts next to the latest project, or at home', () => {
    expect(defaultFolder()).toBe(os.homedir());
    const project = dir('cad', 'bracket');
    rememberProject(project, null);
    expect(defaultFolder()).toBe(path.dirname(project));
  });

  it('offers a root to start over from', () => {
    expect(fileSystemRoots('linux')).toEqual(['/']);
  });
});

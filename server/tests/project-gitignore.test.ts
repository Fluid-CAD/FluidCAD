import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ProjectGitignore } from '../src/project-gitignore.ts';

/**
 * `fluidcad init` keeps `.fluidcad/` (this machine's state for the
 * project) out of git (the user, 2026-10-12): it writes a `.gitignore`, or
 * appends the one line, and changes nothing else.
 */

let dir: string;
const file = () => path.join(dir, '.gitignore');
const read = () => fs.readFileSync(file(), 'utf8');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-gitignore-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ProjectGitignore.ensure', () => {
  it('writes a .gitignore holding .fluidcad/ alone when there is none', () => {
    expect(ProjectGitignore.ensure(dir)).toBe('created');
    expect(read()).toBe('.fluidcad/\n');
    expect(ProjectGitignore.ensure(dir)).toBe('present');
    expect(read()).toBe('.fluidcad/\n');
  });

  it('appends the line to one without it, keeping every byte before it, and never twice', () => {
    fs.writeFileSync(file(), 'node_modules/\n# exports\n*.stl\n');
    expect(ProjectGitignore.ensure(dir)).toBe('added');
    expect(read()).toBe('node_modules/\n# exports\n*.stl\n.fluidcad/\n');
    expect(ProjectGitignore.ensure(dir)).toBe('present');
    expect(read()).toBe('node_modules/\n# exports\n*.stl\n.fluidcad/\n');
  });

  it('starts its own line when the file does not end with a newline, and handles an empty file', () => {
    fs.writeFileSync(file(), 'dist');
    expect(ProjectGitignore.ensure(dir)).toBe('added');
    expect(read()).toBe('dist\n.fluidcad/\n');
    fs.writeFileSync(file(), '');
    expect(ProjectGitignore.ensure(dir)).toBe('added');
    expect(read()).toBe('.fluidcad/\n');
    fs.writeFileSync(file(), 'dist\r\n');
    expect(ProjectGitignore.ensure(dir)).toBe('added');
    expect(read()).toBe('dist\r\n.fluidcad/\n');
  });

  it('leaves alone a file that already ignores the folder, however it says so', () => {
    for (const text of ['.fluidcad/\n', '.fluidcad\n', '/.fluidcad/\n', '/.fluidcad\n', '**/.fluidcad/\n', '.*\n', 'dist\n.fluidcad/ \n', '.fluidcad/*\n']) {
      fs.writeFileSync(file(), text);
      expect(ProjectGitignore.ensure(dir), JSON.stringify(text)).toBe('present');
      expect(read()).toBe(text);
    }
  });

  it('leaves alone a file that keeps the folder on purpose with a negation', () => {
    for (const text of ['.*\n!.fluidcad/\n', '!/.fluidcad\n', '!.fluidcad/editor-state.json\n']) {
      fs.writeFileSync(file(), text);
      expect(ProjectGitignore.ensure(dir), JSON.stringify(text)).toBe('present');
      expect(read()).toBe(text);
    }
  });

  it('adds the line when only something else of that name is ignored', () => {
    fs.writeFileSync(file(), 'docs/.fluidcad-notes\n.fluidcadrc\n');
    expect(ProjectGitignore.ensure(dir)).toBe('added');
    expect(read()).toBe('docs/.fluidcad-notes\n.fluidcadrc\n.fluidcad/\n');
  });
});

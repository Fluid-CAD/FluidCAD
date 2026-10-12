import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * `fluidcad init` and the project's `.gitignore` (the user, 2026-10-12),
 * run as the user runs it: the real `bin/fluidcad.js` in a child process,
 * in a temp folder, with HOME and FLUIDCAD_HOME in temp folders too. The
 * CLI imports the compiled server out of `server/dist`: run
 * `npm run build:server` after a server change.
 */

const REPO = path.resolve(import.meta.dirname, '../../..');
const CLI = path.join(REPO, 'bin', 'fluidcad.js');

type Run = { status: number | null; stdout: string; stderr: string };

let tmp: string;
let project: string;

function init(cwd: string): Promise<Run> {
  const home = path.join(tmp, 'home');
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: home, APPDATA: home, FLUIDCAD_HOME: path.join(tmp, 'fluidcad-home') };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'init'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const gitignore = () => fs.readFileSync(path.join(project, '.gitignore'), 'utf8');

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-init-')));
  project = path.join(tmp, 'project');
  fs.mkdirSync(project);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('fluidcad init and .gitignore', () => {
  it('writes a .gitignore with .fluidcad/ beside the scaffold when the folder has none', async () => {
    const run = await init(project);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('FluidCAD initialized.\n');
    expect(fs.readdirSync(project).sort()).toEqual(['.gitignore', 'fluidcad.json', 'init.js', 'jsconfig.json', 'part1.part.js']);
    expect(gitignore()).toBe('.fluidcad/\n');
  });

  it("appends .fluidcad/ to the project's own .gitignore and changes nothing else in it", async () => {
    fs.writeFileSync(path.join(project, '.gitignore'), 'node_modules/\n*.stl');
    const run = await init(project);
    expect(run.status).toBe(0);
    expect(gitignore()).toBe('node_modules/\n*.stl\n.fluidcad/\n');
  });

  it('leaves a .gitignore that already has it exactly as it was', async () => {
    fs.writeFileSync(path.join(project, '.gitignore'), '# mine\n.fluidcad/\ndist/\n');
    const run = await init(project);
    expect(run.status).toBe(0);
    expect(gitignore()).toBe('# mine\n.fluidcad/\ndist/\n');
  });

  it('touches nothing when the folder is already a project (init.js exists)', async () => {
    fs.writeFileSync(path.join(project, 'init.js'), 'mine');
    const run = await init(project);
    expect(run.status).toBe(1);
    expect(run.stderr).toBe('init.js already exists in this directory.\n');
    expect(fs.existsSync(path.join(project, '.gitignore'))).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LocalSceneHost } from '../src/host/local-scene-host.ts';
import { extractSourceLocation } from '../../lib/index.js';

/**
 * A workspace reached through a symlink — macOS's /var and /tmp, a linked
 * projects folder — is the same workspace as its real path. Vite resolves
 * modules to real paths by default, which named every feature by a path no
 * client knew and let workspace scripts skip the blocked-import scan, since
 * that scan compared the module id with the workspace path as written.
 *
 * Each test makes its own link, so it holds where the temp directory is not
 * itself a link (Linux CI).
 */
let base: string;
let real: string;
let link: string;
let host: LocalSceneHost | null;

const SCRIPT = 'box.part.js';
const BLOCKED = 'evil.part.js';

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-linked-')));
  real = path.join(base, 'real');
  link = path.join(base, 'link');
  fs.mkdirSync(real);
  fs.symlinkSync(real, link, 'junction');
  fs.writeFileSync(path.join(real, SCRIPT), 'export const where = () => new Error().stack;\n');
  fs.writeFileSync(path.join(real, BLOCKED), "import fs from 'fs';\nexport const read = fs.readFileSync;\n");
  host = null;
});

afterEach(async () => {
  await host?.server.close();
  fs.rmSync(base, { recursive: true, force: true });
});

async function open(workspace: string): Promise<LocalSceneHost> {
  host = new LocalSceneHost();
  await host.init(workspace);
  return host;
}

function slash(p: string): string {
  return p.replace(/\\/g, '/');
}

describe('a workspace reached through a symlink', () => {
  it('names a script in its stack frames by the path it was loaded by', async () => {
    const h = await open(link);
    const script = path.join(link, SCRIPT);
    const mod = await h.loadModuleRaw(script);
    expect(extractSourceLocation(mod.where())?.filePath).toBe(slash(script));
  });

  it.each([
    ['opened through the link, script by the link', () => link, () => link],
    ['opened through the link, script by its real path', () => link, () => real],
    ['opened by its real path, script by the link', () => real, () => link],
    ['opened and loaded by its real path', () => real, () => real],
  ])('refuses a blocked Node import: %s', async (_name, workspace, scriptDir) => {
    const h = await open(workspace());
    await expect(h.loadModuleRaw(path.join(scriptDir(), BLOCKED))).rejects.toThrow(/"fs" is not allowed in FluidCAD scripts/);
  });
});

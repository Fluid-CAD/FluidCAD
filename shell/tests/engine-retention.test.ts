import { spawnSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { engineRoot } from '../src/engine/paths';
import { readProjectPin, writeProjectPin } from '../src/engine/project-pin';
import { resolveEngine } from '../src/engine/resolver';
import { BuiltinEngineRetention } from '../src/engine/retention';
import { EngineScratch } from '../src/engine/scratch';

/**
 * The app's own engine lives inside the bundle an update replaces. A project
 * pinned to it therefore has to find a copy in the home cache afterwards, or
 * go back to the network, which is what failed in GH #80. Every case runs
 * against a fake FLUIDCAD_HOME and a fake built-in engine.
 */

const ENV_KEYS = ['FLUIDCAD_HOME', 'FLUIDCAD_BUILTIN_ENGINE', 'FLUIDCAD_RESOURCES_PATH', 'FLUIDCAD_ENGINE_BASE_URL'];

let home: string;
let workspace: string;
const savedEnv: Record<string, string | undefined> = {};

/** A directory `describeEngineAt` accepts as engine `version`, with a relative `.bin` link like a real install. */
function fakeEngine(root: string, version: string): void {
  const packageRoot = path.join(root, 'node_modules', 'fluidcad');
  fs.mkdirSync(path.join(packageRoot, 'server', 'dist'), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'fluidcad', version }));
  fs.writeFileSync(path.join(packageRoot, 'server', 'dist', 'index.js'), '');
  fs.writeFileSync(path.join(packageRoot, 'bin', 'fluidcad.js'), '');
  fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
  fs.symlinkSync(path.join('..', 'fluidcad', 'bin', 'fluidcad.js'), path.join(root, 'node_modules', '.bin', 'fluidcad'));
}

function builtinRoot(): string {
  return path.join(home, 'builtin');
}

/** The app updated: its bundle now carries `version`, and the old engine is gone with it. */
function updateAppTo(version: string): void {
  fs.rmSync(builtinRoot(), { recursive: true, force: true });
  fakeEngine(builtinRoot(), version);
}

/** A port nothing listens on, so any download fails the way it does offline. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-retention-home-'));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-retention-ws-'));
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
  process.env.FLUIDCAD_HOME = home;
  process.env.FLUIDCAD_BUILTIN_ENGINE = builtinRoot();
  delete process.env.FLUIDCAD_RESOURCES_PATH;
  delete process.env.FLUIDCAD_ENGINE_BASE_URL;
  fakeEngine(builtinRoot(), '0.0.45');
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('BuiltinEngineRetention.ensure', () => {
  it('copies the built-in engine into the home cache for a pin that names it', async () => {
    const kept = await BuiltinEngineRetention.ensure('0.0.45');

    expect(kept).toMatchObject({ version: '0.0.45', root: engineRoot('0.0.45'), builtin: false });
    expect(fs.existsSync(path.join(engineRoot('0.0.45'), 'node_modules', 'fluidcad', 'server', 'dist', 'index.js'))).toBe(true);
  });

  it('keeps nothing for a pin that is not the built-in engine', async () => {
    expect(await BuiltinEngineRetention.ensure('0.0.44')).toBeNull();
    expect(await BuiltinEngineRetention.ensure(null)).toBeNull();
    expect(fs.existsSync(path.join(home, 'engines'))).toBe(false);
  });

  it("keeps the engine's relative links relative, so they outlive the bundle", async () => {
    await BuiltinEngineRetention.ensure('0.0.45');

    const link = path.join(engineRoot('0.0.45'), 'node_modules', '.bin', 'fluidcad');
    expect(fs.readlinkSync(link)).toBe(path.join('..', 'fluidcad', 'bin', 'fluidcad.js'));
  });

  it('makes one copy for concurrent requests and leaves no scratch behind', async () => {
    const [first, second] = await Promise.all([
      BuiltinEngineRetention.ensure('0.0.45'),
      BuiltinEngineRetention.ensure('0.0.45'),
    ]);

    expect(first?.root).toBe(engineRoot('0.0.45'));
    expect(second?.root).toBe(engineRoot('0.0.45'));
    expect(fs.readdirSync(EngineScratch.root())).toEqual([]);
  });

  it('reuses a copy already in the cache instead of copying again', async () => {
    await BuiltinEngineRetention.ensure('0.0.45');
    const marker = path.join(engineRoot('0.0.45'), 'marker');
    fs.writeFileSync(marker, '');

    await BuiltinEngineRetention.ensure('0.0.45');

    expect(fs.existsSync(marker)).toBe(true);
  });
});

describe('opening a project after an app update, offline', () => {
  it('runs the previous built-in engine from the cache, with no download and no repin', async () => {
    writeProjectPin(workspace, '0.0.45');
    await BuiltinEngineRetention.ensure('0.0.45');
    updateAppTo('0.0.46');
    process.env.FLUIDCAD_ENGINE_BASE_URL = `http://127.0.0.1:${await closedPort()}`;

    let downloads = 0;
    const engine = await resolveEngine(workspace, {
      onDownloadStart: () => {
        downloads += 1;
      },
    });

    expect(engine).toMatchObject({ version: '0.0.45', source: 'cache', pin: '0.0.45' });
    expect(downloads).toBe(0);
    expect(readProjectPin(workspace).engine).toBe('0.0.45');
  });

  it('without the kept copy, has to download, and offline moves the project to the new engine', async () => {
    writeProjectPin(workspace, '0.0.45');
    updateAppTo('0.0.46');
    process.env.FLUIDCAD_ENGINE_BASE_URL = `http://127.0.0.1:${await closedPort()}`;

    let downloads = 0;
    const engine = await resolveEngine(workspace, {
      onDownloadStart: () => {
        downloads += 1;
      },
    });

    expect(downloads).toBe(1);
    expect(engine).toMatchObject({ version: '0.0.46', source: 'builtin' });
    expect(readProjectPin(workspace).engine).toBe('0.0.46');
  });
});

describe('EngineScratch.sweep', () => {
  it('removes what exited processes left behind and keeps what live ones use', () => {
    const exited = spawnSync(process.execPath, ['-e', '']).pid;
    const root = EngineScratch.root();
    fs.mkdirSync(path.join(root, `${exited}-abandoned`, 'engine'), { recursive: true });
    fs.writeFileSync(path.join(root, 'fluidcad-engine-0.0.43-darwin-arm64.tar.gz.123.part'), '');
    const live = EngineScratch.create();

    const removed = EngineScratch.sweep();

    expect(removed.sort()).toEqual([`${exited}-abandoned`, 'fluidcad-engine-0.0.43-darwin-arm64.tar.gz.123.part'].sort());
    expect(fs.existsSync(live.dir)).toBe(true);
    live.dispose();
  });
});

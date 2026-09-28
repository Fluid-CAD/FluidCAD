import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import * as tar from 'tar';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { downloadEngine, engineArtifactStem, EngineDownloadError, EngineTransport } from '../src/engine/download';
import { engineRoot } from '../src/engine/paths';
import { readProjectPin, writeProjectPin } from '../src/engine/project-pin';
import { resolveEngine } from '../src/engine/resolver';
import { EngineScratch } from '../src/engine/scratch';

/**
 * Engine downloads on a bad network (GH #80). Before these limits existed, a
 * silent link held the splash on "Downloading engine…" for five minutes
 * (Node's own fetch timeouts), and a window reopened mid-download collided
 * with its first attempt. A local server plays GitHub Releases here: it
 * answers properly, answers slowly, or goes quiet at the manifest or halfway
 * through the tarball.
 */

const VERSION = '0.0.43';
const ENV_KEYS = ['FLUIDCAD_HOME', 'FLUIDCAD_BUILTIN_ENGINE', 'FLUIDCAD_RESOURCES_PATH', 'FLUIDCAD_ENGINE_BASE_URL'];
/** Short limits, so a stall is a fraction of a second here instead of 20–30 s. */
const FAST = { manifestMs: 300, stallMs: 300 };

type Behaviour = 'normal' | 'silent-manifest' | 'stall-tarball' | 'slow-tarball';

/** GitHub Releases for one engine, played by a local server that can go quiet on cue. */
class FakeReleases {
  behaviour: Behaviour = 'normal';

  private constructor(
    private readonly server: http.Server,
    private readonly tarball: Buffer,
    private readonly manifest: string,
  ) {}

  static async start(tarball: Buffer): Promise<FakeReleases> {
    const manifest = JSON.stringify({
      schemaVersion: 1,
      version: VERSION,
      target: `${process.platform}-${process.arch}`,
      file: `${engineArtifactStem(VERSION)}.tar.gz`,
      sha256: crypto.createHash('sha256').update(tarball).digest('hex'),
      bytes: tarball.length,
    });
    let releases: FakeReleases | null = null;
    const server = http.createServer((req, res) => releases?.handle(req, res));
    releases = new FakeReleases(server, tarball, manifest);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return releases;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.url?.endsWith('.json')) {
      if (this.behaviour === 'silent-manifest') {
        // Accepted, never answered: a link that is up but carries nothing.
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(this.manifest);
      return;
    }

    res.writeHead(200, { 'content-length': String(this.tarball.length) });
    if (this.behaviour === 'normal') {
      res.end(this.tarball);
      return;
    }
    // Eight chunks. 'stall-tarball' sends the first and goes quiet;
    // 'slow-tarball' sends one every 60 ms, never quiet for a stall limit.
    const size = Math.ceil(this.tarball.length / 8);
    res.write(this.tarball.subarray(0, size));
    if (this.behaviour === 'stall-tarball') {
      return;
    }
    let offset = size;
    const timer = setInterval(() => {
      const chunk = this.tarball.subarray(offset, offset + size);
      offset += chunk.length;
      if (chunk.length === 0) {
        clearInterval(timer);
        res.end();
        return;
      }
      res.write(chunk);
    }, 60);
    res.on('close', () => clearInterval(timer));
  }
}

/** A real, verifiable engine tarball, padded so a transfer spans several chunks. */
function engineTarball(dir: string): Buffer {
  const packageRoot = path.join(dir, 'node_modules', 'fluidcad');
  fs.mkdirSync(path.join(packageRoot, 'server', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'fluidcad', version: VERSION }));
  fs.writeFileSync(path.join(packageRoot, 'server', 'dist', 'index.js'), '');
  fs.writeFileSync(path.join(packageRoot, 'padding.bin'), crypto.randomBytes(256 * 1024));
  const file = path.join(dir, 'engine.tar.gz');
  tar.c({ gzip: true, file, cwd: dir, sync: true }, ['node_modules']);
  return fs.readFileSync(file);
}

/** A directory `describeEngineAt` accepts as engine `version`. */
function fakeEngine(root: string, version: string): void {
  const packageRoot = path.join(root, 'node_modules', 'fluidcad');
  fs.mkdirSync(path.join(packageRoot, 'server', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'fluidcad', version }));
  fs.writeFileSync(path.join(packageRoot, 'server', 'dist', 'index.js'), '');
}

/** Abort as soon as the tarball starts arriving: the window closing mid-download. */
function abortOnFirstBytes(abort: AbortController) {
  return (progress: { phase: string }) => {
    if (progress.phase === 'download') {
      abort.abort();
    }
  };
}

let fixtures: string;
let releases: FakeReleases;
let home: string;
let workspace: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-download-fixtures-'));
  releases = await FakeReleases.start(engineTarball(fixtures));
});

afterAll(async () => {
  await releases.stop();
  fs.rmSync(fixtures, { recursive: true, force: true });
});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-download-home-'));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-download-ws-'));
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
  process.env.FLUIDCAD_HOME = home;
  process.env.FLUIDCAD_ENGINE_BASE_URL = releases.baseUrl;
  delete process.env.FLUIDCAD_BUILTIN_ENGINE;
  delete process.env.FLUIDCAD_RESOURCES_PATH;
  releases.behaviour = 'normal';
});

afterEach(() => {
  EngineTransport.use(null);
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

describe('downloadEngine', () => {
  it('installs an engine when the network is fine', async () => {
    const engine = await downloadEngine(VERSION, { timeouts: FAST });

    expect(engine).toMatchObject({ version: VERSION, root: engineRoot(VERSION) });
  });

  it('gives up on a manifest request that never answers', async () => {
    releases.behaviour = 'silent-manifest';
    const started = Date.now();

    const error = await downloadEngine(VERSION, { timeouts: FAST }).catch((err) => err);

    expect(error).toBeInstanceOf(EngineDownloadError);
    expect(error.message).toMatch(/No answer from .+ within 0\.3 s/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('gives up on a tarball that stops arriving, and leaves nothing behind', async () => {
    releases.behaviour = 'stall-tarball';

    const error = await downloadEngine(VERSION, { timeouts: FAST }).catch((err) => err);

    expect(error).toBeInstanceOf(EngineDownloadError);
    expect(error.message).toMatch(/stalled: nothing arrived for 0\.3 s/);
    expect(fs.existsSync(engineRoot(VERSION))).toBe(false);
    expect(fs.readdirSync(EngineScratch.root())).toEqual([]);
  });

  it('finishes a slow download that keeps moving', async () => {
    // ~480 ms in all, longer than the stall limit, but never 300 ms quiet.
    releases.behaviour = 'slow-tarball';

    const engine = await downloadEngine(VERSION, { timeouts: FAST });

    expect(engine.version).toBe(VERSION);
  });

  it('runs two downloads of the same version side by side', async () => {
    releases.behaviour = 'slow-tarball';

    const results = await Promise.allSettled([
      downloadEngine(VERSION, { timeouts: FAST }),
      downloadEngine(VERSION, { timeouts: FAST }),
    ]);

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(fs.readdirSync(EngineScratch.root())).toEqual([]);
  });

  it('stops when the caller aborts, and leaves nothing behind', async () => {
    releases.behaviour = 'stall-tarball';
    const abort = new AbortController();

    const error = await downloadEngine(VERSION, {
      timeouts: { stallMs: 10_000 },
      signal: abort.signal,
      onProgress: abortOnFirstBytes(abort),
    }).catch((err) => err);

    expect(error).toBeInstanceOf(EngineDownloadError);
    expect(fs.existsSync(engineRoot(VERSION))).toBe(false);
    expect(fs.readdirSync(EngineScratch.root())).toEqual([]);
  });

  it('sends every request through the installed transport', async () => {
    const seen: string[] = [];
    EngineTransport.use((url, init) => {
      seen.push(url);
      return fetch(url, init);
    });

    await downloadEngine(VERSION, { timeouts: FAST });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(/\.json$/);
    expect(seen[1]).toMatch(/\.tar\.gz$/);
  });
});

describe('resolveEngine with a pinned engine to download', () => {
  beforeEach(() => {
    // The app ships 0.0.44; the project pins the older 0.0.43, which is not on disk.
    process.env.FLUIDCAD_BUILTIN_ENGINE = path.join(home, 'builtin');
    fakeEngine(path.join(home, 'builtin'), '0.0.44');
    writeProjectPin(workspace, VERSION);
  });

  it('falls back to the shipped engine as soon as the manifest limit passes', async () => {
    releases.behaviour = 'silent-manifest';

    const engine = await resolveEngine(workspace, { timeouts: FAST });

    expect(engine).toMatchObject({ version: '0.0.44', source: 'builtin' });
  });

  it('keeps the pin of a project whose window closed mid-download', async () => {
    releases.behaviour = 'stall-tarball';
    const abort = new AbortController();

    const error = await resolveEngine(workspace, {
      timeouts: { stallMs: 10_000 },
      signal: abort.signal,
      onProgress: abortOnFirstBytes(abort),
    }).catch((err) => err);

    expect(error).toBeInstanceOf(EngineDownloadError);
    expect(readProjectPin(workspace).engine).toBe(VERSION);
  });
});

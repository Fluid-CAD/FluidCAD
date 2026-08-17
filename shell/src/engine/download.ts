import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import * as tar from 'tar';
import { describeEngineAt, markEngineInstalled, type InstalledEngine } from './cache';
import { currentTarget, engineRoot, enginesDir, serverEntryFor } from './paths';

/**
 * Fetching an engine: one tarball, one sha256, one extract.
 *
 * Deliberately *not* `npm install` at runtime — Electron bundles Node but not
 * the npm CLI, the tree has platform-specific optional binaries, and the first
 * thing a new user would meet on a corporate proxy is a stack trace. See
 * `docs/desktop/00-architecture.md` §"Ship vs. download".
 */

/** GitHub Releases. Assets are published by `.github/workflows/release-engines.yml`. */
const DEFAULT_BASE_URL = 'https://github.com/Fluid-CAD/FluidCAD/releases/download';

export type EngineManifest = {
  schemaVersion: number;
  version: string;
  target: string;
  file: string;
  sha256: string;
  bytes: number;
  unpackedBytes?: number;
  ocjsVersion?: string | null;
};

export type DownloadPhase = 'manifest' | 'download' | 'verify' | 'extract' | 'done';

export type DownloadProgress = {
  version: string;
  phase: DownloadPhase;
  receivedBytes: number;
  totalBytes: number | null;
};

export type DownloadOptions = {
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
};

export class EngineDownloadError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'EngineDownloadError';
  }
}

/** `fluidcad-engine-<version>-<target>` — shared with the build script. */
export function engineArtifactStem(version: string, target = currentTarget()): string {
  return `fluidcad-engine-${version}-${target}`;
}

/**
 * A base that isn't an http(s) URL is treated as a local directory of
 * artifacts. That is how the shell is pointed at a `dist-engines/` build
 * without publishing anything.
 */
function isRemoteBase(base: string): boolean {
  return /^https?:\/\//i.test(base);
}

function baseUrl(): string {
  return process.env.FLUIDCAD_ENGINE_BASE_URL || DEFAULT_BASE_URL;
}

function assetLocation(version: string, fileName: string): string {
  const base = baseUrl();
  return isRemoteBase(base)
    ? `${base.replace(/\/$/, '')}/v${version}/${fileName}`
    : path.join(path.resolve(base), fileName);
}

function offlineMessage(version: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return (
    `Could not download the FluidCAD engine ${version}.\n` +
    `${detail}\n` +
    'This project pins that version, so it has to be fetched once before the ' +
    'project can open. Connect to the network and try again, or open a ' +
    'project that uses an engine you already have.'
  );
}

async function fetchBytes(location: string, signal?: AbortSignal): Promise<Buffer> {
  if (!isRemoteBase(baseUrl())) {
    return fs.promises.readFile(location);
  }
  const response = await fetch(location, { signal, redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${location}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function readManifest(version: string, signal?: AbortSignal): Promise<EngineManifest> {
  const stem = engineArtifactStem(version);
  const location = assetLocation(version, `${stem}.json`);
  let raw: Buffer;
  try {
    raw = await fetchBytes(location, signal);
  } catch (err) {
    throw new EngineDownloadError(offlineMessage(version, err), err);
  }

  let manifest: EngineManifest;
  try {
    manifest = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    throw new EngineDownloadError(`The engine manifest at ${location} is not valid JSON.`, err);
  }
  if (manifest.version !== version || manifest.target !== currentTarget()) {
    throw new EngineDownloadError(
      `The engine manifest at ${location} describes ${manifest.version} for ` +
        `${manifest.target}, not ${version} for ${currentTarget()}.`,
    );
  }
  if (typeof manifest.sha256 !== 'string' || manifest.sha256.length !== 64) {
    throw new EngineDownloadError(`The engine manifest at ${location} has no usable sha256.`);
  }
  return manifest;
}

async function downloadTo(
  location: string,
  destination: string,
  manifest: EngineManifest,
  options: DownloadOptions,
): Promise<void> {
  if (!isRemoteBase(baseUrl())) {
    await fs.promises.copyFile(location, destination);
    return;
  }

  const response = await fetch(location, { signal: options.signal, redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`${response.status} ${response.statusText} for ${location}`);
  }

  const declared = Number(response.headers.get('content-length'));
  const totalBytes = Number.isFinite(declared) && declared > 0 ? declared : manifest.bytes ?? null;
  let received = 0;

  const source = Readable.fromWeb(response.body as any);
  source.on('data', (chunk: Buffer) => {
    received += chunk.length;
    options.onProgress?.({
      version: manifest.version,
      phase: 'download',
      receivedBytes: received,
      totalBytes,
    });
  });

  await pipeline(source, fs.createWriteStream(destination));
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Download, verify and install `version` into the cache. Resolves to the
 * installed engine — or to the one already there, if a concurrent window won
 * the race.
 */
export async function downloadEngine(
  version: string,
  options: DownloadOptions = {},
): Promise<InstalledEngine> {
  const report = (phase: DownloadPhase, receivedBytes = 0, totalBytes: number | null = null) =>
    options.onProgress?.({ version, phase, receivedBytes, totalBytes });

  report('manifest');
  const manifest = await readManifest(version, options.signal);

  const scratch = path.join(enginesDir(), '.tmp');
  fs.mkdirSync(scratch, { recursive: true });
  const tarballPath = path.join(scratch, `${manifest.file}.${process.pid}.part`);
  const stagingDir = path.join(scratch, `${version}.${process.pid}`);

  try {
    const location = assetLocation(version, manifest.file);
    try {
      await downloadTo(location, tarballPath, manifest, options);
    } catch (err) {
      throw new EngineDownloadError(offlineMessage(version, err), err);
    }

    report('verify', manifest.bytes, manifest.bytes);
    const digest = await sha256File(tarballPath);
    if (digest !== manifest.sha256) {
      throw new EngineDownloadError(
        `The downloaded engine ${version} does not match its manifest ` +
          `(expected sha256 ${manifest.sha256}, got ${digest}). Nothing was installed.`,
      );
    }

    report('extract', manifest.bytes, manifest.bytes);
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });
    await tar.x({ file: tarballPath, cwd: stagingDir });

    const packageRoot = path.join(stagingDir, 'node_modules', 'fluidcad');
    if (!fs.existsSync(serverEntryFor(packageRoot))) {
      throw new EngineDownloadError(
        `The engine ${version} archive has no server in it — nothing was installed.`,
      );
    }

    const destination = engineRoot(version);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    try {
      fs.renameSync(stagingDir, destination);
    } catch (err: any) {
      // Another window installed the same version while we were downloading.
      // Its copy is as good as ours — both came from the same verified sha256.
      if (!fs.existsSync(destination)) {
        throw err;
      }
    }

    const installed = describeEngineAt(destination, false);
    if (!installed) {
      throw new EngineDownloadError(`Engine ${version} did not install cleanly.`);
    }
    markEngineInstalled(version);
    report('done', manifest.bytes, manifest.bytes);
    return installed;
  } finally {
    fs.rmSync(tarballPath, { force: true });
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

/** Newest first. Numeric-segment comparison; anything non-numeric sorts last. */
export function compareVersionsDescending(a: string, b: string): number {
  const parse = (v: string) => v.split('.').map((part) => Number.parseInt(part, 10));
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (Number.isNaN(l) || Number.isNaN(r)) {
      return a < b ? 1 : -1;
    }
    if (l !== r) {
      return r - l;
    }
  }
  return 0;
}

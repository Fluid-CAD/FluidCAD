import { createHash } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { normalizePath } from './normalize-path.ts';
import type { SceneHost } from './host/scene-host.ts';

/** What a path that cannot be read hashes to — so a file appearing or vanishing is a change. */
const MISSING = 'missing';

/**
 * Everything a finished render was built from: the content of every input
 * file, and the param overrides it ran with. A cached render may be served
 * again iff this still matches — see {@link RenderInputs.isCurrent}.
 */
export type RenderFingerprint = {
  /** Absolute path → content hash ({@link MISSING} for an unreadable path). */
  files: ReadonlyMap<string, string>;
  /** The session's param overrides, canonically serialized. */
  params: string;
};

export type RenderInputSources = {
  /** The file the render ran (the live-render overlay prefix is tolerated). */
  entryFile: string;
  /** Inputs the module graph cannot see: project config, files the engine read. */
  extraFiles: readonly string[];
  /** The session's param overrides, canonically serialized. */
  params: string;
};

/**
 * Pull-based validation for cached renders. Rather than guessing which
 * cached renders an event might have made stale (and dropping them), a cache
 * entry carries the fingerprint of its inputs and is checked at the moment it
 * is asked for: viewing a file changes nothing, so it invalidates nothing;
 * editing a helper module no session ever opened changes a hash, so every
 * render built from it misses.
 *
 * This fingerprints input FILES. It plays no part in matching scene objects
 * between renders — that stays the engine's compare.
 *
 * A file's content is its live editor buffer when the host holds one — that
 * is what the module loader runs — else its bytes on disk. Disk hashes are
 * memoized by (mtime, size), so validating a render is a `stat` per input.
 */
export class RenderInputs {
  private readonly diskHashes = new Map<string, { mtimeMs: number; size: number; hash: string }>();

  constructor(private readonly host: SceneHost) {}

  /**
   * Fingerprint a render that just succeeded. Null when the inputs cannot be
   * enumerated — a host that knows its module graph but reports nothing for
   * this entry — in which case the render must not be cached.
   */
  capture(sources: RenderInputSources): RenderFingerprint | null {
    const entry = normalizePath(sources.entryFile.replace('virtual:live-render:', ''));
    const inputs = new Set<string>();
    if (this.host.getModuleDependencies) {
      const dependencies = this.host.getModuleDependencies(entry);
      if (dependencies.length === 0) {
        return null;
      }
      for (const dependency of dependencies) {
        inputs.add(normalizePath(dependency));
      }
    }
    // A host without a module graph (a packed, immutable bundle) still pins
    // the entry itself.
    inputs.add(entry);
    for (const extra of sources.extraFiles) {
      inputs.add(normalizePath(extra));
    }
    const files = new Map<string, string>();
    for (const file of inputs) {
      files.set(file, this.contentHash(file));
    }
    return { files, params: sources.params };
  }

  /** Whether a render with this fingerprint would be built from the same inputs today. */
  isCurrent(fingerprint: RenderFingerprint, params: string): boolean {
    if (fingerprint.params !== params) {
      return false;
    }
    for (const [file, hash] of fingerprint.files) {
      if (this.contentHash(file) !== hash) {
        return false;
      }
    }
    return true;
  }

  /** Hash of the file's bytes on disk, or null when it cannot be read. */
  diskHash(file: string): string | null {
    let stats: { mtimeMs: number; size: number };
    try {
      stats = statSync(file);
    } catch {
      this.diskHashes.delete(file);
      return null;
    }
    const known = this.diskHashes.get(file);
    if (known && known.mtimeMs === stats.mtimeMs && known.size === stats.size) {
      return known.hash;
    }
    let hash: string;
    try {
      hash = RenderInputs.hashOf(readFileSync(file));
    } catch {
      this.diskHashes.delete(file);
      return null;
    }
    this.diskHashes.set(file, { mtimeMs: stats.mtimeMs, size: stats.size, hash });
    return hash;
  }

  static hashOf(content: string | Uint8Array): string {
    return createHash('sha1').update(content).digest('hex');
  }

  private contentHash(file: string): string {
    const buffer = this.host.getBuffer(file);
    if (buffer !== null) {
      return RenderInputs.hashOf(buffer);
    }
    return this.diskHash(file) ?? MISSING;
  }
}

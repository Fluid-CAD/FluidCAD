import { createHash } from 'crypto';
import fsSync, { promises as fs } from 'fs';
import path from 'path';
import { normalizePath } from '../normalize-path.ts';

/** One file of a tree: its POSIX path relative to the tree's root, and its bytes. */
export type TreeFile = { path: string; bytes: Uint8Array };

/**
 * The integrity of an installed package (K5): a hash over every file of
 * its tree, written `sha256-<base64>`, which a project pin records beside
 * the version. It is Go's dirhash with sha256 for `h1:`: each file's
 * sha256 in hex, two spaces and its path, one line per file in byte order
 * of the paths, and the sha256 of those lines.
 *
 * The same tree hashes the same however it is held: the files a pack
 * produces ({@link ofFiles}) and the directory an install extracts them
 * into ({@link ofDirectory}). It is never stored inside the package — a
 * manifest can't vouch for itself — so whoever extracts a tree computes it.
 */
export class TreeHash {
  static readonly PREFIX = 'sha256-';

  /** The hash of a tree given as files, or as a `path → bytes` map. */
  static ofFiles(files: Iterable<TreeFile> | Record<string, Uint8Array>): string {
    const list: TreeFile[] = Symbol.iterator in Object(files)
      ? [...(files as Iterable<TreeFile>)]
      : Object.entries(files as Record<string, Uint8Array>).map(([p, bytes]) => ({ path: p, bytes }));
    const seen = new Set<string>();
    for (const file of list) {
      TreeHash.checkPath(file.path);
      if (seen.has(file.path)) {
        throw new Error(`TreeHash: the path ${JSON.stringify(file.path)} appears twice`);
      }
      seen.add(file.path);
    }
    const sorted = list.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    const summary = createHash('sha256');
    for (const file of sorted) {
      const digest = createHash('sha256').update(file.bytes).digest('hex');
      summary.update(`${digest}  ${file.path}\n`);
    }
    return TreeHash.PREFIX + summary.digest('base64');
  }

  /**
   * The hash of every file under `dir`, at any depth. Directories count
   * only through their files. Anything that is neither a file nor a
   * directory — a symbolic link above all — is refused: what it points at
   * isn't part of the tree.
   */
  static async ofDirectory(dir: string): Promise<string> {
    const files: TreeFile[] = [];
    const walk = async (abs: string): Promise<void> => {
      for (const entry of await fs.readdir(abs, { withFileTypes: true })) {
        const child = path.join(abs, entry.name);
        const rel = normalizePath(path.relative(dir, child));
        if (entry.isDirectory()) {
          await walk(child);
        } else if (entry.isFile()) {
          files.push({ path: rel, bytes: await fs.readFile(child) });
        } else {
          throw new Error(`TreeHash: ${rel} is not a regular file`);
        }
      }
    };
    await walk(dir);
    return TreeHash.ofFiles(files);
  }

  /**
   * {@link ofDirectory}, synchronously: for the engine's resolver, which
   * answers Vite's module resolution and the catalogs' lookups inline.
   */
  static ofDirectorySync(dir: string): string {
    const files: TreeFile[] = [];
    const walk = (abs: string): void => {
      for (const entry of fsSync.readdirSync(abs, { withFileTypes: true })) {
        const child = path.join(abs, entry.name);
        const rel = normalizePath(path.relative(dir, child));
        if (entry.isDirectory()) {
          walk(child);
        } else if (entry.isFile()) {
          files.push({ path: rel, bytes: fsSync.readFileSync(child) });
        } else {
          throw new Error(`TreeHash: ${rel} is not a regular file`);
        }
      }
    };
    walk(dir);
    return TreeHash.ofFiles(files);
  }

  /** A path dirhash can line up: relative, forward slashes, no newline. */
  private static checkPath(p: string): void {
    if (p.length === 0 || p.includes('\n') || p.includes('\\') || p.startsWith('/') || p.split('/').includes('..')) {
      throw new Error(`TreeHash: ${JSON.stringify(p)} is not a relative POSIX path`);
    }
  }
}

import fs from 'fs';
import path from 'path';
import { TreeHash } from './tree-hash.ts';

/**
 * The tree hash of an installed package directory, as a render checks it
 * against the project's pin (K5): `TreeHash.ofDirectorySync`, cached by the
 * directory and a stamp of its files (how many, their total size and the
 * newest mtime). Installed files never change, so the hash is computed once
 * per directory; a file changed under it anyway — by hand, with its
 * read-only bit lifted — moves the stamp, and the next render hashes again
 * and sees the mismatch.
 */
export class PackageIntegrity {
  private static readonly cache = new Map<string, { stamp: string; integrity: string }>();

  /** The directory's `sha256-…` hash; throws when the tree can't be read or holds a link. */
  static of(directory: string): string {
    const stamp = PackageIntegrity.stampOf(directory);
    const cached = PackageIntegrity.cache.get(directory);
    if (cached && cached.stamp === stamp) {
      return cached.integrity;
    }
    const integrity = TreeHash.ofDirectorySync(directory);
    PackageIntegrity.cache.set(directory, { stamp, integrity });
    return integrity;
  }

  /** Drop every cached hash (tests). */
  static forget(): void {
    PackageIntegrity.cache.clear();
  }

  /** `<files>:<bytes>:<newest mtime>` over every entry under `directory`. */
  private static stampOf(directory: string): string {
    let files = 0;
    let bytes = 0;
    let newest = 0;
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const child = path.join(dir, entry.name);
        const stat = fs.lstatSync(child);
        newest = Math.max(newest, stat.mtimeMs);
        if (entry.isDirectory()) {
          walk(child);
        } else {
          files++;
          bytes += stat.size;
        }
      }
    };
    walk(directory);
    return `${files}:${bytes}:${newest}`;
  }
}

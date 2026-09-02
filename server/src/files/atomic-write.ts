import fs from 'fs';
import path from 'path';

/**
 * Replace a file's contents without a moment where it is empty or half
 * written: the bytes go to a sibling temp file first, and a rename swaps it
 * into place — atomic on every filesystem Node runs on. A crash or a full
 * disk mid-write leaves the original untouched and, at worst, a stray temp
 * file next to it; it never leaves a truncated source file.
 *
 * The temp file is a dotfile so the workspace watchers see an `other`-kind
 * blip at most, and it carries the pid so two servers on one workspace can't
 * collide.
 */
export function writeFileAtomically(absPath: string, content: string): void {
  const dir = path.dirname(absPath);
  const tmp = path.join(dir, `.${path.basename(absPath)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  let mode: number | undefined;
  try {
    mode = fs.statSync(absPath).mode;
  } catch {
    // New file — the default mode is fine.
  }
  fs.writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' });
  try {
    if (mode !== undefined) {
      fs.chmodSync(tmp, mode);
    }
    fs.renameSync(tmp, absPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // The temp file is all that could be left behind; the original is intact.
    }
    throw err;
  }
}

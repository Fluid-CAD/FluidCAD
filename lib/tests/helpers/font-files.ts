import { statSync } from "fs";
import getSystemFonts from "get-system-fonts";
import { openSync } from "fontkit";
import type { Font, FontCollection } from "fontkit";

/** A system `.ttf` file to copy into a workspace, with the family fontkit reads from it. */
export interface FontFile {
  path: string;
  family: string;
}

/**
 * The two smallest system `.ttf` files of different families that render
 * 'A', or null when the machine has fewer — what a test of a workspace font
 * file being swapped for another needs. A test given null has nothing to
 * copy and skips.
 */
export async function twoFontFiles(): Promise<[FontFile, FontFile] | null> {
  const files = (await (getSystemFonts as unknown as () => Promise<string[]>)())
    .filter((file) => file.toLowerCase().endsWith(".ttf"))
    .map((file) => ({ file, size: statSync(file).size }))
    .sort((a, b) => a.size - b.size || a.file.localeCompare(b.file))
    .map(({ file }) => file);
  const found: FontFile[] = [];
  for (const path of files) {
    let font: Font;
    try {
      const opened = openSync(path) as Font | FontCollection;
      font = (opened as FontCollection).fonts?.[0] ?? (opened as Font);
      void font.glyphForCodePoint(65).path.commands;
    } catch {
      continue;
    }
    if (!font.familyName || !font.hasGlyphForCodePoint(65) || found.some((other) => other.family === font.familyName)) {
      continue;
    }
    found.push({ path, family: font.familyName });
    if (found.length === 2) {
      return [found[0], found[1]];
    }
  }
  return null;
}

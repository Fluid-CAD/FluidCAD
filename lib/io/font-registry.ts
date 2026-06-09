import getSystemFontsDefault from "get-system-fonts";
import { openSync, create } from "fontkit";
import type { Font, FontCollection } from "fontkit";
import { readWorkspaceAssetBytes } from "./file-import.js";

// get-system-fonts ships a CJS default export; nodenext types the default import
// as the module namespace, so cast it to its callable signature (the runtime
// default import is the function).
const listSystemFonts = getSystemFontsDefault as unknown as (
  opts?: { extensions?: string[]; additionalFolders?: string[] },
) => Promise<string[]>;

/**
 * A single registered font face within a family (one weight/style variant).
 */
interface FontVariant {
  path: string;
  psName: string;
  weight: number;
  italic: boolean;
}

/**
 * A `.font(...)` argument is treated as a local workspace file when it ends in a
 * font extension; otherwise it is a system family name (e.g. "Arial").
 */
const FONT_FILE_RE = /\.(ttf|otf|ttc|woff2?|dfont)$/i;

/**
 * Fallback families for common names that may be absent on a given OS. The OS
 * matcher (fontconfig/CoreText/DirectWrite) would normally substitute these;
 * since `get-system-fonts` only lists files, we substitute ourselves.
 */
const FAMILY_ALIASES: Record<string, string[]> = {
  "arial": ["helvetica", "helvetica neue", "liberation sans", "arimo", "dejavu sans", "noto sans"],
  "helvetica": ["helvetica neue", "arial", "liberation sans", "arimo", "dejavu sans", "noto sans"],
  "times new roman": ["times", "liberation serif", "tinos", "dejavu serif", "noto serif"],
  "times": ["times new roman", "liberation serif", "tinos", "dejavu serif"],
  "courier new": ["courier", "liberation mono", "cousine", "dejavu sans mono", "noto sans mono"],
  "courier": ["courier new", "liberation mono", "dejavu sans mono"],
  "comic sans ms": ["comic neue", "dejavu sans"],
  "segoe ui": ["liberation sans", "dejavu sans", "noto sans", "arial"],
  "calibri": ["carlito", "liberation sans", "dejavu sans"],
  "cambria": ["caladea", "liberation serif", "dejavu serif"],
  "verdana": ["dejavu sans", "liberation sans", "noto sans"],
  "tahoma": ["dejavu sans", "liberation sans"],
};

/**
 * Preferred default families (in order) when no font is specified.
 */
const DEFAULT_FAMILIES = [
  "helvetica", "arial", "liberation sans", "dejavu sans", "noto sans",
  "segoe ui", "san francisco", "roboto",
];

function normName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function faces(opened: Font | FontCollection): Font[] {
  return (opened as FontCollection).fonts ?? [opened as Font];
}

function isItalic(font: Font): boolean {
  if (font.italicAngle && Math.abs(font.italicAngle) > 0.01) {
    return true;
  }
  return /italic|oblique/i.test(font.subfamilyName || "");
}

function weightOf(font: Font): number {
  const os2 = (font as any)["OS/2"];
  if (os2 && typeof os2.usWeightClass === "number") {
    return os2.usWeightClass;
  }
  return /bold/i.test(font.subfamilyName || "") ? 700 : 400;
}

/**
 * Resolves font names/paths to ready-to-use fontkit `Font` instances.
 *
 * `init()` enumerates system fonts (via `get-system-fonts`) once per process and
 * builds a family -> variants index (via `fontkit`). `resolve()` is synchronous
 * so it can be called from `SceneObject.build()`; it requires `init()` to have
 * completed first, mirroring `getOC()` / `loadOC()`.
 */
export class FontRegistry {
  private static index: Map<string, FontVariant[]> | null = null;
  private static allFiles: string[] = [];
  private static fontCache = new Map<string, Font | null>();

  static async init(): Promise<void> {
    if (this.index) {
      return;
    }
    const index = new Map<string, FontVariant[]>();
    let files: string[] = [];
    try {
      files = await listSystemFonts();
    } catch (e) {
      console.warn("FontRegistry: failed to list system fonts:", (e as Error).message);
    }
    this.allFiles = files;

    for (const file of files) {
      try {
        for (const face of faces(openSync(file))) {
          if (!face || !face.familyName) {
            continue;
          }
          const key = normName(face.familyName);
          const variant: FontVariant = {
            path: file,
            psName: face.postscriptName,
            weight: weightOf(face),
            italic: isItalic(face),
          };
          const list = index.get(key);
          if (list) {
            list.push(variant);
          } else {
            index.set(key, [variant]);
          }
        }
      } catch {
        // Skip unreadable / unsupported font files.
      }
    }

    this.index = index;
    console.debug(`FontRegistry: indexed ${index.size} families from ${files.length} files`);
  }

  /**
   * Resolves a font request into a ready fontkit `Font`. Never returns null:
   * falls back through aliases -> default families -> any available font, and
   * only throws if the machine has no usable fonts at all.
   */
  static resolve(opts: { font?: string; weight?: number; italic?: boolean }): Font {
    const weight = opts.weight ?? 400;
    const italic = opts.italic ?? false;
    const name = opts.font?.trim();

    // 1. Local workspace file, detected by extension.
    if (name && FONT_FILE_RE.test(name)) {
      return this.loadLocalFile(name);
    }

    const index = this.ensureInit();

    // 2. Requested system family (+ aliases).
    if (name) {
      const font = this.openFirstRenderable(this.collectVariants(normName(name), true), weight, italic);
      if (font) {
        return font;
      }
      console.warn(`FontRegistry: font "${name}" not usable; falling back to a default font.`);
    }

    // 3. Default family priority list.
    for (const fam of DEFAULT_FAMILIES) {
      const font = this.openFirstRenderable(this.collectVariants(fam, false), weight, italic);
      if (font) {
        return font;
      }
    }

    // 4. Any indexed family.
    const anyFamily = this.openFirstRenderable([...index.values()].flat(), weight, italic);
    if (anyFamily) {
      return anyFamily;
    }

    // 5. Any font file at all (index may be empty if name parsing failed).
    for (const file of this.allFiles) {
      const font = this.tryOpenFile(file);
      if (font) {
        return font;
      }
    }

    throw new Error(
      'No fonts available on this system. Install a font package, or specify a ' +
      'local font file, e.g. text(...).font("fonts/MyFont.ttf").',
    );
  }

  private static ensureInit(): Map<string, FontVariant[]> {
    if (!this.index) {
      throw new Error("Fonts not initialized. Call FontRegistry.init() first.");
    }
    return this.index;
  }

  /** Collects a family's variants plus its alias families' variants, unsorted. */
  private static collectVariants(key: string, useAliases: boolean): FontVariant[] {
    const index = this.ensureInit();
    const out: FontVariant[] = [];
    const direct = index.get(key);
    if (direct) {
      out.push(...direct);
    }
    if (useAliases) {
      for (const alias of FAMILY_ALIASES[key] ?? []) {
        const list = index.get(normName(alias));
        if (list) {
          out.push(...list);
        }
      }
    }
    return out;
  }

  /**
   * Sorts variants by italic match then nearest weight, and opens the first that
   * actually renders (skipping fonts that throw on outline access).
   */
  private static openFirstRenderable(list: FontVariant[], weight: number, italic: boolean): Font | null {
    const sorted = [...list].sort((a, b) => {
      const ai = a.italic === italic ? 0 : 1;
      const bi = b.italic === italic ? 0 : 1;
      if (ai !== bi) {
        return ai - bi;
      }
      return Math.abs(a.weight - weight) - Math.abs(b.weight - weight);
    });
    for (const variant of sorted) {
      const font = this.openVariant(variant);
      if (font) {
        return font;
      }
    }
    return null;
  }

  /** Opens and validates a variant; caches the result, including known-bad (null). */
  private static openVariant(variant: FontVariant): Font | null {
    const cacheKey = `${variant.path}|${variant.psName}`;
    const cached = this.fontCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    let font: Font | null = null;
    try {
      // Do NOT pass the postscriptName as openSync's 2nd argument: for a single
      // (non-collection) font that arg is treated as a *variation instance*
      // name and throws on non-variable fonts. Open the file, then pick the
      // matching face out of a collection (.ttc) ourselves.
      const list = faces(openSync(variant.path));
      const picked = list.find(f => f.postscriptName === variant.psName) ?? list[0];
      // Weight/italic come from face selection above; we never call fontkit
      // getVariation() — some fonts declare an fvar wght axis without the
      // variable outline tables and throw lazily at layout() time.
      font = picked && this.canRender(picked) ? picked : null;
    } catch {
      font = null;
    }
    this.fontCache.set(cacheKey, font);
    return font;
  }

  /** All indexed system font family names (lowercased). Useful for tooling/tests. */
  static availableFamilies(): string[] {
    return [...this.ensureInit().keys()];
  }

  private static tryOpenFile(file: string): Font | null {
    try {
      const face = faces(openSync(file))[0];
      if (face?.familyName && this.canRender(face)) {
        return face;
      }
    } catch {
      // skip unreadable / unusable font file
    }
    return null;
  }

  /**
   * A font is usable only if its outlines compute without throwing. Fonts that
   * declare an fvar variation axis but lack the variable outline tables
   * (gvar/glyf or CFF2) throw lazily when glyph paths are accessed.
   */
  private static canRender(font: Font): boolean {
    try {
      const glyph = font.glyphForCodePoint(65); // 'A'
      void glyph.path.commands;
      return true;
    } catch {
      return false;
    }
  }

  private static loadLocalFile(relPath: string): Font {
    const cacheKey = `file:${relPath}`;
    const cached = this.fontCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const bytes = readWorkspaceAssetBytes(relPath);
    if (!bytes) {
      throw new Error(`Font file not found in workspace: ${relPath}`);
    }
    const font = faces(create(Buffer.from(bytes)))[0];
    this.fontCache.set(cacheKey, font);
    return font;
  }
}

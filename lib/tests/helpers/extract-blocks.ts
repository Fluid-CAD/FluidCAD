import fs from "fs";
import path from "path";

/** What a runnable block is: a model (`fluid.js`) or a custom feature's module (`feature.js`). */
export type FluidBlockKind = "model" | "feature";

export type FluidBlock = {
  /** Path relative to the docs root, forward-slash. */
  file: string;
  /** 1-based line number where the block body starts (the line after the opening fence). */
  line: number;
  /** Block body — no fences. */
  block: string;
  kind: FluidBlockKind;
};

const FENCE_RE = /^(\s*)```([A-Za-z0-9_.-]*)\s*$/;
const MODEL_LANGS = new Set(["fluid.js", "fluid", "fluidjs"]);
const FEATURE_LANGS = new Set(["feature.js"]);

function kindOf(lang: string): FluidBlockKind | null {
  if (MODEL_LANGS.has(lang)) {
    return "model";
  }
  return FEATURE_LANGS.has(lang) ? "feature" : null;
}

function listMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listMarkdown(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

function extractFromFile(file: string, docsRoot: string): FluidBlock[] {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  const rel = path.relative(docsRoot, file).split(path.sep).join("/");

  const blocks: FluidBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const openMatch = lines[i].match(FENCE_RE);
    const kind = openMatch ? kindOf(openMatch[2]) : null;
    if (!kind) {
      i++;
      continue;
    }
    const startLine = i + 2;
    const body: string[] = [];
    i++;
    while (i < lines.length) {
      const closeMatch = lines[i].match(FENCE_RE);
      if (closeMatch && closeMatch[2] === "") {
        break;
      }
      body.push(lines[i]);
      i++;
    }
    blocks.push({ file: rel, line: startLine, block: body.join("\n"), kind });
    i++;
  }
  return blocks;
}

/**
 * Every runnable block under the docs root, in file then document order:
 * models (```fluid.js) and custom feature modules (```feature.js).
 */
export function extractRunnableBlocks(docsRootRel: string): FluidBlock[] {
  const docsRoot = path.resolve(docsRootRel);
  const blocks: FluidBlock[] = [];
  for (const file of listMarkdown(docsRoot).sort()) {
    blocks.push(...extractFromFile(file, docsRoot));
  }
  return blocks;
}

/** The model blocks (```fluid.js) under the docs root. */
export function extractFluidJsBlocks(docsRootRel: string): FluidBlock[] {
  return extractRunnableBlocks(docsRootRel).filter(block => block.kind === "model");
}

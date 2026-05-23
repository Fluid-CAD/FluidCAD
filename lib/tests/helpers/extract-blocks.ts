import fs from "fs";
import path from "path";

export type FluidBlock = {
  /** Path relative to the docs root, forward-slash. */
  file: string;
  /** 1-based line number where the block body starts (the line after the opening fence). */
  line: number;
  /** Block body — no fences. */
  block: string;
};

const FENCE_RE = /^(\s*)```([A-Za-z0-9_.-]*)\s*$/;
const RUNNABLE_LANGS = new Set(["fluid.js", "fluid", "fluidjs"]);

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
    if (!openMatch || !RUNNABLE_LANGS.has(openMatch[2])) {
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
    blocks.push({ file: rel, line: startLine, block: body.join("\n") });
    i++;
  }
  return blocks;
}

export function extractFluidJsBlocks(docsRootRel: string): FluidBlock[] {
  const docsRoot = path.resolve(docsRootRel);
  const blocks: FluidBlock[] = [];
  for (const file of listMarkdown(docsRoot).sort()) {
    blocks.push(...extractFromFile(file, docsRoot));
  }
  return blocks;
}

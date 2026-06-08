// Walks llm-docs/**/*.md, parses YAML frontmatter, and emits two manifests:
//
//   - llm-docs/index.json          — every doc keyed by id (for list_docs, search_docs).
//   - llm-docs/api/index.json      — symbol name -> doc id (for get_api_signature).
//
// The MCP server reads these at startup; it never parses markdown on the hot
// path. The script is also where we enforce frontmatter contracts: unique ids,
// non-colliding symbols, resolvable seeAlso refs.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DOCS_ROOT = path.join(REPO_ROOT, 'llm-docs');

type DocFrontmatter = {
  id: string;
  title: string;
  summary: string;
  tags?: string[];
  symbols?: string[];
  seeAlso?: string[];
};

type DocRecord = DocFrontmatter & {
  /** Path relative to llm-docs/ root, forward-slash. */
  file: string;
  /** Body length in characters — useful for search ranking heuristics. */
  bodyLength: number;
};

type IndexFile = {
  schemaVersion: 1;
  generatedAt: string;
  docs: DocRecord[];
};

type ApiIndexFile = {
  schemaVersion: 1;
  generatedAt: string;
  /** Symbol name -> doc id. */
  symbols: Record<string, string>;
};

function listMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listMarkdown(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function parseDoc(file: string): { frontmatter: DocFrontmatter; body: string } {
  const raw = fs.readFileSync(file, 'utf8');
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    throw new Error(`${file}: missing or malformed frontmatter — expected leading "---" block.`);
  }
  const parsed = yaml.load(match[1]);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${file}: frontmatter did not parse as a YAML mapping.`);
  }
  const fm = parsed as Record<string, unknown>;
  if (typeof fm.id !== 'string' || fm.id.length === 0) {
    throw new Error(`${file}: frontmatter \`id\` is required and must be a non-empty string.`);
  }
  if (typeof fm.title !== 'string' || fm.title.length === 0) {
    throw new Error(`${file}: frontmatter \`title\` is required.`);
  }
  if (typeof fm.summary !== 'string' || fm.summary.length === 0) {
    throw new Error(`${file}: frontmatter \`summary\` is required.`);
  }

  const tags = asStringArray(fm.tags, `${file}: tags`);
  const symbols = asStringArray(fm.symbols, `${file}: symbols`);
  const seeAlso = asStringArray(fm.seeAlso, `${file}: seeAlso`);

  return {
    frontmatter: {
      id: fm.id,
      title: fm.title,
      summary: fm.summary,
      tags,
      symbols,
      seeAlso,
    },
    body: match[2],
  };
}

function asStringArray(value: unknown, where: string): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new Error(`${where}: must be a list of strings.`);
  }
  return value;
}

export function buildManifests(docsRoot: string): { index: IndexFile; apiIndex: ApiIndexFile } {
  if (!fs.existsSync(docsRoot)) {
    throw new Error(`llm-docs root does not exist: ${docsRoot}`);
  }
  const files = listMarkdown(docsRoot).sort();
  const docs: DocRecord[] = [];
  const idsSeen = new Map<string, string>();
  const symbolsSeen = new Map<string, string>();

  for (const file of files) {
    const { frontmatter, body } = parseDoc(file);
    const rel = path.relative(docsRoot, file).split(path.sep).join('/');

    const prev = idsSeen.get(frontmatter.id);
    if (prev) {
      throw new Error(`Duplicate id "${frontmatter.id}" in ${rel} and ${prev}.`);
    }
    idsSeen.set(frontmatter.id, rel);

    if (frontmatter.symbols) {
      for (const symbol of frontmatter.symbols) {
        const previous = symbolsSeen.get(symbol);
        if (previous && previous !== frontmatter.id) {
          throw new Error(
            `Symbol "${symbol}" is claimed by both ${frontmatter.id} (${rel}) and ${previous}.`,
          );
        }
        symbolsSeen.set(symbol, frontmatter.id);
      }
    }

    docs.push({
      ...frontmatter,
      file: rel,
      bodyLength: body.length,
    });
  }

  // Resolve seeAlso ids — every reference must point at a doc we just saw.
  for (const doc of docs) {
    if (!doc.seeAlso) {
      continue;
    }
    for (const ref of doc.seeAlso) {
      if (!idsSeen.has(ref)) {
        throw new Error(`Doc ${doc.id} (${doc.file}): seeAlso "${ref}" does not resolve to any doc.`);
      }
    }
  }

  const generatedAt = new Date().toISOString();
  return {
    index: { schemaVersion: 1, generatedAt, docs },
    apiIndex: { schemaVersion: 1, generatedAt, symbols: Object.fromEntries(symbolsSeen) },
  };
}

export function writeManifests(docsRoot: string): { index: IndexFile; apiIndex: ApiIndexFile } {
  const result = buildManifests(docsRoot);
  fs.writeFileSync(
    path.join(docsRoot, 'index.json'),
    JSON.stringify(result.index, null, 2) + '\n',
  );
  fs.mkdirSync(path.join(docsRoot, 'api'), { recursive: true });
  fs.writeFileSync(
    path.join(docsRoot, 'api', 'index.json'),
    JSON.stringify(result.apiIndex, null, 2) + '\n',
  );
  return result;
}

// CLI entry — when invoked directly, build using the repo's llm-docs/.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = writeManifests(DOCS_ROOT);
    console.log(
      `Wrote llm-docs/index.json (${result.index.docs.length} docs) and llm-docs/api/index.json (${Object.keys(result.apiIndex.symbols).length} symbols).`,
    );
  } catch (err: any) {
    console.error(err?.message ?? err);
    process.exit(1);
  }
}

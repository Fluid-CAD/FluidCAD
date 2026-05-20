// In-memory index over `llm-docs/`.
//
// Loaded once at MCP startup. Resolves the on-disk docs root (either the
// published `node_modules/fluidcad/llm-docs/` or the in-repo `<root>/llm-docs/`
// during dev), reads the two manifests written by `scripts/build-llm-docs.ts`,
// and builds an inverted index for `search_docs`.
//
// Bodies are loaded lazily on first read and cached. The seed set is small
// (single-digit MB at most) so we don't bother with any external search dep
// or LRU bookkeeping — a Map is plenty.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

export type DocRecord = {
  id: string;
  title: string;
  summary: string;
  tags?: string[];
  symbols?: string[];
  seeAlso?: string[];
  file: string;
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
  symbols: Record<string, string>;
};

export type SearchHit = {
  id: string;
  title: string;
  snippet: string;
  score: number;
};

type Field = 'title' | 'summary' | 'tags' | 'body';

const FIELD_WEIGHT: Record<Field, number> = {
  title: 5,
  summary: 3,
  tags: 4,
  body: 1,
};

// Small fixed stopword set. Kept tiny on purpose — the corpus is small and we
// want exact lookups like "z" or "ts" to still work for users.
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has',
  'have', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'to',
  'was', 'were', 'will', 'with',
]);

export class DocsIndex {
  /** Absolute path to the docs root directory. */
  public readonly root: string;
  /** Every doc record, in the order they were emitted by the build script. */
  public readonly docs: ReadonlyArray<DocRecord>;
  /** Symbol -> docId (from `llm-docs/api/index.json`). */
  public readonly symbols: Readonly<Record<string, string>>;

  private readonly byId: Map<string, DocRecord>;
  private readonly bodyCache = new Map<string, string>();
  /** token -> docId -> per-field hit counts. */
  private readonly inverted: Map<string, Map<string, Record<Field, number>>>;

  constructor(root: string, index: IndexFile, apiIndex: ApiIndexFile) {
    this.root = root;
    this.docs = index.docs;
    this.symbols = apiIndex.symbols;
    this.byId = new Map(index.docs.map((d) => [d.id, d]));
    this.inverted = this.buildInverted();
  }

  /** All docs, optionally filtered to those carrying a given tag. */
  public list(tag?: string): DocRecord[] {
    if (!tag) {
      return [...this.docs];
    }
    return this.docs.filter((d) => (d.tags ?? []).includes(tag));
  }

  public get(id: string): DocRecord | null {
    return this.byId.get(id) ?? null;
  }

  /**
   * Load the markdown body for a doc id, stripping the YAML frontmatter so
   * callers see the same text the docs author wrote (no metadata clutter).
   */
  public body(id: string): string | null {
    const cached = this.bodyCache.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const doc = this.byId.get(id);
    if (!doc) {
      return null;
    }
    const raw = fs.readFileSync(path.join(this.root, doc.file), 'utf8');
    const body = stripFrontmatter(raw);
    this.bodyCache.set(id, body);
    return body;
  }

  /** Keyword search. Returns ranked hits with an ~80-char snippet per result. */
  public search(query: string, limit = 10): SearchHit[] {
    const tokens = tokenize(query);
    if (tokens.length === 0) {
      return [];
    }
    const scores = new Map<string, number>();
    for (const token of tokens) {
      const postings = this.inverted.get(token);
      if (!postings) {
        continue;
      }
      for (const [docId, hits] of postings) {
        let local = 0;
        local += hits.title * FIELD_WEIGHT.title;
        local += hits.summary * FIELD_WEIGHT.summary;
        local += hits.tags * FIELD_WEIGHT.tags;
        local += hits.body * FIELD_WEIGHT.body;
        scores.set(docId, (scores.get(docId) ?? 0) + local);
      }
    }
    // Exact-symbol boost — agents often type the bare function name.
    for (const token of tokens) {
      const docId = this.symbols[token];
      if (docId) {
        scores.set(docId, (scores.get(docId) ?? 0) + 10);
      }
    }
    const ranked = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);

    return ranked.map(([docId, score]) => {
      const doc = this.byId.get(docId)!;
      return {
        id: doc.id,
        title: doc.title,
        snippet: this.snippet(doc.id, tokens),
        score,
      };
    });
  }

  /** First fenced code block in the body, used as a symbol's signature surface. */
  public firstCodeBlock(id: string): string | null {
    const body = this.body(id);
    if (!body) {
      return null;
    }
    const match = body.match(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/);
    return match ? match[1].trimEnd() : null;
  }

  private buildInverted(): Map<string, Map<string, Record<Field, number>>> {
    const inverted = new Map<string, Map<string, Record<Field, number>>>();
    const add = (token: string, docId: string, field: Field): void => {
      let perDoc = inverted.get(token);
      if (!perDoc) {
        perDoc = new Map();
        inverted.set(token, perDoc);
      }
      let hits = perDoc.get(docId);
      if (!hits) {
        hits = { title: 0, summary: 0, tags: 0, body: 0 };
        perDoc.set(docId, hits);
      }
      hits[field] += 1;
    };

    for (const doc of this.docs) {
      for (const t of tokenize(doc.title)) {
        add(t, doc.id, 'title');
      }
      for (const t of tokenize(doc.summary)) {
        add(t, doc.id, 'summary');
      }
      for (const tag of doc.tags ?? []) {
        for (const t of tokenize(tag)) {
          add(t, doc.id, 'tags');
        }
      }
      const body = this.body(doc.id);
      if (body) {
        for (const t of tokenize(body)) {
          add(t, doc.id, 'body');
        }
      }
    }
    return inverted;
  }

  private snippet(docId: string, tokens: string[]): string {
    const body = this.body(docId);
    if (!body) {
      return '';
    }
    const lower = body.toLowerCase();
    let bestIdx = -1;
    for (const token of tokens) {
      const i = lower.indexOf(token);
      if (i !== -1 && (bestIdx === -1 || i < bestIdx)) {
        bestIdx = i;
      }
    }
    if (bestIdx === -1) {
      return body.slice(0, 160).replace(/\s+/g, ' ').trim();
    }
    const start = Math.max(0, bestIdx - 40);
    const end = Math.min(body.length, bestIdx + 120);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < body.length ? '…' : '';
    return prefix + body.slice(start, end).replace(/\s+/g, ' ').trim() + suffix;
  }
}

/**
 * Locate the on-disk `llm-docs/` directory.
 *
 * Resolution order:
 *   1. The installed package — `require.resolve('fluidcad/package.json')` gives
 *      us the consumer's `node_modules/fluidcad/`, and `llm-docs/` sits next to
 *      that `package.json`.
 *   2. The in-repo path — walk up from this file (`mcp/src/` or `mcp/dist/`)
 *      until we hit a sibling `llm-docs/` directory.
 *
 * We never trust `process.cwd()`: the MCP process is launched by an external
 * client (Claude Desktop, etc.) so its CWD is whatever they happen to be in.
 */
export function resolveDocsRoot(): string {
  const here = fileURLToPath(import.meta.url);
  const require_ = createRequire(here);
  try {
    const pkg = require_.resolve('fluidcad/package.json');
    const candidate = path.join(path.dirname(pkg), 'llm-docs');
    if (fs.existsSync(path.join(candidate, 'index.json'))) {
      return candidate;
    }
  } catch {
    // Falls through to the dev-walkup path below.
  }
  let dir = path.dirname(here);
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'llm-docs');
    if (fs.existsSync(path.join(candidate, 'index.json'))) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error(
    `Could not locate llm-docs/ from ${here}. ` +
      `Run \`npm run build:llm-docs\` to generate the manifest, ` +
      `or ensure the package is installed.`,
  );
}

/**
 * Load the manifests from `<root>/index.json` and `<root>/api/index.json` and
 * construct the in-memory index. Throws (with a helpful message) if either
 * manifest is missing — that almost always means `build:llm-docs` was skipped.
 */
export function loadDocsIndex(root?: string): DocsIndex {
  const resolved = root ?? resolveDocsRoot();
  const indexPath = path.join(resolved, 'index.json');
  const apiIndexPath = path.join(resolved, 'api', 'index.json');
  if (!fs.existsSync(indexPath)) {
    throw new Error(
      `llm-docs manifest missing at ${indexPath}. Run \`npm run build:llm-docs\`.`,
    );
  }
  if (!fs.existsSync(apiIndexPath)) {
    throw new Error(
      `llm-docs api manifest missing at ${apiIndexPath}. Run \`npm run build:llm-docs\`.`,
    );
  }
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as IndexFile;
  const apiIndex = JSON.parse(fs.readFileSync(apiIndexPath, 'utf8')) as ApiIndexFile;
  return new DocsIndex(resolved, index, apiIndex);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

function stripFrontmatter(raw: string): string {
  const match = raw.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  return match ? match[1] : raw;
}

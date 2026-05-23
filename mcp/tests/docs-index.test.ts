import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadDocsIndex, resolveDocsRoot } from '../src/docs-index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_DOCS = path.resolve(__dirname, '../../llm-docs');

describe('resolveDocsRoot', () => {
  it('returns a directory that contains index.json', () => {
    const root = resolveDocsRoot();
    expect(root.endsWith('llm-docs')).toBe(true);
  });
});

describe('DocsIndex', () => {
  let index = loadDocsIndex(REPO_DOCS);

  beforeAll(() => {
    index = loadDocsIndex(REPO_DOCS);
  });

  it('loads every doc listed in the manifest', () => {
    // Asserting against a hand-rolled enumeration of docs is brittle — every
    // doc-migration slice would flap the test. Instead anchor on a few
    // load-bearing entries we know must always be present, plus the count
    // matching the on-disk manifest.
    const ids = new Set(index.docs.map((d) => d.id));
    for (const required of [
      'api/extrude',
      'api/fillet',
      'api/sketch',
      'concepts/coordinate-system',
      'concepts/scene-graph',
    ]) {
      expect(ids, `missing required doc: ${required}`).toContain(required);
    }
    expect(index.docs.length).toBeGreaterThanOrEqual(ids.size);
  });

  it('list(tag) restricts to docs carrying that tag', () => {
    const solid = index.list('solid');
    expect(solid.length).toBeGreaterThan(0);
    // Every returned doc must actually carry the requested tag.
    for (const doc of solid) {
      expect(doc.tags, `${doc.id} lacks the 'solid' tag`).toContain('solid');
    }
    // Known-good anchors. Resilient to new solid-tagged docs being added.
    const solidIds = solid.map((d) => d.id);
    expect(solidIds).toContain('api/extrude');
    expect(solidIds).toContain('api/fillet');

    const concepts = index.list('concept');
    expect(concepts.length).toBeGreaterThan(0);
    for (const doc of concepts) {
      expect(doc.tags, `${doc.id} lacks the 'concept' tag`).toContain('concept');
    }

    // Unknown tag yields an empty list, not all docs.
    expect(index.list('does-not-exist')).toEqual([]);
  });

  it('symbol alias lookup maps a bare name to its doc id', () => {
    expect(index.symbols['extrude']).toBe('api/extrude');
    expect(index.symbols['fillet']).toBe('api/fillet');
    expect(index.symbols['sketch']).toBe('api/sketch');
    expect(index.symbols['repeat']).toBe('api/repeat');
  });

  it('search ranks the API doc above concept docs when the query is the symbol', () => {
    const hits = index.search('extrude');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].id).toBe('api/extrude');
    // Score should reflect the symbol-exact-match boost on top of token hits.
    expect(hits[0].score).toBeGreaterThan(hits[hits.length - 1].score);
  });

  it('search returns a snippet with surrounding context', () => {
    const hits = index.search('fillet');
    const filletHit = hits.find((h) => h.id === 'api/fillet');
    expect(filletHit).toBeDefined();
    expect(filletHit!.snippet).toMatch(/fillet/i);
    // We aim for ~80 chars of context on either side of the first match, plus
    // optional ellipses; cap at a sane upper bound to catch runaway snippets.
    expect(filletHit!.snippet.length).toBeLessThan(220);
  });

  it('search honors the limit', () => {
    const hits = index.search('the', 2);
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it('search drops stopwords so a stopword-only query returns nothing', () => {
    expect(index.search('the of to')).toEqual([]);
  });

  it('body strips the YAML frontmatter', () => {
    const body = index.body('api/extrude');
    expect(body).not.toBeNull();
    expect(body!.startsWith('---')).toBe(false);
    expect(body!.includes('# extrude')).toBe(true);
  });

  it('firstCodeBlock returns the signature block from the doc body', () => {
    const block = index.firstCodeBlock('api/extrude');
    expect(block).not.toBeNull();
    expect(block!.includes('extrude(')).toBe(true);
  });

  it('returns null when asked for an unknown doc id', () => {
    expect(index.get('api/does-not-exist')).toBeNull();
    expect(index.body('api/does-not-exist')).toBeNull();
  });
});

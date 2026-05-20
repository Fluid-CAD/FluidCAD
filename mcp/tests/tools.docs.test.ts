import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.ts';
import { loadDocsIndex, type DocsIndex } from '../src/docs-index.ts';
import {
  getApiSignature,
  listDocs,
  readDoc,
  searchDocs,
} from '../src/tools/docs.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_DOCS = path.resolve(__dirname, '../../llm-docs');

describe('doc tools (unit)', () => {
  let index: DocsIndex;
  beforeAll(() => {
    index = loadDocsIndex(REPO_DOCS);
  });

  it('list_docs returns every seed entry by default', () => {
    const result = listDocs(index);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.docs.length).toBe(index.docs.length);
    const first = result.data.docs[0];
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('title');
    expect(first).toHaveProperty('summary');
  });

  it('list_docs filters by tag', () => {
    const result = listDocs(index, { tag: 'solid' });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.docs.length).toBeGreaterThan(0);
    for (const doc of result.data.docs) {
      expect(doc.tags, `${doc.id} lacks the 'solid' tag`).toContain('solid');
    }
    const ids = result.data.docs.map((d) => d.id);
    expect(ids).toContain('api/extrude');
    expect(ids).toContain('api/fillet');
  });

  it('read_doc returns the markdown body and seeAlso for a known id', () => {
    const result = readDoc(index, { id: 'api/extrude' });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.id).toBe('api/extrude');
    expect(result.data.body).toMatch(/# extrude/);
    expect(result.data.seeAlso).toBeDefined();
    expect(result.data.seeAlso!.length).toBeGreaterThan(0);
  });

  it('read_doc reports invalid-input for an unknown id', () => {
    const result = readDoc(index, { id: 'api/does-not-exist' });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('invalid-input');
  });

  it('read_doc reports invalid-input when id is missing', () => {
    const result = readDoc(index, { id: '' as string });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('invalid-input');
  });

  it('search_docs returns ranked hits with the symbol-match boost', () => {
    const result = searchDocs(index, { query: 'fillet' });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.results.length).toBeGreaterThan(0);
    expect(result.data.results[0].id).toBe('api/fillet');
  });

  it('search_docs honors the limit', () => {
    const result = searchDocs(index, { query: 'scene', limit: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.results.length).toBeLessThanOrEqual(1);
  });

  it('search_docs rejects an empty query', () => {
    const result = searchDocs(index, { query: '' });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('invalid-input');
  });

  it('get_api_signature returns signature + summary for a known symbol', () => {
    const result = getApiSignature(index, { name: 'extrude' });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.symbol).toBe('extrude');
    expect(result.data.docId).toBe('api/extrude');
    expect(result.data.signature).toMatch(/extrude\(/);
    expect(result.data.summary.length).toBeGreaterThan(0);
  });

  it('get_api_signature reports invalid-input for an unknown symbol', () => {
    const result = getApiSignature(index, { name: 'doesNotExist' });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('invalid-input');
  });
});

describe('doc tools (over MCP)', () => {
  it('the MCP client sees the documentation tools alongside workspace + inspection tools', async () => {
    const index = loadDocsIndex(REPO_DOCS);
    const server = buildServer({ docsIndex: index });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      const names = new Set(tools.tools.map((t) => t.name));
      for (const expected of [
        'get_api_signature',
        'list_docs',
        'list_workspaces',
        'read_doc',
        'search_docs',
      ]) {
        expect(names.has(expected)).toBe(true);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('search_docs over MCP returns a parseable payload', async () => {
    const index = loadDocsIndex(REPO_DOCS);
    const server = buildServer({ docsIndex: index });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: 'search_docs',
        arguments: { query: 'extrude' },
      });
      expect(result.isError).not.toBe(true);
      const payload = JSON.parse((result.content as any[])[0].text);
      expect(Array.isArray(payload.results)).toBe(true);
      expect(payload.results[0].id).toBe('api/extrude');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('the MCP client sees the overview and per-symbol resources', async () => {
    const index = loadDocsIndex(REPO_DOCS);
    const server = buildServer({ docsIndex: index });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const resources = await client.listResources();
      const uris = resources.resources.map((r) => r.uri);
      expect(uris).toContain('fluidcad-docs://overview');
      expect(uris).toContain('fluidcad-docs://api/extrude');
      expect(uris).toContain('fluidcad-docs://guide/scene-graph');

      const overview = await client.readResource({ uri: 'fluidcad-docs://overview' });
      const text = (overview.contents[0] as any).text as string;
      expect(text).toMatch(/# FluidCAD docs/);
      expect(text).toMatch(/api\/extrude/);

      const apiDoc = await client.readResource({ uri: 'fluidcad-docs://api/extrude' });
      expect((apiDoc.contents[0] as any).text).toMatch(/# extrude/);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

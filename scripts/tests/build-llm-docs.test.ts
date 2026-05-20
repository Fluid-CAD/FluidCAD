import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildManifests, parseDoc } from '../build-llm-docs.ts';

let root: string;

function writeDoc(rel: string, frontmatter: Record<string, unknown>, body: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const yaml = Object.entries(frontmatter)
    .map(([k, v]) => {
      if (Array.isArray(v)) {
        return `${k}: [${v.map((x) => String(x)).join(', ')}]`;
      }
      return `${k}: ${String(v)}`;
    })
    .join('\n');
  fs.writeFileSync(full, `---\n${yaml}\n---\n${body}\n`);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-llm-docs-test-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('parseDoc', () => {
  it('parses required fields', () => {
    writeDoc('api/x.md', {
      id: 'api/x',
      title: 'x()',
      summary: 's',
      tags: ['api'],
      symbols: ['x'],
    }, 'body');
    const parsed = parseDoc(path.join(root, 'api/x.md'));
    expect(parsed.frontmatter.id).toBe('api/x');
    expect(parsed.frontmatter.symbols).toEqual(['x']);
    expect(parsed.body.trim()).toBe('body');
  });

  it('throws on missing frontmatter', () => {
    const file = path.join(root, 'bad.md');
    fs.writeFileSync(file, '# no frontmatter\n');
    expect(() => parseDoc(file)).toThrow(/frontmatter/);
  });

  it('throws when id is missing', () => {
    writeDoc('bad.md', { title: 't', summary: 's' }, 'body');
    expect(() => parseDoc(path.join(root, 'bad.md'))).toThrow(/`id`/);
  });
});

describe('buildManifests', () => {
  it('builds an index with one entry per doc and a symbol map', () => {
    writeDoc('api/foo.md', { id: 'api/foo', title: 'foo()', summary: 's', symbols: ['foo'] }, 'foo body');
    writeDoc('api/bar.md', { id: 'api/bar', title: 'bar()', summary: 's', symbols: ['bar', 'barAlias'] }, 'bar body');
    writeDoc('concepts/thing.md', { id: 'concepts/thing', title: 'Thing', summary: 's' }, 'concept body');

    const { index, apiIndex } = buildManifests(root);

    expect(index.docs).toHaveLength(3);
    expect(index.docs.map((d) => d.id).sort()).toEqual(['api/bar', 'api/foo', 'concepts/thing']);
    expect(index.docs.find((d) => d.id === 'api/foo')?.file).toBe('api/foo.md');

    expect(apiIndex.symbols).toEqual({
      foo: 'api/foo',
      bar: 'api/bar',
      barAlias: 'api/bar',
    });
  });

  it('rejects duplicate ids', () => {
    writeDoc('a.md', { id: 'api/x', title: 't', summary: 's' }, '');
    writeDoc('b.md', { id: 'api/x', title: 't', summary: 's' }, '');
    expect(() => buildManifests(root)).toThrow(/Duplicate id/);
  });

  it('rejects symbol collisions across files', () => {
    writeDoc('a.md', { id: 'api/a', title: 't', summary: 's', symbols: ['shared'] }, '');
    writeDoc('b.md', { id: 'api/b', title: 't', summary: 's', symbols: ['shared'] }, '');
    expect(() => buildManifests(root)).toThrow(/Symbol "shared" is claimed/);
  });

  it('rejects unresolvable seeAlso references', () => {
    writeDoc('a.md', { id: 'api/a', title: 't', summary: 's', seeAlso: ['api/ghost'] }, '');
    expect(() => buildManifests(root)).toThrow(/seeAlso "api\/ghost" does not resolve/);
  });

  it('records body length per doc', () => {
    writeDoc('a.md', { id: 'api/a', title: 't', summary: 's' }, 'hello world');
    const { index } = buildManifests(root);
    expect(index.docs[0].bodyLength).toBe('hello world\n'.length);
  });
});

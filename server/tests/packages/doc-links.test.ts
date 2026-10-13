import { describe, it, expect } from 'vitest';
import { DocLinks } from '../../src/packages/doc-links.ts';

// The doc pages' link scanner (package-docs DOC6): what pack's `docs-link`
// warning reads. A small scanner, not a markdown parser: inline links and
// images, reference definitions, code spans and fenced blocks skipped.

const targets = (markdown: string) => DocLinks.scan(markdown).map((l) => `${l.line}:${l.target}`);

describe('DocLinks.scan', () => {
  it('reads inline links, images, titles and reference definitions, with their lines', () => {
    const page = [
      '# Standoff',
      '',
      'See [the fastener](./fastener.md) and ![a standoff](images/standoff.svg "A standoff").',
      'The [README](<../README.md>) explains the rest.',
      '',
      '[spec]: ./spec.md "The spec"',
      '   [logo]: <images/logo with space.png>',
    ].join('\n');
    expect(targets(page)).toEqual([
      '3:./fastener.md',
      '3:images/standoff.svg',
      '4:../README.md',
      '6:./spec.md',
      '7:images/logo with space.png',
    ]);
  });

  it('reads an image inside a link, and keeps balanced parentheses in a target', () => {
    expect(targets('[![shot](images/shot.png)](./guide.md)')).toEqual(['1:images/shot.png', '1:./guide.md']);
    expect(targets('[wiki](https://en.wikipedia.org/wiki/Standoff_(hardware)) here')).toEqual([
      '1:https://en.wikipedia.org/wiki/Standoff_(hardware)',
    ]);
  });

  it('skips code spans and fenced blocks, backticks and tildes (a longer fence closes a shorter one)', () => {
    const page = [
      'Write `[label](./not-a-link.md)` in a page, or ``[x](`y`.md)``.',
      '```md',
      '![example](./example-in-fence.png)',
      '````',
      '[after](./after-backticks.md)',
      '~~~',
      '[tilde](./in-tilde.md)',
      '~~~',
      '[real](./real.md)',
    ].join('\n');
    expect(targets(page)).toEqual(['5:./after-backticks.md', '9:./real.md']);
  });

  it('reads nothing from text without links', () => {
    expect(targets('Plain text with (parentheses) and [brackets] but no link.\n')).toEqual([]);
    expect(targets('')).toEqual([]);
  });
});

describe('DocLinks.resolve', () => {
  it('resolves a relative target against the page, without its query or fragment', () => {
    expect(DocLinks.resolve('docs/standoff.md', './images/standoff.svg')).toEqual({ kind: 'file', path: 'docs/images/standoff.svg' });
    expect(DocLinks.resolve('docs/guide/holes.md', '../standoff.md#usage')).toEqual({ kind: 'file', path: 'docs/standoff.md' });
    expect(DocLinks.resolve('docs/standoff.md', '../README.md?raw=1')).toEqual({ kind: 'file', path: 'README.md' });
    expect(DocLinks.resolve('docs/standoff.md', 'images/a%20b.png')).toEqual({ kind: 'file', path: 'docs/images/a b.png' });
  });

  it('says when a target leaves the package: above the root, or root-absolute', () => {
    expect(DocLinks.resolve('docs/standoff.md', '../../outside.md')).toEqual({ kind: 'outside' });
    expect(DocLinks.resolve('docs/standoff.md', '/etc/passwd')).toEqual({ kind: 'outside' });
  });

  it('never checks an absolute URL, another scheme, a protocol-relative link or an in-page anchor', () => {
    for (const target of ['https://fluidcad.io/docs', 'http://example.com', 'mailto:a@b.c', '//cdn.example.com/x.png', '#usage', '']) {
      expect(DocLinks.resolve('docs/standoff.md', target), target).toBeNull();
    }
  });
});

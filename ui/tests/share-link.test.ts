import { describe, it, expect } from 'vitest';
import { buildViewerLink, classifyShareFile, linkSizeProblem, MAX_LINK_CHARS } from '../src/ui/share-dialog';

// The exact inverse of the viewer's loaders.js decoders (base64url + deflate-raw).
async function decodeFragment(packed: string): Promise<string> {
  const base64 = packed.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

describe('share link — what the Share dialog opens', () => {
  it('sends one model as #code= and a tree as #files= with its names, round-tripping byte for byte', async () => {
    const single = await buildViewerLink({ fluidcadVersion: '0.0.42', entry: 'box.part.js', files: { 'box.part.js': 'export const b = 1;\n' } }, 'https://v.test');
    const singleParams = new URLSearchParams(new URL(single).hash.slice(1));
    expect(singleParams.get('v')).toBe('0.0.42');
    expect(singleParams.get('entry')).toBe('box.part.js');
    expect(singleParams.has('files')).toBe(false);
    expect(await decodeFragment(singleParams.get('code')!)).toBe('export const b = 1;\n');

    const files = { 'model.fluid.js': "import { h } from './lib/h.js';\n", 'lib/h.js': 'export const h = 1; // ünïcödé\n', 'fluidcad.json': '{"unit":"in"}' };
    const tree = await buildViewerLink({ fluidcadVersion: '0.0.42', entry: 'model.fluid.js', files }, 'https://v.test');
    const treeParams = new URLSearchParams(new URL(tree).hash.slice(1));
    expect(treeParams.has('entry')).toBe(false); // model.fluid.js is the viewer's default
    expect(treeParams.has('code')).toBe(false);
    expect(JSON.parse(await decodeFragment(treeParams.get('files')!))).toEqual(files);
  });

  it('flags data files in the file list and names the unit file', () => {
    expect(classifyShareFile('box.part.js')).toBe('model');
    expect(classifyShareFile('parts/hinge.assembly.js')).toBe('model');
    expect(classifyShareFile('init.js')).toBe('script');
    expect(classifyShareFile('lib/helpers.mjs')).toBe('script');
    expect(classifyShareFile('fluidcad.json')).toBe('unit');
    expect(classifyShareFile('d/creds.json')).toBe('data');
    expect(classifyShareFile('note.txt')).toBe('data');
  });

  it('refuses a link past the cap with a message, and accepts one at it', () => {
    expect(linkSizeProblem('x'.repeat(MAX_LINK_CHARS))).toBeNull();
    expect(linkSizeProblem('x'.repeat(MAX_LINK_CHARS + 1))).toMatch(/too large to share as a link/);
  });
});

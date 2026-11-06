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

  it('keeps a text tree byte for byte as before, and carries a binary file as { b64 } in #files=', async () => {
    const text = { 'model.fluid.js': "import { h } from './lib/h.js';\n", 'lib/h.js': 'export const h = 1;\n' };
    const textLink = await buildViewerLink({ fluidcadVersion: '0.0.48', entry: 'model.fluid.js', files: text }, 'https://v.test');
    const textParams = new URLSearchParams(new URL(textLink).hash.slice(1));
    // The same fragment the share flow has always written: the JSON of the map, nothing added.
    expect(textParams.get('files')).toBe(await encodeText(JSON.stringify(text)));

    const files = { 'label.part.js': "text('xy', 'Hi').font('./fonts/brand.ttf');\n", 'fonts/brand.ttf': { b64: 'AAEAAP/+gEE=' } };
    const link = await buildViewerLink({ fluidcadVersion: '0.0.48', entry: 'label.part.js', files }, 'https://v.test');
    const params = new URLSearchParams(new URL(link).hash.slice(1));
    expect(params.has('code')).toBe(false);
    expect(JSON.parse(await decodeFragment(params.get('files')!))).toEqual(files);
  });

  it('carries the configurations() row on screen as configuration=, and leaves Default out', async () => {
    const share = { fluidcadVersion: '0.0.47', entry: 'rack.assembly.js', files: { 'rack.assembly.js': 'export const r = 1;\n' } };
    const wide = new URLSearchParams(new URL(await buildViewerLink(share, 'https://v.test', 'Extra wide')).hash.slice(1));
    expect(wide.get('configuration')).toBe('Extra wide');
    for (const none of ['Default', null]) {
      const params = new URLSearchParams(new URL(await buildViewerLink(share, 'https://v.test', none)).hash.slice(1));
      expect(params.has('configuration')).toBe(false);
    }
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

  it('files an imported STEP file\'s cache and sidecars as imported geometry, and only under imports/', () => {
    expect(classifyShareFile('imports/motor.brep')).toBe('geometry');
    expect(classifyShareFile('imports/motor.colors.json')).toBe('geometry');
    expect(classifyShareFile('imports/motor.import.json')).toBe('geometry');
    expect(classifyShareFile('imports/sub/bracket.brep')).toBe('geometry');
    expect(classifyShareFile('imports/notes.json')).toBe('data');
    expect(classifyShareFile('data/motor.colors.json')).toBe('data');
    expect(classifyShareFile('motor.brep')).toBe('data');
  });

  it('files a font file as a workspace font wherever it sits', () => {
    for (const path of ['fonts/brand.ttf', 'Brand.OTF', 'assets/type/serif.woff2', 'a.woff', 'b.ttc', 'c.dfont']) {
      expect(classifyShareFile(path)).toBe('font');
    }
    expect(classifyShareFile('fonts/LICENSE.txt')).toBe('data');
  });

  it('refuses a link past the cap with a message, and accepts one at it', async () => {
    expect(await linkSizeProblem('x'.repeat(MAX_LINK_CHARS))).toBeNull();
    expect(await linkSizeProblem('x'.repeat(MAX_LINK_CHARS + 1))).toMatch(/too large to share as a link/);
  });

  it('says the imported model makes a link too large when the link would fit without it', async () => {
    const model = "import { load } from 'fluidcad/core';\nload('motor.step');\n";
    const share = {
      fluidcadVersion: '0.0.48',
      entry: 'motor.part.js',
      files: { 'motor.part.js': model, 'imports/motor.brep': incompressible(2 * MAX_LINK_CHARS), 'imports/motor.colors.json': '[]' },
    };
    const url = await buildViewerLink(share, 'https://v.test');
    expect(url.length).toBeGreaterThan(MAX_LINK_CHARS);

    const problem = await linkSizeProblem(url, share, 'https://v.test');
    expect(problem).toMatch(/too large to share as a link/);
    expect(problem).toMatch(/The imported model imports\/motor\.brep is what makes it too large\./);
  });

  it('names a workspace font, or a font and an imported model, as what makes a link too large', async () => {
    const font = { b64: btoa(incompressible(2 * MAX_LINK_CHARS)) };
    const fontOnly = {
      fluidcadVersion: '0.0.48',
      entry: 'label.part.js',
      files: { 'label.part.js': "text('xy', 'Hi').font('fonts/brand.ttf');\n", 'fonts/brand.ttf': font },
    };
    const fontLink = await buildViewerLink(fontOnly, 'https://v.test');
    expect(await linkSizeProblem(fontLink, fontOnly, 'https://v.test'))
      .toMatch(/The workspace font fonts\/brand\.ttf is what makes it too large\./);

    const both = { ...fontOnly, files: { ...fontOnly.files, 'imports/motor.brep': incompressible(MAX_LINK_CHARS) } };
    const bothLink = await buildViewerLink(both, 'https://v.test');
    expect(await linkSizeProblem(bothLink, both, 'https://v.test'))
      .toMatch(/The imported model imports\/motor\.brep and the workspace font fonts\/brand\.ttf are what make it too large\./);
  });

  it('keeps the plain refusal when the source alone is past the cap', async () => {
    const share = {
      fluidcadVersion: '0.0.48',
      entry: 'motor.part.js',
      files: { 'motor.part.js': `// ${incompressible(2 * MAX_LINK_CHARS)}\n`, 'imports/motor.brep': 'brep' },
    };
    const url = await buildViewerLink(share, 'https://v.test');

    const problem = await linkSizeProblem(url, share, 'https://v.test');
    expect(problem).toMatch(/too large to share as a link/);
    expect(problem).not.toMatch(/imported/);
  });
});

// The share flow's own packing (base64url(deflate-raw(text))), to compare fragments against.
async function encodeText(text: string): Promise<string> {
  const stream = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Text deflate barely shrinks (base36 digits): a link built from it grows about as long as it. */
function incompressible(length: number): string {
  let seed = 7;
  let text = '';
  while (text.length < length) {
    seed = (seed * 48271) % 2147483647;
    text += seed.toString(36);
  }
  return text.slice(0, length);
}

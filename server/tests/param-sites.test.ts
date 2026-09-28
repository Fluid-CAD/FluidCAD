import { describe, it, expect } from 'vitest';
import { ParamSites, type ParamSiteDefinition } from '../src/apply-feature-edit/index.ts';
import { getJavaScriptParser, LexicalBindings, walkTree, type TSNode } from '../src/code-editor/index.ts';

const FILE = '/ws/cabinet.part.js';

/** Two parts of one file, each declaring its own `'Width'`. */
const CABINET = [
  `import { part, param } from 'fluidcad/core'`,
  `export const drawer = part('Drawer', () => {`,
  `  const width = param('Width', 400)`,
  `  const depth = param('Depth', 500)`,
  `})`,
  `export const box = part('Box', () => {`,
  `  const width = param('Width', 500)`,
  `})`,
].join('\n');

/** A definition the render captured for the `param()` call on `line` of `filePath`. */
function definedAt(label: string, currentValue: unknown, line: number, filePath = FILE): ParamSiteDefinition {
  return { label, currentValue, sourceLocation: { filePath, line } };
}

/** The sites of `code` against `definitions`, and its `param(…)` calls in source order. */
async function sitesOf(code: string, definitions: ParamSiteDefinition[]): Promise<{ sites: ParamSites; calls: TSNode[] }> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const sites = new ParamSites(new LexicalBindings(tree), FILE, definitions);
  const calls = [...walkTree(tree.rootNode)].filter((node: TSNode) => node.type === 'call_expression'
    && node.childForFieldName('function')?.text === 'param');
  return { sites, calls };
}

describe('ParamSites', () => {
  it('matches each definition to the call on its line', async () => {
    const { sites, calls } = await sitesOf(CABINET, [definedAt('Width', 450, 3), definedAt('Width', 520, 7)]);
    expect(sites.definitionOf(calls[0])?.currentValue).toBe(450);
    expect(sites.definitionOf(calls[2])?.currentValue).toBe(520);
  });

  /**
   * The registry keeps one definition per label — here the Box's, declared
   * last. The Drawer's own `'Width'` call has none, rather than the Box's.
   */
  it("never hands one part another part's definition of a shared label", async () => {
    const { sites, calls } = await sitesOf(CABINET, [definedAt('Width', 520, 7)]);
    expect(sites.definitionOf(calls[0])).toBeNull();
    expect(sites.definitionOf(calls[2])?.currentValue).toBe(520);
  });

  it('follows a label the file spells once after its line moved', async () => {
    const { sites, calls } = await sitesOf(CABINET, [definedAt('Depth', 600, 9)]);
    expect(sites.definitionOf(calls[1])?.currentValue).toBe(600);
  });

  it('reads a definition without a location by its label, only when that is unambiguous', async () => {
    const { sites, calls } = await sitesOf(CABINET, [
      { label: 'Depth', currentValue: 600 },
      { label: 'Width', currentValue: 450 },
    ]);
    expect(sites.definitionOf(calls[1])?.currentValue).toBe(600);
    expect(sites.definitionOf(calls[0])).toBeNull();
    expect(sites.definitionOf(calls[2])).toBeNull();
  });

  it("ignores another file's definition of the same label", async () => {
    const { sites, calls } = await sitesOf(CABINET, [definedAt('Depth', 600, 4, '/ws/other.part.js')]);
    expect(sites.definitionOf(calls[1])).toBeNull();
  });

  it('refuses a definition whose label the source no longer spells at that line', async () => {
    const { sites, calls } = await sitesOf(CABINET, [definedAt('Length', 600, 4)]);
    expect(sites.definitionOf(calls[1])).toBeNull();
  });

  it('matches paths however their separators are spelled', async () => {
    const parser = await getJavaScriptParser();
    const tree = parser.parse(`part('P', () => {\n  const d = param('Depth', 5)\n})`);
    const sites = new ParamSites(new LexicalBindings(tree), 'C:\\ws\\m.part.js', [definedAt('Depth', 7, 2, 'c:/ws/m.part.js')]);
    const call = [...walkTree(tree.rootNode)].find((node: TSNode) => node.type === 'call_expression'
      && node.childForFieldName('function')?.text === 'param')!;
    expect(sites.definitionOf(call)?.currentValue).toBe(7);
  });

  it('has nothing for a label it cannot read', async () => {
    const code = `import { part, param } from 'fluidcad/core'\npart('P', () => { const label = 'D'; param(label, 1) })`;
    const { sites, calls } = await sitesOf(code, [{ label: 'D', currentValue: 9 }]);
    expect(sites.definitionOf(calls[0])).toBeNull();
  });

  it("counts only the API's own calls toward a label's uniqueness", async () => {
    const code = [
      `import { part, param as declare } from 'fluidcad/core'`,
      `function param(label, value) { return value }`,
      `param('Depth', 1)`,
      `part('P', () => { const depth = declare('Depth', 500) })`,
    ].join('\n');
    const parser = await getJavaScriptParser();
    const tree = parser.parse(code);
    const sites = new ParamSites(new LexicalBindings(tree), FILE, [definedAt('Depth', 600, 9)]);
    const declared = [...walkTree(tree.rootNode)].find((node: TSNode) => node.type === 'call_expression'
      && node.childForFieldName('function')?.text === 'declare')!;
    expect(sites.definitionOf(declared)?.currentValue).toBe(600);
  });

  it("reads a call's default argument", async () => {
    const { calls } = await sitesOf(CABINET, []);
    expect(ParamSites.defaultOf(calls[1])?.text).toBe('500');
  });
});

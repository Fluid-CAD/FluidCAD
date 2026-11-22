import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.ts';

// Policy test for the skills under mcp/skills/. Skills teach workflow and
// tool descriptions teach mechanics, so a skill that names a tool the server
// does not register is drift: a renamed tool, or guidance written against a
// plan before the tool landed. Every backticked snake_case token in every
// skill markdown file must be a registered tool name.

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skills');

// The MCP server name the README registers (`claude mcp add ... FluidCAD`),
// which is what the `mcp__<name>__*` prefix in the skill frontmatter must use.
const SERVER_NAME = 'FluidCAD';

// Backticked snake_case tokens that are not tool names. Keep this short; a
// new entry needs a reason.
const NOT_TOOLS = new Set<string>([
  // JSON field name in the drawing transcription contract's output schema.
  'title_block',
]);

const TOOL_NAME_SHAPE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

function listMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listMarkdown(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out.sort();
}

function backtickedTokens(markdown: string): string[] {
  const tokens: string[] = [];
  for (const match of markdown.matchAll(/`([^`\n]+)`/g)) {
    tokens.push(match[1]);
  }
  return tokens;
}

function frontmatter(markdown: string): string {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  return match ? match[1] : '';
}

let registeredTools: Set<string>;

beforeAll(async () => {
  // The skills ship to the in-app chat too, whose server offers four tools
  // the standalone one does not (`ask_user`, `propose_variants`,
  // `offer_params`, `show_user`): a skill names those conditionally ("when
  // your tools include …").
  const server = buildServer({
    askUser: async () => ({ content: [] }),
    proposeVariants: async () => ({ content: [] }),
    offerParams: async () => ({ content: [] }),
    showUser: async () => ({ content: [] }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'skills-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    registeredTools = new Set(tools.map((t) => t.name));
  } finally {
    await client.close();
    await server.close();
  }
});

describe('skills policy', () => {
  const files = listMarkdown(skillsDir);

  it('names propose_variants as a tool only the in-app chat has, with when to call it, when not to and what it costs', () => {
    const core = fs.readFileSync(path.join(skillsDir, 'fluidcad', 'SKILL.md'), 'utf8');
    const start = core.indexOf('### `propose_variants`');
    expect(start).toBeGreaterThan(0);
    const block = core.slice(start, core.indexOf('\n## ', start));
    expect(block).toContain('When your tools include `propose_variants` (the in-app chat; a standalone MCP client does not have it)');
    expect(block).toContain('**The default is not to call it.**');
    expect(block).toContain('asks to see options or alternatives');
    expect(block).toContain('a rib versus a gusset');
    expect(block).toContain('differ only by a number');
    expect(block).toContain('to confirm a plan');
    expect(block).toContain('after every change');
    expect(block).toContain('Two full builds from scratch');
    expect(block).toContain('exactly two variants');
  });

  it('names offer_params as a tool only the in-app chat has, with when to call it and when not to', () => {
    const core = fs.readFileSync(path.join(skillsDir, 'fluidcad', 'SKILL.md'), 'utf8');
    const start = core.indexOf('### `offer_params`');
    expect(start).toBeGreaterThan(0);
    const block = core.slice(start, core.indexOf('\n## ', start));
    expect(block).toContain('When your tools include `offer_params` (the in-app chat; a standalone MCP client does not have it)');
    expect(block).toContain('**The default is not to call it.**');
    // When: the two triggers.
    expect(block).toContain('plausibly going to tune');
    expect(block).toContain('asks to play with the sizes');
    // When not.
    expect(block).toContain('after every edit');
    expect(block).toContain('gave exact values and asked for nothing else');
    expect(block).toContain('no dimension worth tuning');
    expect(block).toContain('already offered, unless they changed');
    expect(block).toContain('in place of a question that blocks the work');
    // What: a few, and never a parameter made for the card.
    expect(block).toContain('Offer the few parameters that matter, not all of them');
    expect(block).toContain('never add a `param()` only to have something to offer');
    expect(block).toContain('It does not wait for the user');
    expect(block).toContain('`<param_changes>`');
    // It sits after the variants block, and the standalone server still does not offer the tool.
    expect(start).toBeGreaterThan(core.indexOf('### `propose_variants`'));
  });

  it('names a pick question as something only the in-app chat can ask, with when to ask one and when not to', () => {
    const core = fs.readFileSync(path.join(skillsDir, 'fluidcad', 'SKILL.md'), 'utf8');
    const start = core.indexOf('### A pick question');
    expect(start).toBeGreaterThan(0);
    const block = core.slice(start, core.indexOf('\n### ', start + 5));
    expect(block).toContain('When your tools include `ask_user` (the in-app chat; a standalone MCP client does not have it)');
    expect(block).toContain('**The default is not to ask one.**');
    // When: all three.
    expect(block).toContain('only when all three hold');
    expect(block).toContain('The answer is a piece of the model');
    expect(block).toContain('The request leaves it genuinely ambiguous');
    expect(block).toContain('A wrong guess costs rework');
    // When not.
    expect(block).toContain('already attached the geometry to their message as a scene reference');
    expect(block).toContain('find it with `resolve_selection`');
    expect(block).toContain('when only one candidate exists');
    expect(block).toContain('a sensible default');
    // How, and what a client without it does.
    expect(block).toContain('`pick` or `options`, never both');
    expect(block).toContain('Without the tool, ask in words');
    // It belongs with naming geometry, after the resolve-first procedure.
    expect(start).toBeGreaterThan(core.indexOf('## Naming geometry'));
    expect(start).toBeLessThan(core.indexOf('## When something is wrong'));
  });

  it('names show_user as a tool only the in-app chat has, with when to point and when not to', () => {
    const core = fs.readFileSync(path.join(skillsDir, 'fluidcad', 'SKILL.md'), 'utf8');
    const start = core.indexOf('### `show_user`');
    expect(start).toBeGreaterThan(0);
    const block = core.slice(start, core.indexOf('\n## ', start));
    expect(block).toContain('When your tools include `show_user` (the in-app chat; a standalone MCP client does not have it)');
    expect(block).toContain('**The default is not to call it.**');
    expect(block).toContain('The user already sees the viewport');
    expect(block).toContain('It does not wait for the user');
    // When: the three triggers.
    expect(block).toContain('only when words would not locate the geometry reliably');
    expect(block).toContain('A problem you found on a particular face or edge');
    expect(block).toContain('The candidates of a question');
    expect(block).toContain('A proposal that touches particular geometry');
    // When not.
    expect(block).toContain('after every edit');
    expect(block).toContain('to illustrate what you just built');
    expect(block).toContain('for a whole body');
    expect(block).toContain('again in the same turn');
    // What: few items, by selector.
    expect(block).toContain('Show the few items your text refers to');
    expect(block).toContain('rather than a `ref`');
    expect(block).toContain('Without the tool');
    // After the pick question, in the same section.
    expect(start).toBeGreaterThan(core.indexOf('### A pick question'));
    expect(start).toBeLessThan(core.indexOf('## When something is wrong'));
  });

  it('finds the skill files', () => {
    const skillFiles = files.filter((f) => path.basename(f) === 'SKILL.md');
    expect(skillFiles.length).toBeGreaterThanOrEqual(3);
  });

  it('every backticked snake_case token in a skill is a registered tool', () => {
    const unknown: string[] = [];
    for (const file of files) {
      const markdown = fs.readFileSync(file, 'utf8');
      const seen = new Set<string>();
      for (const token of backtickedTokens(markdown)) {
        if (!TOOL_NAME_SHAPE.test(token) || NOT_TOOLS.has(token) || seen.has(token)) {
          continue;
        }
        seen.add(token);
        if (!registeredTools.has(token)) {
          unknown.push(`${path.relative(skillsDir, file)}: \`${token}\``);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it('the allowlist only carries tokens that are not tools', () => {
    for (const token of NOT_TOOLS) {
      expect(registeredTools.has(token), `${token} is a registered tool; drop it from NOT_TOOLS`).toBe(false);
    }
  });

  it('every SKILL.md frontmatter scalar is quoted or free of YAML-significant characters', () => {
    // `npx skills add` parses the frontmatter with a strict YAML parser. A
    // plain (unquoted) scalar that contains `: ` reads as a nested mapping
    // and the skill is skipped with "Nested mappings are not allowed in
    // compact mappings", so any description with a colon must be quoted.
    const skillFiles = files.filter((f) => path.basename(f) === 'SKILL.md');
    const bad: string[] = [];
    for (const file of skillFiles) {
      const fm = frontmatter(fs.readFileSync(file, 'utf8'));
      for (const line of fm.split('\n')) {
        const match = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
        if (!match) {
          bad.push(`${path.relative(skillsDir, file)}: not a key/value line: ${line}`);
          continue;
        }
        const value = match[2];
        const quoted = /^"(?:[^"\\]|\\.)*"$/.test(value) || /^'(?:[^']|'')*'$/.test(value);
        if (quoted) {
          continue;
        }
        if (/: | #|^[-?:,[\]{}#&*!|>'"%@`]/.test(value)) {
          bad.push(`${path.relative(skillsDir, file)}: unquoted ${match[1]} needs quoting: ${value.slice(0, 60)}...`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('the core FluidCAD skill points to every skill layered on it', () => {
    // An agent starts from the core skill: a layered skill it never names
    // (custom features, assemblies, drawings) is one the agent won't reach
    // for when the task turns that way.
    const core = fs.readFileSync(path.join(skillsDir, 'fluidcad', 'SKILL.md'), 'utf8');
    const layered = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'fluidcad')
      .map((entry) => entry.name);
    expect(layered).toContain('fluidcad-custom-features');
    for (const name of layered) {
      expect(core, `the FluidCAD skill never names ${name}`).toContain(`**${name}**`);
    }
  });

  it('every SKILL.md frontmatter names the MCP prefix with the registered server name', () => {
    const skillFiles = files.filter((f) => path.basename(f) === 'SKILL.md');
    for (const file of skillFiles) {
      const fm = frontmatter(fs.readFileSync(file, 'utf8'));
      expect(fm, `${file} has no frontmatter`).not.toBe('');
      const prefixes = [...fm.matchAll(/mcp__([A-Za-z0-9-]+)__/g)].map((m) => m[1]);
      expect(prefixes.length, `${file} names no mcp__<server>__ prefix`).toBeGreaterThan(0);
      for (const name of prefixes) {
        expect(name, `${file} uses mcp__${name}__; the README registers ${SERVER_NAME}`).toBe(SERVER_NAME);
      }
    }
  });
});

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
  const server = buildServer();
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

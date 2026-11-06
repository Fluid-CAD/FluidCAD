import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { buildServer } from '../src/server.ts';
import {
  loadSkillsIndex,
  parseFrontmatter,
  resolveSkillsRoot,
  stripFrontmatter,
  type SkillsIndex,
} from '../src/skills-index.ts';
import { SKILLS_EXTENSION_ID } from '../src/skills-extension.ts';
import { listSkills, readSkill } from '../src/tools/skills.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_SKILLS = path.resolve(__dirname, '../skills');
const SKILL_NAMES = ['fluidcad', 'fluidcad-assembly', 'fluidcad-custom-features', 'fluidcad-from-drawing'];

const AnyResult = z.looseObject({});

async function connect(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = buildServer({ skillsIndex: loadSkillsIndex(REPO_SKILLS) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

// The skills must ship with the npm package: the whole point of serving them
// is that an installed `fluidcad mcp` carries the workflow matching its own
// tools, instead of a copy frozen by `npx skills add` at install time.
describe('skills packaging', () => {
  it('mcp/skills/ is in the published files list', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
    expect(pkg.files).toContain('mcp/skills/');
  });

  it('resolves the in-repo skills root without consulting cwd', () => {
    expect(resolveSkillsRoot()).toBe(REPO_SKILLS);
  });
});

describe('skills index', () => {
  it('parses the frontmatter verbatim, including escaped quotes', () => {
    const fm = parseFrontmatter('---\nname: x\ndescription: "say \\"hi\\" — now"\nlicense: MIT\n---\n# body\n');
    expect(fm).toEqual({ name: 'x', description: 'say "hi" — now', license: 'MIT' });
  });

  it('strips the frontmatter block and nothing else', () => {
    expect(stripFrontmatter('---\nname: x\n---\n# Title\n\ntext')).toBe('# Title\n\ntext');
    expect(stripFrontmatter('# No frontmatter')).toBe('# No frontmatter');
  });

  it('indexes every skill with an Agent Skills-conformant name equal to its directory', () => {
    const index = loadSkillsIndex(REPO_SKILLS);
    expect(index.skills.map((s) => s.name)).toEqual(SKILL_NAMES);
    for (const skill of index.skills) {
      expect(skill.name).toBe(skill.dir);
      expect(skill.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(skill.description.length).toBeLessThanOrEqual(1024);
      expect(skill.files[0].path).toBe('SKILL.md');
    }
    const core = index.get('FluidCAD');
    expect(core).toBeDefined();
    expect(core!.files.map((f) => f.path)).toContain('references/traps.md');
    expect(core!.description).toMatch(/mcp__FluidCAD__\*/);
    expect(index.get('fluidcad-from-drawing')!.files.map((f) => f.path)).toContain(
      'scripts/merge-drawing-reads.mjs',
    );
  });

  it('rejects a skill whose name breaks the rules or differs from its directory', () => {
    const root = fs.mkdtempSync(path.join(__dirname, 'tmp-skills-'));
    try {
      fs.mkdirSync(path.join(root, 'Bad-Name'));
      fs.writeFileSync(path.join(root, 'Bad-Name', 'SKILL.md'), '---\nname: Bad-Name\ndescription: x\n---\n');
      expect(() => loadSkillsIndex(root)).toThrow(/lowercase/);
      fs.writeFileSync(path.join(root, 'Bad-Name', 'SKILL.md'), '---\nname: good\ndescription: x\n---\n');
      expect(() => loadSkillsIndex(root)).toThrow(/must equal its directory/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('carries a sha256 digest and byte size per file, over the raw bytes', () => {
    const index = loadSkillsIndex(REPO_SKILLS);
    for (const skill of index.skills) {
      for (const file of skill.files) {
        const bytes = fs.readFileSync(path.join(REPO_SKILLS, skill.dir, ...file.path.split('/')));
        expect(file.size).toBe(bytes.length);
        expect(file.digest).toBe(`sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`);
        expect(file.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      }
      // SEP-2640 limits: 512 resources and 16 MiB per skill.
      expect(skill.files.length).toBeLessThanOrEqual(512);
      expect(skill.files.reduce((n, f) => n + f.size, 0)).toBeLessThanOrEqual(16 * 1024 * 1024);
    }
  });

  it('never reads outside the skill directory', () => {
    const index = loadSkillsIndex(REPO_SKILLS);
    const core = index.get('fluidcad')!;
    expect(index.file(core, '../fluidcad-assembly/SKILL.md')).toBeUndefined();
    expect(index.file(core, '/etc/passwd')).toBeUndefined();
    expect(index.file(core, 'references/../../package.json')).toBeUndefined();
  });

  it('resolves skill:// uris to files, directories, or nothing', () => {
    const index = loadSkillsIndex(REPO_SKILLS);
    expect(index.resolve('skill://fluidcad/SKILL.md')!.file!.path).toBe('SKILL.md');
    expect(index.resolve('skill://fluidcad/references/traps.md')!.file!.path).toBe('references/traps.md');
    expect(index.resolve('skill://fluidcad')!.directory).toBe('');
    expect(index.resolve('skill://fluidcad/')!.directory).toBe('');
    expect(index.resolve('skill://fluidcad/references')!.directory).toBe('references');
    expect(index.resolve('skill://fluidcad/references/')!.directory).toBe('references');
    expect(index.resolve('skill://fluidcad/nope.md')).toBeUndefined();
    expect(index.resolve('skill://unknown/SKILL.md')).toBeUndefined();
    expect(index.resolve('fluidcad-docs://overview')).toBeUndefined();
  });
});

describe('skill tools (unit)', () => {
  let index: SkillsIndex;
  beforeAll(() => {
    index = loadSkillsIndex(REPO_SKILLS);
  });

  it('list_skills returns name, description, uri and files for every skill', () => {
    const result = listSkills(index);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.skills.map((s) => s.name)).toEqual(SKILL_NAMES);
    for (const skill of result.data.skills) {
      expect(skill.description.length).toBeGreaterThan(50);
      expect(skill.uri).toBe(`skill://${skill.name}/SKILL.md`);
      expect(skill.files[0]).toBe('SKILL.md');
    }
  });

  it('read_skill returns SKILL.md with the frontmatter stripped', () => {
    const result = readSkill(index, { name: 'fluidcad' });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.file).toBe('SKILL.md');
    expect(result.data.uri).toBe('skill://fluidcad/SKILL.md');
    expect(result.data.body.startsWith('---')).toBe(false);
    expect(result.data.body).toMatch(/references\/traps\.md/);
    expect(result.data.description).toMatch(/FluidCAD/);
    expect(result.data.files).toContain('references/verification.md');
  });

  it('read_skill is case-insensitive on the name', () => {
    const result = readSkill(index, { name: 'FluidCAD-Assembly' });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.name).toBe('fluidcad-assembly');
  });

  it('read_skill with file returns a reference verbatim', () => {
    const result = readSkill(index, { name: 'fluidcad', file: 'references/traps.md' });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const onDisk = fs.readFileSync(path.join(REPO_SKILLS, 'fluidcad', 'references', 'traps.md'), 'utf8');
    expect(result.data.body).toBe(onDisk);
    expect(result.data.file).toBe('references/traps.md');
    expect(result.data.uri).toBe('skill://fluidcad/references/traps.md');
    expect(result.data.description).toBeUndefined();
  });

  it('read_skill rejects an unknown skill and lists the known ones', () => {
    const result = readSkill(index, { name: 'nope' });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('invalid-input');
    expect(result.message).toMatch(/"fluidcad"/);
  });

  it('read_skill rejects an unknown file and lists the skill files', () => {
    const result = readSkill(index, { name: 'fluidcad', file: 'references/missing.md' });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('invalid-input');
    expect(result.message).toMatch(/references\/traps\.md/);
  });
});

describe('skill tools (MCP integration)', () => {
  it('registers list_skills and read_skill and serves a reference through the client', async () => {
    const { client, close } = await connect();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain('list_skills');
      expect(names).toContain('read_skill');

      const listed = await client.callTool({ name: 'list_skills', arguments: {} });
      const listText = (listed as any).content[0].text as string;
      expect(JSON.parse(listText).skills.map((s: any) => s.name)).toContain('fluidcad-from-drawing');

      const read = await client.callTool({
        name: 'read_skill',
        arguments: { name: 'fluidcad', file: 'references/repair-loop.md' },
      });
      const readText = (read as any).content[0].text as string;
      expect(JSON.parse(readText).body).toMatch(/compileError|objectErrors/);
    } finally {
      await close();
    }
  });

  it('the instructions point at the skill uri and the fallback tool', async () => {
    const { client, close } = await connect();
    try {
      const instructions = client.getInstructions() ?? '';
      expect(instructions).toMatch(/skill:\/\/fluidcad\/SKILL\.md/);
      expect(instructions).toMatch(/read_skill/);
    } finally {
      await close();
    }
  });
});

describe('MCP Skills Extension (SEP-2640)', () => {
  it('declares io.modelcontextprotocol/skills with directoryRead alongside resources', async () => {
    const { client, close } = await connect();
    try {
      const caps = client.getServerCapabilities()!;
      expect(caps.resources).toBeDefined();
      expect((caps as any).extensions[SKILLS_EXTENSION_ID]).toEqual({ directoryRead: true });
    } finally {
      await close();
    }
  });

  it('serves every skill file as a skill://<name>/<path> resource, SKILL.md verbatim', async () => {
    const { client, close } = await connect();
    try {
      const { resources } = await client.listResources();
      const byUri = new Map(resources.map((r) => [r.uri, r]));
      expect(byUri.has('skill://fluidcad/SKILL.md')).toBe(true);
      expect(byUri.has('skill://fluidcad/references/traps.md')).toBe(true);
      expect(byUri.has('skill://fluidcad-assembly/SKILL.md')).toBe(true);
      expect(byUri.has('skill://fluidcad-from-drawing/scripts/merge-drawing-reads.mjs')).toBe(true);

      const entry = byUri.get('skill://fluidcad/SKILL.md')!;
      expect(entry.name).toBe('fluidcad');
      expect(entry.mimeType).toBe('text/markdown');
      expect(entry.description).toMatch(/mcp__FluidCAD__\*/);

      const read = await client.readResource({ uri: 'skill://fluidcad/SKILL.md' });
      const text = (read.contents[0] as any).text as string;
      const onDisk = fs.readFileSync(path.join(REPO_SKILLS, 'fluidcad', 'SKILL.md'), 'utf8');
      expect(text).toBe(onDisk);
      expect(text.startsWith('---\nname: fluidcad\n')).toBe(true);

      const script = await client.readResource({
        uri: 'skill://fluidcad-from-drawing/scripts/merge-drawing-reads.mjs',
      });
      expect((script.contents[0] as any).mimeType).toBe('text/javascript');
    } finally {
      await close();
    }
  });

  it('skills/list returns an entry per skill with verbatim frontmatter and a complete manifest', async () => {
    const { client, close } = await connect();
    try {
      const result = (await client.request({ method: 'skills/list', params: {} }, AnyResult)) as any;
      expect(result.skills.map((s: any) => s.uri)).toEqual(
        SKILL_NAMES.map((n) => `skill://${n}/SKILL.md`),
      );
      for (const entry of result.skills) {
        const name = entry.frontmatter.name as string;
        expect(entry.uri).toBe(`skill://${name}/SKILL.md`);
        // Frontmatter is the SKILL.md YAML block, verbatim, as JSON.
        const onDisk = fs.readFileSync(path.join(REPO_SKILLS, name, 'SKILL.md'), 'utf8');
        const block = onDisk.match(/^---\n([\s\S]*?)\n---/)![1];
        expect(entry.frontmatter).toEqual(yaml.load(block));
        // The manifest lists every file exactly once, SKILL.md included, under the skill path.
        const uris = entry.resources.map((r: any) => r.uri);
        expect(new Set(uris).size).toBe(uris.length);
        expect(uris).toContain(entry.uri);
        for (const r of entry.resources) {
          expect(r.uri.startsWith(`skill://${name}/`)).toBe(true);
          expect(r.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
          expect(typeof r.size).toBe('number');
        }
        const listed = (await client.listResources()).resources
          .map((r) => r.uri)
          .filter((u) => u.startsWith(`skill://${name}/`));
        expect(uris.sort()).toEqual(listed.sort());
      }
    } finally {
      await close();
    }
  });

  it('resources/read bytes match the manifest digest and size', async () => {
    const { client, close } = await connect();
    try {
      const result = (await client.request({ method: 'skills/list', params: {} }, AnyResult)) as any;
      for (const entry of result.skills) {
        for (const r of entry.resources) {
          const read = await client.readResource({ uri: r.uri });
          const bytes = Buffer.from((read.contents[0] as any).text as string, 'utf8');
          expect(bytes.length).toBe(r.size);
          expect(`sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`).toBe(r.digest);
        }
      }
    } finally {
      await close();
    }
  });

  it('skills/get returns the same entry as the listing and -32602 for a non-skill uri', async () => {
    const { client, close } = await connect();
    try {
      const listed = (await client.request({ method: 'skills/list', params: {} }, AnyResult)) as any;
      const got = (await client.request(
        { method: 'skills/get', params: { uri: 'skill://fluidcad-assembly/SKILL.md' } },
        AnyResult,
      )) as any;
      expect(got.skill).toEqual(listed.skills.find((s: any) => s.uri === 'skill://fluidcad-assembly/SKILL.md'));

      for (const uri of [
        'skill://nope/SKILL.md',
        'skill://fluidcad/references/traps.md',
        'skill://fluidcad',
        'fluidcad-docs://overview',
      ]) {
        const error = await client
          .request({ method: 'skills/get', params: { uri } }, AnyResult)
          .then(() => undefined, (e: unknown) => e);
        expect(error).toBeInstanceOf(McpError);
        expect((error as McpError).code).toBe(-32602);
      }
    } finally {
      await close();
    }
  });

  it('resources/directory/read lists direct children with inode/directory subdirectories', async () => {
    const { client, close } = await connect();
    try {
      const root = (await client.request(
        { method: 'resources/directory/read', params: { uri: 'skill://fluidcad' } },
        AnyResult,
      )) as any;
      const byName = (a: any, b: any) => a.name.localeCompare(b.name);
      expect([...root.resources].sort(byName)).toEqual(
        [
          { uri: 'skill://fluidcad/SKILL.md', name: 'SKILL.md', mimeType: 'text/markdown' },
          { uri: 'skill://fluidcad/references', name: 'references', mimeType: 'inode/directory' },
        ].sort(byName),
      );

      const refs = (await client.request(
        { method: 'resources/directory/read', params: { uri: 'skill://fluidcad/references' } },
        AnyResult,
      )) as any;
      const names = refs.resources.map((r: any) => r.name);
      expect(names).toContain('traps.md');
      expect(names).toContain('verification.md');
      expect(refs.resources.every((r: any) => r.mimeType === 'text/markdown')).toBe(true);
      expect(refs.resources.every((r: any) => r.uri.startsWith('skill://fluidcad/references/'))).toBe(true);

      for (const uri of ['skill://fluidcad/SKILL.md', 'skill://fluidcad/nope', 'skill://nope']) {
        const error = await client
          .request({ method: 'resources/directory/read', params: { uri } }, AnyResult)
          .then(() => undefined, (e: unknown) => e);
        expect(error).toBeInstanceOf(McpError);
        expect((error as McpError).code).toBe(-32602);
      }
    } finally {
      await close();
    }
  });
});

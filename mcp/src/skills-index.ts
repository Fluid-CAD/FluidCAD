// In-memory index over `mcp/skills/`.
//
// The skills are the agent workflow (fluidcad, fluidcad-from-drawing,
// fluidcad-assembly). `npx skills add Fluid-CAD/FluidCAD` installs a copy of
// them into the client's skill directory, but that copy is frozen at install
// time and drifts from the server the agent actually runs. Serving them from
// the package makes the shipped server and the shipped workflow one artifact:
// an agent whose client has no skill loaded reads them through `read_skill`
// or the `skill://` resources, and always gets the version that matches the
// tools it is calling.
//
// The served shape follows MCP SEP-2640 (Skills Extension): every skill file
// is a resource at `skill://<name>/<path>`, the SKILL.md is served verbatim,
// and `skills/list` / `skills/get` publish each skill's frontmatter and a
// per-file sha256 manifest. The skill format itself is the Agent Skills
// specification (agentskills.io), which fixes the `name` rules enforced here.
//
// Loaded once at server start: every skill directory under the root, its
// SKILL.md frontmatter, and the digest and size of every file. File bodies
// are read on demand.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import yaml from 'js-yaml';

export const SKILL_ENTRY = 'SKILL.md';
export const SKILL_URI_SCHEME = 'skill://';

/** Agent Skills `name`: 1-64 chars, lowercase alphanumerics and single hyphens, matching the directory. */
const SKILL_NAME = /^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/;

export type SkillFile = {
  /** `/`-separated path relative to the skill directory. */
  path: string;
  /** `sha256:` + 64 lowercase hex chars over the raw bytes. */
  digest: string;
  /** Byte length of the raw content. */
  size: number;
  mimeType: string;
};

export type SkillRecord = {
  /** Skill name: the frontmatter `name`, which equals the directory name. */
  name: string;
  /** One-paragraph trigger description from the frontmatter. */
  description: string;
  /** The SKILL.md YAML frontmatter, verbatim, as JSON. */
  frontmatter: Record<string, unknown>;
  /** Directory name under the skills root (equals `name`). */
  dir: string;
  /** Every regular file in the skill. `SKILL.md` is always first. */
  files: SkillFile[];
};

export class SkillsIndex {
  readonly root: string;
  readonly skills: SkillRecord[];

  constructor(root: string, skills: SkillRecord[]) {
    this.root = root;
    this.skills = skills;
  }

  /** Lookup by name. Case-insensitive so `FluidCAD` still finds `fluidcad`. */
  get(name: string): SkillRecord | undefined {
    const wanted = name.trim().toLowerCase();
    return this.skills.find((s) => s.name === wanted);
  }

  /** The file record for a relative path inside a skill (case-insensitive on the whole path). */
  fileRecord(skill: SkillRecord, file: string): SkillFile | undefined {
    const wanted = normalizeRel(file).toLowerCase();
    return skill.files.find((f) => f.path.toLowerCase() === wanted);
  }

  /**
   * Read a file inside a skill. `file` is the relative path as listed under
   * `files`. Returns undefined when the skill or the file does not exist;
   * only listed files are ever read, so a path can never escape the skill.
   */
  file(skill: SkillRecord, file: string): string | undefined {
    const record = this.fileRecord(skill, file);
    if (!record) {
      return undefined;
    }
    try {
      return fs.readFileSync(path.join(this.root, skill.dir, ...record.path.split('/')), 'utf8');
    } catch {
      return undefined;
    }
  }

  /** `skill://<name>/SKILL.md`, the skill's identity under SEP-2640. */
  skillUri(skill: SkillRecord): string {
    return fileUri(skill, SKILL_ENTRY);
  }

  /**
   * Resolve a `skill://` URI to the skill and the file it names. The file is
   * undefined for a directory URI (`skill://<name>` or `skill://<name>/<dir>`)
   * — `directory` then carries that relative path (`''` for the root).
   * Returns undefined for a URI outside the served namespace.
   */
  resolve(
    uri: string,
  ): { skill: SkillRecord; file?: SkillFile; directory?: string } | undefined {
    if (!uri.startsWith(SKILL_URI_SCHEME)) {
      return undefined;
    }
    const rest = uri.slice(SKILL_URI_SCHEME.length).replace(/\/+$/, '');
    const slash = rest.indexOf('/');
    const name = slash === -1 ? rest : rest.slice(0, slash);
    const rel = slash === -1 ? '' : rest.slice(slash + 1);
    const skill = this.skills.find((s) => s.dir === name);
    if (!skill) {
      return undefined;
    }
    if (rel === '') {
      return { skill, directory: '' };
    }
    const file = skill.files.find((f) => f.path === rel);
    if (file) {
      return { skill, file };
    }
    const prefix = `${rel}/`;
    if (skill.files.some((f) => f.path.startsWith(prefix))) {
      return { skill, directory: rel };
    }
    return undefined;
  }

  /** Direct children of a directory inside a skill: files and subdirectories, sorted by name. */
  children(
    skill: SkillRecord,
    directory: string,
  ): Array<{ name: string; uri: string; mimeType: string; file?: SkillFile }> {
    const prefix = directory === '' ? '' : `${directory}/`;
    const seen = new Set<string>();
    const out: Array<{ name: string; uri: string; mimeType: string; file?: SkillFile }> = [];
    for (const file of skill.files) {
      if (!file.path.startsWith(prefix)) {
        continue;
      }
      const rest = file.path.slice(prefix.length);
      const slash = rest.indexOf('/');
      const name = slash === -1 ? rest : rest.slice(0, slash);
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      const rel = `${prefix}${name}`;
      if (slash === -1) {
        out.push({ name, uri: fileUri(skill, rel), mimeType: file.mimeType, file });
      } else {
        out.push({ name, uri: fileUri(skill, rel), mimeType: DIRECTORY_MIME });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}

export const DIRECTORY_MIME = 'inode/directory';

export function fileUri(skill: SkillRecord, rel: string): string {
  return `${SKILL_URI_SCHEME}${skill.dir}/${rel}`;
}

/** Markdown with the leading YAML frontmatter block removed. */
export function stripFrontmatter(markdown: string): string {
  const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? markdown.slice(match[0].length).replace(/^\r?\n/, '') : markdown;
}

/** The YAML frontmatter block, parsed verbatim into a JSON object. */
export function parseFrontmatter(markdown: string): Record<string, unknown> {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return {};
  }
  const parsed = yaml.load(match[1]);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

export function mimeTypeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case '.md':
      return 'text/markdown';
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'text/javascript';
    case '.json':
      return 'application/json';
    case '.ts':
      return 'text/typescript';
    case '.py':
      return 'text/x-python';
    case '.sh':
      return 'text/x-shellscript';
    default:
      return 'text/plain';
  }
}

/**
 * Locate the on-disk `mcp/skills/` directory. Same resolution order as the
 * docs root: the installed `fluidcad` package first, then a walk up from this
 * file (`mcp/src/` or `mcp/dist/`) to a sibling `skills/` directory that
 * holds at least one `SKILL.md`. `process.cwd()` is never consulted — the MCP
 * process is launched by an external client from an arbitrary directory.
 */
export function resolveSkillsRoot(): string {
  const here = fileURLToPath(import.meta.url);
  const require_ = createRequire(here);
  try {
    const pkg = require_.resolve('fluidcad/package.json');
    const candidate = path.join(path.dirname(pkg), 'mcp', 'skills');
    if (hasSkills(candidate)) {
      return candidate;
    }
  } catch {
    // Falls through to the dev walk-up below.
  }
  let dir = path.dirname(here);
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'skills');
    if (hasSkills(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error(
    `Could not locate mcp/skills/ from ${here}. ` +
      `The skills ship with the fluidcad package; ensure it is installed intact.`,
  );
}

function hasSkills(dir: string): boolean {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .some((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, SKILL_ENTRY)));
  } catch {
    return false;
  }
}

/**
 * Load every skill under `root`. Throws on a skill whose frontmatter `name`
 * breaks the Agent Skills rules or differs from its directory: the skills
 * ship with the package, so that is a packaging bug, not a runtime condition.
 */
export function loadSkillsIndex(root?: string): SkillsIndex {
  const resolved = root ?? resolveSkillsRoot();
  const skills: SkillRecord[] = [];
  for (const entry of fs.readdirSync(resolved, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = path.join(resolved, entry.name);
    const entryPath = path.join(dir, SKILL_ENTRY);
    if (!fs.existsSync(entryPath)) {
      continue;
    }
    const frontmatter = parseFrontmatter(fs.readFileSync(entryPath, 'utf8'));
    const name = frontmatter.name;
    const description = frontmatter.description;
    if (typeof name !== 'string' || !SKILL_NAME.test(name)) {
      throw new Error(
        `Skill ${entryPath}: frontmatter name ${JSON.stringify(name)} must be 1-64 lowercase alphanumerics and single hyphens.`,
      );
    }
    if (name !== entry.name) {
      throw new Error(
        `Skill ${entryPath}: frontmatter name "${name}" must equal its directory name "${entry.name}".`,
      );
    }
    if (typeof description !== 'string' || description.length === 0 || description.length > 1024) {
      throw new Error(`Skill ${entryPath}: frontmatter description must be 1-1024 characters.`);
    }
    const files = listFiles(dir)
      .filter((f) => f !== SKILL_ENTRY)
      .map((f) => fileRecord(dir, f));
    skills.push({
      name,
      description,
      frontmatter,
      dir: entry.name,
      files: [fileRecord(dir, SKILL_ENTRY), ...files],
    });
  }
  return new SkillsIndex(resolved, skills);
}

function fileRecord(dir: string, rel: string): SkillFile {
  const bytes = fs.readFileSync(path.join(dir, ...rel.split('/')));
  return {
    path: rel,
    digest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    size: bytes.length,
    mimeType: mimeTypeFor(rel),
  };
}

function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...listFiles(path.join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

function normalizeRel(file: string): string {
  return file
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

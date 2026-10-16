// Skill tools — the agent-facing surface over `mcp/skills/`.
//
// Pure functions over an injected `SkillsIndex`, like the doc tools. The
// skills teach workflow (the doc tools teach the API), so an agent whose
// client has no FluidCAD skill installed reads them from here instead and
// always gets the copy that matches this server.
//
// Hosts that implement the MCP Skills Extension (SEP-2640) load the same
// skills through `skills/list` and the `skill://` resources; these tools are
// the fallback for every other client, and each result carries the `skill://`
// uri so the two paths name the same thing.

import {
  SKILL_ENTRY,
  fileUri,
  stripFrontmatter,
  type SkillsIndex,
} from '../skills-index.ts';
import { err, ok, type ToolResult } from '../types.ts';

export type SkillListEntry = {
  name: string;
  description: string;
  /** `skill://<name>/SKILL.md` — the skill's resource uri. */
  uri: string;
  /** Relative paths of every file in the skill; pass one to read_skill as `file`. */
  files: string[];
};

export type ListSkillsOutput = { skills: SkillListEntry[] };

export function listSkills(index: SkillsIndex): ToolResult<ListSkillsOutput> {
  try {
    return ok({
      skills: index.skills.map((s) => ({
        name: s.name,
        description: s.description,
        uri: index.skillUri(s),
        files: s.files.map((f) => f.path),
      })),
    });
  } catch (error) {
    return err('internal', toMessage(error));
  }
}

export type ReadSkillInput = { name: string; file?: string };
export type ReadSkillOutput = {
  name: string;
  /** The file that was read, relative to the skill directory. */
  file: string;
  /** Resource uri of that file (`skill://<name>/<file>`). */
  uri: string;
  /** Trigger description from the frontmatter (SKILL.md reads only). */
  description?: string;
  /** File contents. For SKILL.md the frontmatter block is stripped. */
  body: string;
  /** Every file in the skill; pass one as `file` to read it. */
  files: string[];
};

export function readSkill(
  index: SkillsIndex,
  input: ReadSkillInput,
): ToolResult<ReadSkillOutput> {
  if (!input || typeof input.name !== 'string' || input.name.trim().length === 0) {
    return err('invalid-input', '`name` is required and must be a non-empty string.');
  }
  const skill = index.get(input.name);
  if (!skill) {
    const known = index.skills.map((s) => `"${s.name}"`).join(', ');
    return err('invalid-input', `No skill named "${input.name}". Known skills: ${known}.`);
  }
  const wanted =
    typeof input.file === 'string' && input.file.trim().length > 0 ? input.file : SKILL_ENTRY;
  const files = skill.files.map((f) => f.path);
  try {
    const record = index.fileRecord(skill, wanted);
    const raw = record ? index.file(skill, record.path) : undefined;
    if (!record || raw === undefined) {
      return err(
        'invalid-input',
        `Skill "${skill.name}" has no file "${wanted}". Files: ${files.join(', ')}.`,
      );
    }
    const isEntry = record.path === SKILL_ENTRY;
    return ok({
      name: skill.name,
      file: record.path,
      uri: fileUri(skill, record.path),
      description: isEntry ? skill.description : undefined,
      body: isEntry ? stripFrontmatter(raw) : raw,
      files,
    });
  } catch (error) {
    return err('internal', toMessage(error));
  }
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

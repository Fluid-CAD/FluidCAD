// MCP SEP-2640 "Skills Extension" (`io.modelcontextprotocol/skills`).
//
// Three protocol methods over the skills index:
//   skills/list              every skill: SKILL.md uri, verbatim frontmatter,
//                            and the complete {uri, digest, size} manifest.
//   skills/get               one skill entry by its SKILL.md uri.
//   resources/directory/read direct children of a directory uri such as
//                            `skill://fluidcad` or `skill://fluidcad/references`
//                            (gated by the `directoryRead` capability flag).
//
// The skill files themselves are ordinary resources (see resources.ts);
// reading them is plain `resources/read`. Hosts that implement the extension
// verify what they read against the digests published here, so the manifest
// is computed from the same bytes the resources serve.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ErrorCode,
  McpError,
  PaginatedRequestSchema,
  RequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { SkillRecord, SkillsIndex } from './skills-index.ts';
import { fileUri } from './skills-index.ts';

export const SKILLS_EXTENSION_ID = 'io.modelcontextprotocol/skills';

/** The capability declaration to merge into `capabilities.extensions`. */
export function skillsExtensionCapability(): Record<string, { directoryRead: boolean }> {
  return { [SKILLS_EXTENSION_ID]: { directoryRead: true } };
}

export type SkillEntry = {
  uri: string;
  frontmatter: Record<string, unknown>;
  resources: Array<{ uri: string; digest: string; size: number }>;
};

export function skillEntry(index: SkillsIndex, skill: SkillRecord): SkillEntry {
  return {
    uri: index.skillUri(skill),
    frontmatter: skill.frontmatter,
    resources: skill.files.map((f) => ({
      uri: fileUri(skill, f.path),
      digest: f.digest,
      size: f.size,
    })),
  };
}

const SkillsListRequestSchema = PaginatedRequestSchema.extend({
  method: z.literal('skills/list'),
});

const SkillsGetRequestSchema = RequestSchema.extend({
  method: z.literal('skills/get'),
  params: z.object({ uri: z.string() }).loose(),
});

const DirectoryReadRequestSchema = RequestSchema.extend({
  method: z.literal('resources/directory/read'),
  params: z.object({ uri: z.string(), cursor: z.string().optional() }).loose(),
});

export function registerSkillsExtension(server: McpServer, index: SkillsIndex): void {
  const raw = server.server;

  // The catalog is three skills; one page, no cursor.
  raw.setRequestHandler(SkillsListRequestSchema, async () => ({
    resultType: 'complete',
    skills: index.skills.map((s) => skillEntry(index, s)),
  }));

  raw.setRequestHandler(SkillsGetRequestSchema, async ({ params }) => {
    const hit = index.resolve(params.uri);
    if (!hit || !hit.file || hit.file.path !== 'SKILL.md') {
      throw new McpError(ErrorCode.InvalidParams, `Not a skill served here: ${params.uri}`);
    }
    return { resultType: 'complete', skill: skillEntry(index, hit.skill) };
  });

  raw.setRequestHandler(DirectoryReadRequestSchema, async ({ params }) => {
    const hit = index.resolve(params.uri);
    if (!hit || hit.directory === undefined) {
      throw new McpError(ErrorCode.InvalidParams, `Not a directory resource: ${params.uri}`);
    }
    return {
      resultType: 'complete',
      resources: index.children(hit.skill, hit.directory).map((c) => ({
        uri: c.uri,
        name: c.name,
        mimeType: c.mimeType,
      })),
    };
  });
}

// MCP resource registrations for `fluidcad-docs://*` and `skill://*`.
//
// Resources are a bonus surface — clients that auto-attach them (e.g. Claude
// Desktop) get the docs for free without burning tool calls. Clients that
// ignore resources fall back to the `list_docs` / `read_doc` tools, so the
// two surfaces are designed to be self-sufficient.
//
// Every resource is registered statically. The seed set is small (under a
// dozen entries) so we trade the template machinery for a simple per-doc
// `registerResource` call — the resulting list shows up explicitly in the
// MCP client's resource picker.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DocsIndex, DocRecord } from './docs-index.ts';
import { SKILL_ENTRY, fileUri, type SkillsIndex } from './skills-index.ts';

export const URI_OVERVIEW = 'fluidcad-docs://overview';

export function registerDocResources(server: McpServer, index: DocsIndex): void {
  server.registerResource(
    'fluidcad-docs-overview',
    URI_OVERVIEW,
    {
      title: 'FluidCAD docs — overview',
      description:
        'Single-document aggregate of the FluidCAD doc set: titles, summaries, and tags for every API symbol and concept.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/markdown',
          text: renderOverview(index),
        },
      ],
    }),
  );

  // One static resource per API symbol. We use the symbol map (not the doc
  // list) so a single doc that documents multiple symbols still appears under
  // each. The doc body is identical across symbol resources — that's fine,
  // clients dedupe by content.
  for (const [symbol, docId] of Object.entries(index.symbols)) {
    const doc = index.get(docId);
    if (!doc) {
      continue;
    }
    server.registerResource(
      `fluidcad-docs-api-${symbol}`,
      `fluidcad-docs://api/${symbol}`,
      {
        title: doc.title,
        description: doc.summary,
        mimeType: 'text/markdown',
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: index.body(doc.id) ?? '',
          },
        ],
      }),
    );
  }

  // One static resource per non-API doc, exposed as `guide/<slug>`. Slug is
  // the doc id stripped of any leading category prefix (e.g.
  // `concepts/scene-graph` → `scene-graph`). If two ids collide on slug, we
  // keep the first and skip the rest — collisions are flagged here rather
  // than during manifest validation since slug uniqueness is a resource-layer
  // concern, not a doc-content concern.
  const seenSlugs = new Set<string>();
  for (const doc of index.docs) {
    if (isApiDoc(doc)) {
      continue;
    }
    const slug = guideSlug(doc.id);
    if (seenSlugs.has(slug)) {
      continue;
    }
    seenSlugs.add(slug);
    server.registerResource(
      `fluidcad-docs-guide-${slug}`,
      `fluidcad-docs://guide/${slug}`,
      {
        title: doc.title,
        description: doc.summary,
        mimeType: 'text/markdown',
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: index.body(doc.id) ?? '',
          },
        ],
      }),
    );
  }
}

function isApiDoc(doc: DocRecord): boolean {
  return doc.id.startsWith('api/');
}

function guideSlug(id: string): string {
  const slash = id.indexOf('/');
  return slash === -1 ? id : id.slice(slash + 1);
}

function renderOverview(index: DocsIndex): string {
  const lines: string[] = [];
  lines.push('# FluidCAD docs');
  lines.push('');
  lines.push(
    'Generated from `llm-docs/`. Each entry lists a doc id, its title, and a one-line summary.',
  );
  lines.push('');

  const apiDocs = index.docs.filter(isApiDoc);
  const otherDocs = index.docs.filter((d) => !isApiDoc(d));

  if (apiDocs.length > 0) {
    lines.push('## API');
    lines.push('');
    for (const doc of apiDocs) {
      lines.push(`- **${doc.id}** — ${doc.title}`);
      lines.push(`  ${doc.summary}`);
    }
    lines.push('');
  }

  if (otherDocs.length > 0) {
    lines.push('## Concepts and guides');
    lines.push('');
    for (const doc of otherDocs) {
      lines.push(`- **${doc.id}** — ${doc.title}`);
      lines.push(`  ${doc.summary}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// `skill://*` — the workflow skills under mcp/skills/, per MCP SEP-2640.
//
// Every file of a skill is a resource at `skill://<name>/<path>`; the
// SKILL.md is `skill://<name>/SKILL.md`, served verbatim (hosts parse its
// frontmatter and compare it with the skills/list entry). The SKILL.md
// resource carries the skill's name and description so a resource picker
// shows what each skill is for. Clients that ignore resources use
// list_skills/read_skill instead.

export function registerSkillResources(server: McpServer, index: SkillsIndex): void {
  for (const skill of index.skills) {
    for (const file of skill.files) {
      const isEntry = file.path === SKILL_ENTRY;
      server.registerResource(
        isEntry ? skill.name : `${skill.name}/${file.path}`,
        fileUri(skill, file.path),
        {
          title: isEntry ? `FluidCAD skill — ${skill.name}` : `${skill.name} — ${file.path}`,
          description: isEntry
            ? skill.description
            : `Supporting file of the ${skill.name} skill.`,
          mimeType: file.mimeType,
        },
        async (uri) => ({
          contents: [
            {
              uri: uri.href,
              mimeType: file.mimeType,
              text: index.file(skill, file.path) ?? '',
            },
          ],
        }),
      );
    }
  }
}

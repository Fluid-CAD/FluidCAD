// Documentation tools — the agent-facing surface over `llm-docs/`.
//
// Each tool is a pure function over an injected `DocsIndex` so the server
// wires it up via closure (no module-level singleton). Errors never throw
// across the MCP boundary; everything is funneled into `ToolResult<T>`.

import type { DocsIndex } from '../docs-index.ts';
import { err, ok, type ToolResult } from '../types.ts';

export type DocListEntry = {
  id: string;
  title: string;
  summary: string;
  tags?: string[];
};

export type ListDocsInput = { tag?: string };
export type ListDocsOutput = { docs: DocListEntry[] };

export function listDocs(
  index: DocsIndex,
  input: ListDocsInput = {},
): ToolResult<ListDocsOutput> {
  try {
    const docs = index.list(input.tag).map((d) => ({
      id: d.id,
      title: d.title,
      summary: d.summary,
      tags: d.tags,
    }));
    return ok({ docs });
  } catch (error) {
    return err('internal', toMessage(error));
  }
}

export type ReadDocInput = { id: string };
export type ReadDocOutput = {
  id: string;
  title: string;
  body: string;
  seeAlso?: string[];
};

export function readDoc(
  index: DocsIndex,
  input: ReadDocInput,
): ToolResult<ReadDocOutput> {
  if (!input || typeof input.id !== 'string' || input.id.length === 0) {
    return err('invalid-input', '`id` is required and must be a non-empty string.');
  }
  const doc = index.get(input.id);
  if (!doc) {
    return err('invalid-input', `No doc with id "${input.id}".`);
  }
  try {
    const body = index.body(doc.id) ?? '';
    return ok({
      id: doc.id,
      title: doc.title,
      body,
      seeAlso: doc.seeAlso,
    });
  } catch (error) {
    return err('internal', toMessage(error));
  }
}

export type SearchDocsInput = { query: string; limit?: number };
export type SearchDocsOutput = {
  results: Array<{ id: string; title: string; snippet: string; score: number }>;
};

export function searchDocs(
  index: DocsIndex,
  input: SearchDocsInput,
): ToolResult<SearchDocsOutput> {
  if (!input || typeof input.query !== 'string' || input.query.length === 0) {
    return err('invalid-input', '`query` is required and must be a non-empty string.');
  }
  if (
    input.limit !== undefined &&
    (typeof input.limit !== 'number' || input.limit <= 0 || !Number.isFinite(input.limit))
  ) {
    return err('invalid-input', '`limit` must be a positive number when provided.');
  }
  try {
    const limit = input.limit ?? 10;
    const results = index.search(input.query, limit);
    return ok({ results });
  } catch (error) {
    return err('internal', toMessage(error));
  }
}

export type GetApiSignatureInput = { name: string };
export type GetApiSignatureOutput = {
  symbol: string;
  docId: string;
  title: string;
  signature: string;
  summary: string;
};

export function getApiSignature(
  index: DocsIndex,
  input: GetApiSignatureInput,
): ToolResult<GetApiSignatureOutput> {
  if (!input || typeof input.name !== 'string' || input.name.length === 0) {
    return err('invalid-input', '`name` is required and must be a non-empty string.');
  }
  const docId = index.symbols[input.name];
  if (!docId) {
    return err('invalid-input', `No API symbol "${input.name}".`);
  }
  const doc = index.get(docId);
  if (!doc) {
    // The api index points at a docId that the main index does not know about
    // — only possible if the manifests were generated separately, which should
    // never happen because `build-llm-docs.ts` writes both atomically.
    return err('internal', `API symbol "${input.name}" maps to missing doc "${docId}".`);
  }
  try {
    const signature = index.firstCodeBlock(docId) ?? '';
    return ok({
      symbol: input.name,
      docId: doc.id,
      title: doc.title,
      signature,
      summary: doc.summary,
    });
  } catch (error) {
    return err('internal', toMessage(error));
  }
}

export type GetTypeDefinitionInput = { name: string };
export type GetTypeDefinitionOutput = {
  /** The display name as documented (e.g. "PlaneLike"). */
  name: string;
  /** Doc id, e.g. "api/types/plane-like". */
  docId: string;
  title: string;
  /** First code block — the type signature (`type X = ...` or `interface X { ... }`). */
  definition: string;
  /** Full markdown body, frontmatter already stripped. */
  body: string;
  summary: string;
  seeAlso?: string[];
};

export function getTypeDefinition(
  index: DocsIndex,
  input: GetTypeDefinitionInput,
): ToolResult<GetTypeDefinitionOutput> {
  if (!input || typeof input.name !== 'string' || input.name.length === 0) {
    return err('invalid-input', '`name` is required and must be a non-empty string.');
  }
  const docId = index.types[input.name];
  if (!docId) {
    return err(
      'invalid-input',
      `No type "${input.name}". Call list_docs({tag:"type"}) to see every documented type.`,
    );
  }
  const doc = index.get(docId);
  if (!doc) {
    return err('internal', `Type "${input.name}" maps to missing doc "${docId}".`);
  }
  try {
    const definition = index.firstCodeBlock(docId) ?? '';
    const body = index.body(docId) ?? '';
    return ok({
      name: doc.title,
      docId: doc.id,
      title: doc.title,
      definition,
      body,
      summary: doc.summary,
      seeAlso: doc.seeAlso,
    });
  } catch (error) {
    return err('internal', toMessage(error));
  }
}

function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

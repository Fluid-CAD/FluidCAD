// FluidCAD's MCP server for one chat session (docs/agent-chat-plan.md §8.2).
//
// The CLI reaches it at `http://127.0.0.1:<engine port>/api/agent/mcp/<secret>`.
// The secret is 32 random bytes, made per session and handed to the child
// alone; a request with any other path segment gets 404. The server is
// pinned to this engine's workspace and gated by the session's ToolGate.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import {
  buildServer,
  createMcpHttpHandler,
  loadDocsIndex,
  loadSkillsIndex,
  type DocsIndex,
  type McpAskUser,
  type McpHttpHandler,
  type McpHttpRequest,
  type McpProposeVariants,
  type McpToolGate,
  type RegistryEntry,
  type SkillsIndex,
} from '../../mcp/dist/server.js';

/** The docs and skills indexes, loaded once per engine and shared by every session's server. */
export class SharedMcpIndexes {
  private docs: DocsIndex | null = null;
  private skills: SkillsIndex | null = null;

  get docsIndex(): DocsIndex {
    this.docs ??= loadDocsIndex();
    return this.docs;
  }

  get skillsIndex(): SkillsIndex {
    this.skills ??= loadSkillsIndex();
    return this.skills;
  }
}

export type McpEndpointOptions = {
  pinnedWorkspace: RegistryEntry;
  toolGate: McpToolGate;
  /** Answers `ask_user` (§22): the session's gate shows the question and waits. */
  askUser: McpAskUser;
  /** Answers `propose_variants` (§24): the session's gate builds the variants, shows them and writes the pick. */
  proposeVariants: McpProposeVariants;
  indexes: SharedMcpIndexes;
  /** The engine's port, for the URL the CLI is given. */
  port: number;
};

export class McpEndpoint {
  readonly secret: string;
  /** sha256 of the secret: what a lookup compares, in constant time. */
  readonly digest: Buffer;
  readonly url: string;
  private readonly handler: McpHttpHandler;

  constructor(options: McpEndpointOptions) {
    this.secret = randomBytes(32).toString('base64url');
    this.digest = sha256(this.secret);
    this.url = `http://127.0.0.1:${options.port}/api/agent/mcp/${this.secret}`;
    this.handler = createMcpHttpHandler({
      buildServer: () =>
        buildServer({
          pinnedWorkspace: options.pinnedWorkspace,
          toolGate: options.toolGate,
          askUser: options.askUser,
          proposeVariants: options.proposeVariants,
          docsIndex: options.indexes.docsIndex,
          skillsIndex: options.indexes.skillsIndex,
        }),
    });
  }

  handle(req: McpHttpRequest, res: ServerResponse): Promise<void> {
    return this.handler.handle(req, res);
  }

  /**
   * Closes the CLI's MCP session (Claude Code sends no DELETE on exit) and
   * aborts calls still running. The endpoint stays: a respawned CLI opens a
   * new session on the same URL.
   */
  closeSessions(): Promise<void> {
    return this.handler.close();
  }

  get sessionCount(): number {
    return this.handler.sessionCount;
  }
}

/** The endpoints of every live chat session, looked up by the secret in the URL. */
export class McpEndpoints {
  private readonly endpoints = new Set<McpEndpoint>();

  add(endpoint: McpEndpoint): void {
    this.endpoints.add(endpoint);
  }

  remove(endpoint: McpEndpoint): void {
    this.endpoints.delete(endpoint);
  }

  /**
   * The endpoint whose secret is `candidate`, or null. Every endpoint is
   * compared, with `timingSafeEqual` on digests of equal length, so the time
   * taken says nothing about how much of a guess was right.
   */
  find(candidate: string): McpEndpoint | null {
    if (typeof candidate !== 'string' || candidate === '' || candidate.length > 256) {
      return null;
    }
    const digest = sha256(candidate);
    let found: McpEndpoint | null = null;
    for (const endpoint of this.endpoints) {
      if (timingSafeEqual(digest, endpoint.digest) && found === null) {
        found = endpoint;
      }
    }
    return found;
  }

  get size(): number {
    return this.endpoints.size;
  }
}

function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

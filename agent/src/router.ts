// The agent API (docs/agent-chat-plan.md §7.1), mounted by the engine under
// `api/agent` (`server/src/routes/agent.ts`, which also applies the
// fetch-metadata check to every route here).

import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import type { AgentRuntime } from './runtime.ts';
import { UnsupportedAgentError } from './runtime.ts';
import { SessionBusyError, type AgentSession } from './session.ts';
import { SessionStore } from './session-store.ts';
import type { AgentKind, ChatEventEnvelope, SceneReference, SendMessage } from './types.ts';

/** A comment line this often keeps proxies and the browser from timing the stream out. */
export const HEARTBEAT_MS = 15_000;
const MAX_TEXT_CHARS = 100_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_REFERENCES = 8;
const MAX_MODEL_CHARS = 200;
/** A model alias or full name; the same rule as the `agent.claudeModel` preference. */
const MODEL_PATTERN = /^[A-Za-z0-9][\w.:@\/\[\]-]*$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FILE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export type AgentRouterOptions = { heartbeatMs?: number };

export function createRuntimeRouter(runtime: AgentRuntime, options: AgentRouterOptions = {}): Router {
  const router = Router();
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;

  // --- Agents ---------------------------------------------------------------

  router.get('/agents', async (_req, res) => {
    res.json({ agents: await runtime.agents(false) });
  });

  router.post('/agents/recheck', async (_req, res) => {
    res.json({ agents: await runtime.agents(true) });
  });

  router.get('/agents/:kind/models', async (req, res) => {
    const kind = req.params.kind;
    if (kind !== 'claude' && kind !== 'codex') {
      res.status(404).json({ error: `Unknown agent: ${kind}` });
      return;
    }
    res.json({ models: await runtime.models(kind) });
  });

  // --- Sessions -------------------------------------------------------------

  router.get('/sessions', (_req, res) => {
    res.json({ sessions: runtime.list() });
  });

  router.post('/sessions', (req, res) => {
    const kind = req.body?.agent;
    if (kind !== 'claude' && kind !== 'codex') {
      res.status(400).json({ error: '`agent` must be "claude" or "codex".' });
      return;
    }
    try {
      const session = runtime.create(kind as AgentKind);
      res.status(201).json({ id: session.id });
    } catch (e) {
      if (e instanceof UnsupportedAgentError) {
        res.status(400).json({ error: e.message });
        return;
      }
      throw e;
    }
  });

  router.get('/sessions/:id', (req, res) => {
    const session = findSession(runtime, req, res);
    if (session) {
      res.json(session.snapshot());
    }
  });

  router.patch('/sessions/:id', (req, res) => {
    const session = findSession(runtime, req, res);
    if (!session) {
      return;
    }
    const title = req.body?.title;
    if (typeof title !== 'string' || title.trim() === '' || title.length > 500) {
      res.status(400).json({ error: '`title` must be a non-empty string.' });
      return;
    }
    session.rename(title);
    res.status(204).end();
  });

  router.delete('/sessions/:id', async (req, res) => {
    const session = findSession(runtime, req, res);
    if (!session) {
      return;
    }
    await runtime.delete(session.id);
    res.status(204).end();
  });

  router.post('/sessions/:id/messages', (req, res) => {
    const session = findSession(runtime, req, res);
    if (!session) {
      return;
    }
    const parsed = parseSendMessage(req.body);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    try {
      res.status(202).json(session.send(parsed.message));
    } catch (e) {
      if (e instanceof SessionBusyError) {
        res.status(409).json({ error: e.message });
        return;
      }
      throw e;
    }
  });

  router.post('/sessions/:id/cancel', async (req, res) => {
    const session = findSession(runtime, req, res);
    if (!session) {
      return;
    }
    await session.cancel();
    res.status(204).end();
  });

  router.post('/sessions/:id/continue', (req, res) => {
    const session = findSession(runtime, req, res);
    if (!session) {
      return;
    }
    if (session.status.state !== 'interrupted') {
      res.status(409).json({ error: 'The session was not interrupted.' });
      return;
    }
    try {
      res.status(202).json(session.continueAfterRestart());
    } catch (e) {
      if (e instanceof SessionBusyError) {
        res.status(409).json({ error: e.message });
        return;
      }
      throw e;
    }
  });

  router.get('/sessions/:id/files/:name', (req, res) => {
    const session = findSession(runtime, req, res);
    if (!session) {
      return;
    }
    const name = String(req.params.name);
    const file = runtime.store.filePath(session.id, name);
    const type = FILE_TYPES[path.extname(name).toLowerCase()];
    if (!file || !type || !fs.existsSync(file)) {
      res.status(404).json({ error: 'No such file.' });
      return;
    }
    res.setHeader('Content-Type', type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Names are random and never reused.
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    fs.createReadStream(file).pipe(res);
  });

  // --- The event stream (§7.3) ----------------------------------------------

  router.get('/sessions/:id/events', (req, res) => {
    const session = findSession(runtime, req, res);
    if (!session) {
      return;
    }
    streamEvents(session, req, res, heartbeatMs);
  });

  // --- The MCP endpoint the CLI connects to (§8.2) --------------------------

  router.all('/mcp/:secret', async (req, res) => {
    const endpoint = runtime.endpoints.find(String(req.params.secret));
    if (!endpoint) {
      res.status(404).json({ error: 'Not found.' });
      return;
    }
    await endpoint.handle(req, res);
  });

  return router;
}

function findSession(runtime: AgentRuntime, req: Request, res: Response): AgentSession | null {
  const id = String(req.params.id ?? '');
  const session = SessionStore.isSessionId(id) ? runtime.get(id) : null;
  if (!session) {
    res.status(404).json({ error: 'No such session.' });
    return null;
  }
  return session;
}

/**
 * Server-sent events for one session. The client sends `after` (the
 * snapshot's `seq`), or the browser sends `Last-Event-ID` on a reconnect,
 * which wins; `epoch` (optional) is the snapshot's. Events the log cannot
 * continue from produce a `resync`, and the client refetches the snapshot.
 */
export function streamEvents(session: AgentSession, req: Request, res: Response, heartbeatMs: number): void {
  const lastEventId = req.get('Last-Event-ID');
  const afterRaw = lastEventId !== undefined && lastEventId !== '' ? lastEventId : req.query.after;
  const after = typeof afterRaw === 'string' && /^\d+$/.test(afterRaw) ? Number(afterRaw) : session.log.lastSeq;
  const epoch = typeof req.query.epoch === 'string' && req.query.epoch !== '' ? req.query.epoch : undefined;

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write('retry: 1000\n\n');

  const send = (envelope: ChatEventEnvelope) => {
    res.write(`id: ${envelope.seq}\ndata: ${JSON.stringify(envelope)}\n\n`);
  };
  // Replay and subscribe in one synchronous step: no event falls between.
  const replay = session.log.replay(after, epoch);
  if (replay.kind === 'resync') {
    res.write(`data: ${JSON.stringify({ epoch: session.log.epoch, seq: session.log.lastSeq, event: { type: 'resync' } })}\n\n`);
  } else {
    for (const envelope of replay.events) {
      send(envelope);
    }
  }
  const unsubscribe = session.log.subscribe(send);
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, heartbeatMs);
  heartbeat.unref?.();
  res.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

/** Validates the body of `POST …/messages`. */
export function parseSendMessage(body: any): { message: SendMessage } | { error: string } {
  if (!body || typeof body !== 'object') {
    return { error: 'Expected a JSON body.' };
  }
  const text = body.text;
  if (typeof text !== 'string' || text.trim() === '') {
    return { error: '`text` must be a non-empty string.' };
  }
  if (text.length > MAX_TEXT_CHARS) {
    return { error: `\`text\` is longer than ${MAX_TEXT_CHARS} characters.` };
  }
  const message: SendMessage = { text };
  if (body.references !== undefined) {
    if (!Array.isArray(body.references) || body.references.length > MAX_REFERENCES || !body.references.every(isReference)) {
      return { error: `\`references\` must be at most ${MAX_REFERENCES} scene references.` };
    }
    message.references = body.references as SceneReference[];
  }
  if (body.image !== undefined) {
    const image = body.image;
    if (!image || image.mediaType !== 'image/png' || typeof image.base64 !== 'string') {
      return { error: '`image` must be { mediaType: "image/png", base64 }.' };
    }
    const bytes = Buffer.from(image.base64, 'base64');
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
      return { error: '`image` is not a PNG, or is too large.' };
    }
    message.image = { mediaType: 'image/png', base64: image.base64 };
  }
  if (body.model !== undefined && body.model !== null && body.model !== '') {
    if (typeof body.model !== 'string' || body.model.length > MAX_MODEL_CHARS || !MODEL_PATTERN.test(body.model)) {
      return { error: '`model` must be a model alias or name.' };
    }
    message.model = body.model;
  }
  if (body.effort !== undefined && body.effort !== null) {
    if (!['low', 'medium', 'high'].includes(body.effort)) {
      return { error: '`effort` must be low, medium or high.' };
    }
    message.effort = body.effort;
  }
  if (body.mode !== undefined) {
    if (body.mode !== 'ask' && body.mode !== 'auto-edits') {
      return { error: '`mode` must be "ask" or "auto-edits".' };
    }
    message.mode = body.mode;
  }
  return { message };
}

function isReference(value: any): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof value.n === 'number' &&
    typeof value.selector?.source === 'string' &&
    typeof value.kind === 'string'
  );
}

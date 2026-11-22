// The agent API (docs/agent-chat-plan.md §7.1), mounted by the engine under
// `api/agent` (`server/src/routes/agent.ts`, which also applies the
// fetch-metadata check to every route here).

import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import type { AgentRuntime } from './runtime.ts';
import { LoginError, UnsupportedAgentError } from './runtime.ts';
import { ProviderKeyError } from './api/providers.ts';
import { RevertError, SessionBusyError, type AgentSession } from './session.ts';
import { SessionStore } from './session-store.ts';
import {
  ATTACHMENT_MEDIA_TYPES,
  CLAUDE_EFFORTS,
  isEffortFor,
  splitApiModelId,
  type AgentKind,
  type ApprovalDecision,
  MAX_VARIANT_PICTURE_BYTES,
  type AttachmentMediaType,
  type ChatEventEnvelope,
  type MessageAttachment,
  type PermissionMode,
  type SceneReference,
  type SendMessage,
} from './types.ts';

/** A comment line this often keeps proxies and the browser from timing the stream out. */
export const HEARTBEAT_MS = 15_000;
const MAX_TEXT_CHARS = 100_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Images the user may attach to one message. */
export const MAX_ATTACHMENTS = 8;
/**
 * The largest attached image, decoded: its base64 stays within the 5 MB the
 * Anthropic API takes per image. The page sizes an image to this before it
 * sends it (`ui/src/ui/chat/image-attachments.ts`).
 */
export const MAX_ATTACHMENT_BYTES = 3_500_000;
const MAX_ATTACHMENT_NAME_CHARS = 120;
const MAX_REFERENCES = 8;
const MAX_MODEL_CHARS = 200;
/** Longest API key `PUT …/providers/:id/key` takes. */
const MAX_KEY_CHARS = 512;
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
    const kind = agentKindOf(req, res);
    if (!kind) {
      return;
    }
    res.json({ models: await runtime.models(kind) });
  });

  // --- The API agent's providers and keys (§20.3) ----------------------------
  //
  // A key goes in and never comes back out: the page learns `hasKey` and
  // `keySource` only.

  router.get('/providers', async (_req, res) => {
    res.json({ providers: await runtime.providerStatuses() });
  });

  router.put('/providers/:id/key', async (req, res) => {
    const apiKey = req.body?.apiKey;
    if (typeof apiKey !== 'string' || apiKey.trim() === '' || apiKey.length > MAX_KEY_CHARS) {
      res.status(400).json({ error: `\`apiKey\` must be a non-empty string of at most ${MAX_KEY_CHARS} characters.` });
      return;
    }
    await providerKeyRoute(res, () => runtime.setProviderKey(String(req.params.id), apiKey));
  });

  router.delete('/providers/:id/key', async (req, res) => {
    await providerKeyRoute(res, () => runtime.deleteProviderKey(String(req.params.id)));
  });

  // --- Signing in from the app (§5.2) ---------------------------------------
  //
  // The page opens `url` in the user's browser (ExternalLinks) and polls
  // the status; the account itself never passes through here.

  router.post('/agents/:kind/login', async (req, res) => {
    const kind = agentKindOf(req, res);
    if (!kind) {
      return;
    }
    try {
      const login = await runtime.startLogin(kind);
      res.json({ loginId: login.id, url: login.url });
    } catch (e) {
      if (e instanceof LoginError) {
        res.status(e.kind === 'unsupported' ? 404 : 409).json({ error: e.message, reason: e.kind });
        return;
      }
      res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  router.get('/agents/:kind/login/:loginId', (req, res) => {
    const kind = agentKindOf(req, res);
    if (!kind) {
      return;
    }
    const status = runtime.loginStatus(kind, String(req.params.loginId));
    if (!status) {
      res.status(404).json({ error: 'No such sign-in.' });
      return;
    }
    res.json(status);
  });

  router.post('/agents/:kind/login/:loginId/cancel', async (req, res) => {
    const kind = agentKindOf(req, res);
    if (!kind) {
      return;
    }
    if (!(await runtime.cancelLogin(kind, String(req.params.loginId)))) {
      res.status(404).json({ error: 'No such sign-in.' });
      return;
    }
    res.status(204).end();
  });

  // --- Sessions -------------------------------------------------------------

  router.get('/sessions', (_req, res) => {
    res.json({ sessions: runtime.list() });
  });

  router.post('/sessions', (req, res) => {
    const kind = req.body?.agent;
    if (kind !== 'claude' && kind !== 'codex' && kind !== 'api') {
      res.status(400).json({ error: '`agent` must be "claude", "codex" or "api".' });
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
    const parsed = parseSendMessage(req.body, session.record.agent.kind);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const providerChange = apiProviderChange(session, parsed.message.model);
    if (providerChange) {
      res.status(400).json({ error: providerChange });
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
    const mode = req.body?.mode;
    if (mode !== undefined && mode !== 'ask' && mode !== 'auto-edits') {
      res.status(400).json({ error: '`mode` must be "ask" or "auto-edits".' });
      return;
    }
    if (session.status.state !== 'interrupted') {
      res.status(409).json({ error: 'The session was not interrupted.' });
      return;
    }
    try {
      res.status(202).json(session.continueAfterRestart((mode as PermissionMode | undefined) ?? 'ask'));
    } catch (e) {
      if (e instanceof SessionBusyError) {
        res.status(409).json({ error: e.message });
        return;
      }
      throw e;
    }
  });

  // --- Approval and revert (§12.1, §12.2) -----------------------------------

  router.post('/sessions/:id/approvals/:approvalId', (req, res) => {
    const session = findSession(runtime, req, res);
    if (!session) {
      return;
    }
    const decision = req.body?.decision;
    if (decision !== 'allow' && decision !== 'allow-session' && decision !== 'deny') {
      res.status(400).json({ error: '`decision` must be "allow", "allow-session" or "deny".' });
      return;
    }
    const result = session.decideApproval(String(req.params.approvalId), decision as ApprovalDecision);
    switch (result) {
      case 'ok':
        res.status(204).end();
        return;
      case 'not-offered':
        res.status(400).json({ error: '"Allow for this session" is not offered for this action.' });
        return;
      case 'already-decided':
        res.status(409).json({ error: 'This approval was already settled.' });
        return;
      case 'not-found':
        res.status(404).json({ error: 'No such approval.' });
        return;
    }
  });

  // --- What a change does to the model (§25) ----------------------------------

  // The preview an approval card offers instead of building it unasked.
  router.post('/sessions/:id/approvals/:approvalId/preview', (req, res) => {
    const session = findSession(runtime, req, res);
    if (!session) {
      return;
    }
    switch (session.requestPreview(String(req.params.approvalId))) {
      case 'ok':
        res.status(204).end();
        return;
      case 'not-offered':
        res.status(409).json({ error: 'This approval offers no preview to build.' });
        return;
      case 'already-decided':
        res.status(409).json({ error: 'This approval was already settled.' });
        return;
      case 'not-found':
        res.status(404).json({ error: 'No such approval.' });
        return;
    }
  });

  // The pictures a page drew of the two sides of a change, kept with the
  // session so the card still shows them after a reload and after the engine
  // let the builds go.
  router.post('/sessions/:id/approvals/:approvalId/preview/pictures', (req, res) => {
    const session = findSession(runtime, req, res);
    if (!session) {
      return;
    }
    const pictures: { before?: Buffer; after?: Buffer } = {};
    for (const side of ['before', 'after'] as const) {
      const image = req.body?.[side];
      if (image === undefined) {
        continue;
      }
      const bytes = image && image.mediaType === 'image/png' && typeof image.base64 === 'string' ? Buffer.from(image.base64, 'base64') : null;
      if (!bytes || bytes.length === 0 || bytes.length > MAX_VARIANT_PICTURE_BYTES || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
        res.status(400).json({ error: `\`${side}\` is not { mediaType: "image/png", base64 } of a PNG, or is too large.` });
        return;
      }
      pictures[side] = bytes;
    }
    if (!pictures.before && !pictures.after) {
      res.status(400).json({ error: 'Expected { before?, after? }, each { mediaType: "image/png", base64 }.' });
      return;
    }
    const saved = session.savePreviewPictures(String(req.params.approvalId), pictures);
    switch (saved.result) {
      case 'ok':
        res.status(204).end();
        return;
      case 'not-built':
        res.status(409).json({ error: 'That change has no build to be a picture of.' });
        return;
      case 'not-found':
        res.status(404).json({ error: 'No such approval.' });
        return;
    }
  });

  // --- Questions (§22) -------------------------------------------------------

  router.post('/sessions/:id/questions/:questionId', (req, res) => {
    const session = findSession(runtime, req, res);
    if (!session) {
      return;
    }
    const answer = session.answerQuestion(String(req.params.questionId), req.body);
    switch (answer.result) {
      case 'ok':
        res.status(204).end();
        return;
      case 'invalid':
        res.status(400).json({ error: answer.error });
        return;
      case 'already-answered':
        res.status(409).json({ error: 'This question was already settled.' });
        return;
      case 'not-found':
        res.status(404).json({ error: 'No such question.' });
        return;
    }
  });

  // --- Variants (§24) --------------------------------------------------------

  router.post('/sessions/:id/variants/:variantsId', (req, res) => {
    const session = findSession(runtime, req, res);
    if (!session) {
      return;
    }
    const choice = session.chooseVariant(String(req.params.variantsId), req.body);
    switch (choice.result) {
      case 'ok':
        res.status(204).end();
        return;
      case 'invalid':
        res.status(400).json({ error: choice.error });
        return;
      case 'building':
        res.status(409).json({ error: 'The variants are still building.' });
        return;
      case 'already-settled':
        res.status(409).json({ error: 'These variants were already settled.' });
        return;
      case 'not-found':
        res.status(404).json({ error: 'No such variants.' });
        return;
    }
  });

  // The picture a page drew of one tile, kept with the session so the card
  // still shows it after a reload and after the engine let the build go.
  router.post('/sessions/:id/variants/:variantsId/pictures', (req, res) => {
    const session = findSession(runtime, req, res);
    if (!session) {
      return;
    }
    const label = req.body?.label;
    const image = req.body?.image;
    if (typeof label !== 'string' || label === '' || !image || image.mediaType !== 'image/png' || typeof image.base64 !== 'string') {
      res.status(400).json({ error: 'Expected { label, image: { mediaType: "image/png", base64 } }.' });
      return;
    }
    const bytes = Buffer.from(image.base64, 'base64');
    if (bytes.length === 0 || bytes.length > MAX_VARIANT_PICTURE_BYTES || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
      res.status(400).json({ error: '`image` is not a PNG, or is too large.' });
      return;
    }
    const saved = session.saveVariantPicture(String(req.params.variantsId), label, bytes);
    switch (saved.result) {
      case 'ok':
        res.status(204).end();
        return;
      case 'not-built':
        res.status(409).json({ error: 'That variant has no build to be a picture of.' });
        return;
      case 'not-found':
        res.status(404).json({ error: 'No such variant.' });
        return;
    }
  });

  router.post('/sessions/:id/revert', async (req, res) => {
    const session = findSession(runtime, req, res);
    if (!session) {
      return;
    }
    const turnId = req.body?.turnId;
    if (typeof turnId !== 'string' || turnId === '') {
      res.status(400).json({ error: '`turnId` must be a turn id.' });
      return;
    }
    try {
      res.json(await session.revert(turnId));
    } catch (e) {
      if (e instanceof SessionBusyError) {
        res.status(409).json({ error: e.message });
        return;
      }
      if (e instanceof RevertError) {
        res.status(e.kind === 'not-found' ? 404 : 409).json({ error: e.message });
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

function agentKindOf(req: Request, res: Response): AgentKind | null {
  const kind = String(req.params.kind ?? '');
  if (kind !== 'claude' && kind !== 'codex' && kind !== 'api') {
    res.status(404).json({ error: `Unknown agent: ${kind}` });
    return null;
  }
  return kind;
}

/** Runs a key change and answers it: 204, or 404 (unknown provider), 409 (the key comes from the environment), 400. */
async function providerKeyRoute(res: Response, change: () => Promise<void>): Promise<void> {
  try {
    await change();
    res.status(204).end();
  } catch (e) {
    if (e instanceof ProviderKeyError) {
      res.status(e.reason === 'not-found' ? 404 : e.reason === 'env' ? 409 : 400).json({ error: e.message });
      return;
    }
    if (e instanceof UnsupportedAgentError) {
      res.status(404).json({ error: e.message });
      return;
    }
    // Never the key: the store's own errors do not carry it either.
    res.status(500).json({ error: 'The key could not be saved.' });
  }
}

/**
 * Why a message may not run an API chat on `model`: an API chat stays on
 * the provider it started with (§20.1), so its history never crosses
 * providers. Null when it may.
 */
function apiProviderChange(session: AgentSession, model: string | undefined): string | null {
  if (session.record.agent.kind !== 'api' || !model || !session.record.agent.model) {
    return null;
  }
  const before = splitApiModelId(session.record.agent.model)?.providerId;
  const after = splitApiModelId(model)?.providerId;
  return before && after && before !== after
    ? `This chat runs on the "${before}" provider; start a new chat to use "${after}".`
    : null;
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

/** Validates the body of `POST …/messages` to a session of agent `kind`. */
export function parseSendMessage(body: any, kind: AgentKind = 'claude'): { message: SendMessage } | { error: string } {
  if (!body || typeof body !== 'object') {
    return { error: 'Expected a JSON body.' };
  }
  let attachments: MessageAttachment[] | undefined;
  if (body.attachments !== undefined) {
    if (!Array.isArray(body.attachments) || body.attachments.length > MAX_ATTACHMENTS) {
      return { error: `\`attachments\` must be at most ${MAX_ATTACHMENTS} images.` };
    }
    attachments = [];
    for (const raw of body.attachments) {
      const attachment = parseAttachment(raw);
      if (!attachment) {
        return { error: `Each of \`attachments\` must be { mediaType, base64 }: a PNG, JPEG, WebP or GIF of at most ${MAX_ATTACHMENT_BYTES} bytes.` };
      }
      attachments.push(attachment);
    }
  }
  // An image can go without words; nothing else can.
  const text = attachments && attachments.length > 0 && (body.text === undefined || body.text === null) ? '' : body.text;
  if (typeof text !== 'string' || (text.trim() === '' && !(attachments && attachments.length > 0))) {
    return { error: '`text` must be a non-empty string.' };
  }
  if (text.length > MAX_TEXT_CHARS) {
    return { error: `\`text\` is longer than ${MAX_TEXT_CHARS} characters.` };
  }
  const message: SendMessage = { text };
  if (attachments && attachments.length > 0) {
    message.attachments = attachments;
  }
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
    if (kind === 'api' && !splitApiModelId(body.model)) {
      return { error: '`model` must name its provider: `<provider>/<model>`, e.g. `anthropic/claude-opus-5-5`.' };
    }
    message.model = body.model;
  }
  if (body.effort !== undefined && body.effort !== null && body.effort !== '') {
    if (!isEffortFor(kind, body.effort)) {
      return {
        error: kind === 'claude'
          ? `\`effort\` must be one of ${CLAUDE_EFFORTS.join(', ')}.`
          : '`effort` must be a reasoning effort the model lists (low, medium, high, …).',
      };
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

/**
 * The image type `bytes` start as, by signature; null for anything else. An
 * attachment is what its bytes say, whatever the request called it.
 */
export function sniffImageType(bytes: Buffer): AttachmentMediaType | null {
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  const head = bytes.subarray(0, 12).toString('latin1');
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) {
    return 'image/gif';
  }
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/** One entry of `attachments`, or null when it is not an image a message may carry. */
function parseAttachment(raw: any): MessageAttachment | null {
  if (!raw || typeof raw !== 'object' || typeof raw.base64 !== 'string' || !(ATTACHMENT_MEDIA_TYPES as readonly unknown[]).includes(raw.mediaType)) {
    return null;
  }
  const bytes = Buffer.from(raw.base64, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES || sniffImageType(bytes) !== raw.mediaType) {
    return null;
  }
  // The name is shown and told to the model: one line, no control characters, not long.
  const name = typeof raw.name === 'string' ? raw.name.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_ATTACHMENT_NAME_CHARS) : '';
  return { mediaType: raw.mediaType, base64: raw.base64, ...(name ? { name } : {}) };
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

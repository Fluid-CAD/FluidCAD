#!/usr/bin/env node
// A stand-in for `codex` in tests: answers `--version` and `login status`,
// and `app-server` speaks enough of the app-server protocol (0.162.1 shapes,
// see codex-*.jsonl) for FluidCAD's driver. No model, no network beyond the
// MCP endpoint a test hands it.
//
// FAKE_CODEX_VERSION    what --version reports (default 0.162.1)
// FAKE_CODEX_LOGGED_IN  0: `login status` exits 1
// FAKE_CODEX_LOG        a file every message in and out is appended to ({dir, msg} lines)
// FAKE_CODEX_MCP        ready (default): say fluidcad_app is ready | connect: connect to the
//                       thread's MCP url with a real client | failed | silent (never says)
// FAKE_CODEX_LISTED     what mcpServerStatus/list says of fluidcad_app (default: connected
//                       unless FAKE_CODEX_MCP is failed)
// FAKE_CODEX_LEAK       a user server mcpServerStatus/list reports as connected anyway
// FAKE_CODEX_USER_SERVERS  JSON object for config.mcp_servers
// FAKE_CODEX_RESUME_FAIL   1: thread/resume of an unknown thread fails
//
// The first word of a turn's text picks what the turn does: hello (default),
// tool <name> <json args>, hang-on <name> <json args> (calls the tool and then
// waits for an interrupt; after it, calls it again, late), slow, deaf (ignores
// interrupts), fail-401, usage-limit, ask, image, crash.

import fs from 'node:fs';
import readline from 'node:readline';

const args = process.argv.slice(2);

if (args[0] === '--version') {
  console.log(`codex-cli ${process.env.FAKE_CODEX_VERSION ?? '0.162.1'}`);
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  if (process.env.FAKE_CODEX_LOGGED_IN === '0') {
    console.error('Not logged in');
    process.exit(1);
  }
  console.error('Logged in using ChatGPT');
  process.exit(0);
}
if (args[0] !== 'app-server') {
  console.error(`fake codex: unsupported ${args.join(' ')}`);
  process.exit(2);
}

const logFile = process.env.FAKE_CODEX_LOG;
const log = (dir, msg) => {
  if (logFile) {
    fs.appendFileSync(logFile, `${JSON.stringify({ dir, pid: process.pid, msg })}\n`);
  }
};
log('start', { cwd: process.cwd() });

const send = (msg) => {
  log('out', msg);
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};
const notify = (method, params) => send({ method, params, emittedAtMs: Date.now() });

let nextServerRequestId = 1000;
const serverRequests = new Map();
function serverRequest(method, params) {
  const id = nextServerRequestId++;
  return new Promise((resolve) => {
    serverRequests.set(id, resolve);
    send({ id, method, params });
  });
}

const threads = new Map();
let threadCounter = 0;
let turnCounter = 0;
const turns = new Map();

const userServers = JSON.parse(process.env.FAKE_CODEX_USER_SERVERS ?? '{"FluidCAD":{"command":"fluidcad"},"figma":{"url":"https://example.invalid/mcp"}}');

// Noise the client must ignore.
process.stdout.write('not json at all\n');
notify('remoteControl/status/changed', { status: 'disabled', serverName: 'host', installationId: '0', environmentId: null });

async function connectMcp(url) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'fake-codex', version: '0.162.1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

async function openThread(id, params) {
  const thread = { id, config: params.config ?? {}, client: null };
  threads.set(id, thread);
  const mode = process.env.FAKE_CODEX_MCP ?? 'ready';
  // As 0.162.1 does on resume: "starting" can come before the answer.
  notify('mcpServer/startupStatus/updated', { threadId: id, name: 'fluidcad_app', status: 'starting', error: null, failureReason: null });
  setTimeout(async () => {
    if (mode === 'silent') {
      return;
    }
    if (mode === 'failed') {
      notify('mcpServer/startupStatus/updated', { threadId: id, name: 'fluidcad_app', status: 'failed', error: 'connection refused', failureReason: null });
      return;
    }
    if (mode === 'connect') {
      try {
        thread.client = await connectMcp(thread.config['mcp_servers.fluidcad_app.url']);
      } catch (e) {
        notify('mcpServer/startupStatus/updated', { threadId: id, name: 'fluidcad_app', status: 'failed', error: String(e), failureReason: null });
        return;
      }
    }
    notify('mcpServer/startupStatus/updated', { threadId: id, name: 'fluidcad_app', status: 'ready', error: null, failureReason: null });
  }, 5);
  return { thread: { id, preview: '', status: { type: 'idle' } }, model: params.model ?? 'gpt-test', cwd: params.cwd };
}

function item(threadId, turnId, phase, value) {
  notify(`item/${phase}`, { item: value, threadId, turnId, [phase === 'started' ? 'startedAtMs' : 'completedAtMs']: Date.now() });
}

function completeTurn(threadId, turnId, status, error = null) {
  const turn = turns.get(turnId);
  if (!turn || turn.done) {
    return;
  }
  turn.done = true;
  notify('turn/completed', { threadId, turn: { id: turnId, items: [], itemsView: 'notLoaded', status, error, startedAt: 1, completedAt: 2, durationMs: 1 } });
}

function agentMessage(threadId, turnId, id, text) {
  item(threadId, turnId, 'started', { type: 'agentMessage', id, text: '', phase: 'final_answer' });
  for (const word of text.match(/\S+\s*/g) ?? []) {
    notify('item/agentMessage/delta', { threadId, turnId, itemId: id, delta: word });
  }
  item(threadId, turnId, 'completed', { type: 'agentMessage', id, text, phase: 'final_answer' });
}

function usage(threadId, turnId, input, output) {
  const breakdown = { totalTokens: input + output, inputTokens: input, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0 };
  notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: breakdown, last: breakdown, modelContextWindow: 1000 } });
}

async function callTool(thread, turnId, name, toolArgs, itemId) {
  item(thread.id, turnId, 'started', { type: 'mcpToolCall', id: itemId, server: 'fluidcad_app', tool: name, status: 'inProgress', arguments: toolArgs, result: null, error: null });
  thread.client ??= await connectMcp(thread.config['mcp_servers.fluidcad_app.url']);
  const result = await thread.client.callTool({ name, arguments: toolArgs });
  log('tool-result', { turnId, itemId, name, result });
  return result;
}

async function runTurn(thread, turnId, input) {
  const text = input.find((i) => i.type === 'text')?.text ?? '';
  const [command, ...rest] = text.split('\n')[0].split(' ');
  const turn = turns.get(turnId);
  const t = thread.id;
  notify('turn/started', { threadId: t, turn: { id: turnId, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null } });
  notify('something/new', { threadId: t, turnId, surprise: true });
  switch (command) {
    case 'tool': {
      const [name, ...json] = rest;
      const result = await callTool(thread, turnId, name, JSON.parse(json.join(' ') || '{}'), `exec-${turnId}`);
      item(t, turnId, 'completed', { type: 'mcpToolCall', id: `exec-${turnId}`, server: 'fluidcad_app', tool: name, status: result.isError ? 'failed' : 'completed', arguments: {}, result, error: null });
      agentMessage(t, turnId, `msg-${turnId}`, 'Done.');
      usage(t, turnId, 100, 10);
      completeTurn(t, turnId, 'completed');
      return;
    }
    case 'hang-on': {
      const [name, ...json] = rest;
      const toolArgs = JSON.parse(json.join(' ') || '{}');
      turn.onInterrupt = () => {
        // Codex 0.162.1: the turn ends, the MCP call in flight is neither cancelled nor completed.
        completeTurn(t, turnId, 'interrupted');
        // A call the model had already decided on reaches the server after the interrupt.
        setTimeout(() => {
          void callTool(thread, turnId, name, { ...toolArgs, content: 'late' }, `late-${turnId}`).catch((e) => log('tool-error', { message: String(e) }));
        }, 20);
      };
      void callTool(thread, turnId, name, toolArgs, `exec-${turnId}`).catch((e) => log('tool-error', { message: String(e) }));
      return;
    }
    case 'slow':
      item(t, turnId, 'started', { type: 'commandExecution', id: `cmd-${turnId}`, command: 'sleep 100', cwd: '/', status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null });
      agentMessage(t, turnId, `msg-${turnId}`, 'working…');
      turn.onInterrupt = () => completeTurn(t, turnId, 'interrupted');
      return;
    case 'deaf':
      turn.onInterrupt = () => {};
      return;
    case 'fail-401': {
      const info = { httpConnectionFailed: { httpStatusCode: 401 } };
      for (const n of [1, 2]) {
        notify('error', { error: { message: `Reconnecting... ${n}/5`, codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } }, additionalDetails: 'unexpected status 401' }, willRetry: true, threadId: t, turnId });
      }
      const error = { message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header', codexErrorInfo: info, additionalDetails: null };
      notify('error', { error, willRetry: false, threadId: t, turnId });
      completeTurn(t, turnId, 'failed', error);
      return;
    }
    case 'usage-limit':
      notify('account/rateLimits/updated', { rateLimits: { limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1795000000 }, secondary: null } });
      completeTurn(t, turnId, 'failed', { message: "You've hit your usage limit.", codexErrorInfo: 'usageLimitExceeded', additionalDetails: null });
      return;
    case 'ask': {
      const answers = {};
      answers.command = await serverRequest('item/commandExecution/requestApproval', { threadId: t, turnId, itemId: 'c1', startedAtMs: 1, command: 'rm -rf build', kind: 'command' });
      answers.fileChange = await serverRequest('item/fileChange/requestApproval', { threadId: t, turnId, itemId: 'f1', startedAtMs: 1 });
      answers.permissions = await serverRequest('item/permissions/requestApproval', { threadId: t, turnId, itemId: 'p1', startedAtMs: 1, cwd: '/', reason: null, permissions: {} });
      answers.elicitation = await serverRequest('mcpServer/elicitation/request', { threadId: t, turnId, serverName: 'figma', mode: 'form', message: 'Pick one', requestedSchema: {}, _meta: null });
      answers.refresh = await serverRequest('account/chatgptAuthTokens/refresh', { reason: 'unauthorized' });
      log('answers', answers);
      item(t, turnId, 'started', { type: 'commandExecution', id: 'c1', command: 'rm -rf build', cwd: '/', status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null });
      item(t, turnId, 'completed', { type: 'commandExecution', id: 'c1', command: 'rm -rf build', cwd: '/', status: 'declined', commandActions: [], aggregatedOutput: null, exitCode: null });
      agentMessage(t, turnId, `msg-${turnId}`, 'I could not run it.');
      completeTurn(t, turnId, 'completed');
      return;
    }
    case 'image': {
      const image = input.find((i) => i.type === 'localImage');
      agentMessage(t, turnId, `msg-${turnId}`, `image: ${image ? image.path : 'none'}`);
      completeTurn(t, turnId, 'completed');
      return;
    }
    case 'crash':
      process.stderr.write('boom: the fake crashed\n');
      process.exit(3);
      return;
    default: {
      const reasoning = `rs-${turnId}`;
      item(t, turnId, 'started', { type: 'reasoning', id: reasoning, summary: [], content: [] });
      notify('item/reasoning/summaryPartAdded', { threadId: t, turnId, itemId: reasoning, summaryIndex: 0 });
      notify('item/reasoning/summaryTextDelta', { threadId: t, turnId, itemId: reasoning, delta: '**Looking**', summaryIndex: 0 });
      item(t, turnId, 'completed', { type: 'reasoning', id: reasoning, summary: ['**Looking**'], content: [] });
      agentMessage(t, turnId, `msg-${turnId}`, `echo: ${text.split('\n')[0]}`);
      usage(t, turnId, 1000 * (turnCounter + 1), 10);
      completeTurn(t, turnId, 'completed');
    }
  }
}

async function onRequest(msg) {
  const { id, method, params = {} } = msg;
  const reply = (result) => send({ id, result });
  const fail = (code, message) => send({ id, error: { code, message } });
  switch (method) {
    case 'initialize':
      return reply({ userAgent: `fluidcad/0.162.1 (fake) (${params.clientInfo?.name}; ${params.clientInfo?.version})`, codexHome: '/nowhere', platformFamily: 'unix', platformOs: 'linux' });
    case 'config/read':
      return reply({ config: { model: null, mcp_servers: userServers, approval_policy: 'on-request' }, origins: {}, layers: null });
    case 'thread/start': {
      threadCounter += 1;
      return reply(await openThread(`thread-${process.pid}-${threadCounter}`, params));
    }
    case 'thread/resume': {
      if (!threads.has(params.threadId) && process.env.FAKE_CODEX_RESUME_FAIL === '1') {
        return fail(-32600, `no rollout found for thread id ${params.threadId}`);
      }
      return reply(await openThread(params.threadId, params));
    }
    case 'thread/unsubscribe': {
      const thread = threads.get(params.threadId);
      threads.delete(params.threadId);
      await thread?.client?.close().catch(() => {});
      return reply({ status: thread ? 'unsubscribed' : 'notLoaded' });
    }
    case 'mcpServerStatus/list': {
      const mcp = process.env.FAKE_CODEX_MCP ?? 'ready';
      const ours = process.env.FAKE_CODEX_LISTED ?? (mcp === 'failed' ? 'failed' : mcp === 'silent' ? 'starting' : 'connected');
      const data = [
        { name: 'fluidcad_app', runtimeStatus: ours, toolsError: null, authStatus: 'unsupported' },
        ...Object.keys(userServers).map((name) => ({ name, runtimeStatus: name === process.env.FAKE_CODEX_LEAK ? 'connected' : 'disabled', authStatus: 'unsupported' })),
        { name: 'codex_apps', runtimeStatus: 'disabled', authStatus: 'unsupported' },
      ];
      return reply({ data, nextCursor: null });
    }
    case 'model/list':
      return reply({
        data: [
          { id: 'gpt-test-luna', model: 'gpt-test-luna', displayName: 'GPT-Test-Luna', description: 'Fast and affordable.', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'medium', description: '' }], defaultReasoningEffort: 'medium', inputModalities: ['text', 'image'], isDefault: false },
          { id: 'gpt-test-astra', model: 'gpt-test-astra', displayName: 'GPT-Test-Astra', description: 'Deep.', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'high', description: '' }], defaultReasoningEffort: 'high', inputModalities: ['text'], isDefault: true },
          { id: 'hidden-one', model: 'hidden-one', displayName: 'Hidden', description: '', hidden: true, supportedReasoningEfforts: [], defaultReasoningEffort: 'low', inputModalities: ['text'], isDefault: false },
        ],
        nextCursor: null,
      });
    case 'turn/start': {
      const thread = threads.get(params.threadId);
      if (!thread) {
        return fail(-32600, `thread not found: ${params.threadId}`);
      }
      turnCounter += 1;
      const turnId = `turn-${turnCounter}`;
      turns.set(turnId, { done: false, onInterrupt: null });
      reply({ turn: { id: turnId, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null } });
      void runTurn(thread, turnId, params.input ?? []).catch((e) => log('turn-error', { message: String(e) }));
      return;
    }
    case 'turn/interrupt': {
      const turn = turns.get(params.turnId);
      reply({});
      turn?.onInterrupt?.();
      return;
    }
    default:
      return fail(-32601, `unknown method ${method}`);
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  log('in', msg);
  if (msg.id !== undefined && msg.method === undefined) {
    serverRequests.get(msg.id)?.(msg.error ? { error: msg.error } : msg.result);
    serverRequests.delete(msg.id);
    return;
  }
  if (msg.method && msg.id !== undefined) {
    void onRequest(msg);
  }
});
process.stdin.on('end', () => process.exit(0));

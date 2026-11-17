import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildThreadConfig,
  buildThreadResumeParams,
  buildThreadStartParams,
  CODEX_TOOL_TIMEOUT_SEC,
  modelParam,
  userServerNames,
} from '../src/codex/thread-config.ts';
import { declineServerRequest } from '../src/codex/server-requests.ts';
import { JsonRpcConnection, JsonRpcError, type JsonRpcNotification, type JsonRpcServerRequest } from '../src/codex/json-rpc.ts';

const MCP_URL = 'http://127.0.0.1:3100/api/agent/mcp/secret';

describe('the thread configuration (§5.2, §19)', () => {
  it('is the configuration Phase 0 verified against codex-cli 0.162.1', () => {
    const verified = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'codex-hardened-thread-start-params.json'), 'utf8'));
    const config = buildThreadConfig({ mcpUrl: verified.config['mcp_servers.fluidcad_app.url'], userServers: ['figma', 'node_repl', 'Neon', 'FluidCAD', 'blender'] });
    expect(config).toEqual(verified.config);
  });

  it('disables every server of the user\'s config, turns plugins and apps off, and adds only FluidCAD\'s', () => {
    const config = buildThreadConfig({ mcpUrl: MCP_URL, userServers: ['FluidCAD', 'figma', 'my-db'] });
    expect(config['mcp_servers.FluidCAD.enabled']).toBe(false);
    expect(config['mcp_servers.figma.enabled']).toBe(false);
    expect(config['mcp_servers.my-db.enabled']).toBe(false);
    expect(config['features.plugins']).toBe(false);
    expect(config['features.apps']).toBe(false);
    expect(config['features.shell_tool']).toBe(false);
    expect(config.web_search).toBe('disabled');
    expect(config['mcp_servers.fluidcad_app.url']).toBe(MCP_URL);
    expect(config['mcp_servers.fluidcad_app.tool_timeout_sec']).toBe(CODEX_TOOL_TIMEOUT_SEC);
    expect(CODEX_TOOL_TIMEOUT_SEC).toBe(3600);
    expect(config['mcp_servers.fluidcad_app.default_tools_approval_mode']).toBe('approve');
    const servers = Object.keys(config).filter((k) => k.startsWith('mcp_servers.')).map((k) => k.split('.')[1]);
    expect([...new Set(servers)].sort()).toEqual(['FluidCAD', 'figma', 'fluidcad_app', 'my-db']);
    // A user server that shares our name is not disabled (ours replaces it).
    expect(buildThreadConfig({ mcpUrl: MCP_URL, userServers: ['fluidcad_app'] })['mcp_servers.fluidcad_app.enabled']).toBeUndefined();
  });

  it('starts read-only with no approvals, the instructions and the model', () => {
    const params = buildThreadStartParams({ cwd: '/w', instructions: 'be brief', model: 'gpt-test', mcpUrl: MCP_URL, userServers: ['figma'] });
    expect(params).toEqual({
      cwd: '/w',
      sandbox: 'read-only',
      approvalPolicy: 'never',
      developerInstructions: 'be brief',
      model: 'gpt-test',
      config: buildThreadConfig({ mcpUrl: MCP_URL, userServers: ['figma'] }),
    });
    // "default" leaves the model to Codex.
    expect(buildThreadStartParams({ cwd: '/w', instructions: 'i', model: 'default', mcpUrl: MCP_URL, userServers: [] })).not.toHaveProperty('model');
    expect(modelParam(undefined)).toBeNull();
  });

  it('resends everything on resume: without it the user\'s servers come back and FluidCAD\'s is dropped', () => {
    const input = { cwd: '/w', instructions: 'i', model: 'gpt-test', mcpUrl: MCP_URL, userServers: ['FluidCAD'] };
    const resume = buildThreadResumeParams('thread-9', input);
    expect(resume).toEqual({ threadId: 'thread-9', ...buildThreadStartParams(input) });
    expect((resume.config as any)['mcp_servers.FluidCAD.enabled']).toBe(false);
    expect((resume.config as any)['mcp_servers.fluidcad_app.url']).toBe(MCP_URL);
  });

  it('reads the user\'s server names from config/read', () => {
    expect(userServerNames({ config: { mcp_servers: { FluidCAD: { command: 'x' }, figma: { url: 'y' } } } })).toEqual(['FluidCAD', 'figma']);
    expect(userServerNames({ config: { mcp_servers: ['a', 'b', 'a'] } })).toEqual(['a', 'b']);
    // Names a dotted key cannot carry are skipped (mcpServerStatus/list catches any that run).
    expect(userServerNames({ config: { mcp_servers: { 'a.b': {}, 'ok_1': {} } } })).toEqual(['ok_1']);
    expect(userServerNames({ config: {} })).toEqual([]);
    expect(userServerNames(null)).toEqual([]);
  });
});

describe('declining server requests', () => {
  const req = (method: string, params: object = {}): JsonRpcServerRequest => ({ id: 1, method, params: { threadId: 't', ...params } });

  it('declines approvals, cancels elicitations, grants no permission and refuses the rest', () => {
    expect(declineServerRequest(req('item/commandExecution/requestApproval', { command: 'rm -rf build' }))).toEqual({
      answer: { result: { decision: 'decline' } },
      notice: 'Codex asked to run a command (`rm -rf build`). FluidCAD declined: commands are not available here.',
    });
    expect(declineServerRequest(req('item/fileChange/requestApproval')).answer).toEqual({ result: { decision: 'decline' } });
    expect(declineServerRequest(req('item/permissions/requestApproval')).answer).toEqual({ result: { permissions: {}, scope: 'turn' } });
    const elicitation = declineServerRequest(req('mcpServer/elicitation/request', { serverName: 'figma' }));
    expect(elicitation.answer).toEqual({ result: { action: 'cancel', content: null, _meta: null } });
    expect(elicitation.notice).toContain('cancelled');
    expect(declineServerRequest(req('item/tool/requestUserInput')).answer).toEqual({ result: { answers: {} } });
    expect(declineServerRequest(req('execCommandApproval')).answer).toEqual({
      result: { decision: { denied: { rejection: 'FluidCAD does not allow this action.' } } },
    });
    expect(declineServerRequest(req('applyPatchApproval')).notice).toContain('declined');
    const unknown = declineServerRequest(req('account/chatgptAuthTokens/refresh'));
    expect(unknown).toEqual({ answer: { error: { code: -32601, message: 'FluidCAD does not support account/chatgptAuthTokens/refresh.' } }, notice: null });
    for (const r of [req('item/commandExecution/requestApproval'), req('item/fileChange/requestApproval'), req('mcpServer/elicitation/request')]) {
      expect(declineServerRequest(r).notice).not.toBeNull();
    }
  });
});

describe('JsonRpcConnection', () => {
  function connection() {
    const written: any[] = [];
    const notifications: JsonRpcNotification[] = [];
    const requests: JsonRpcServerRequest[] = [];
    const rpc = new JsonRpcConnection((line) => written.push(JSON.parse(line)), {
      onNotification: (m) => notifications.push(m),
      onServerRequest: (m) => {
        requests.push(m);
        if (m.method === 'boom') {
          throw new Error('nope');
        }
        return declineServerRequest(m).answer;
      },
    });
    return { rpc, written, notifications, requests };
  }

  it('numbers requests, sends no "jsonrpc" field, and matches answers by id, across split lines', async () => {
    const { rpc, written } = connection();
    const a = rpc.request('model/list', { includeHidden: false });
    const b = rpc.request('config/read');
    rpc.notify('initialized');
    expect(written).toEqual([
      { id: 1, method: 'model/list', params: { includeHidden: false } },
      { id: 2, method: 'config/read' },
      { method: 'initialized' },
    ]);
    rpc.pushChunk('{"id":2,"result":{"config":{}}}\n{"id":1,"res');
    rpc.pushChunk('ult":{"data":[]},"unknownField":true}\n');
    await expect(b).resolves.toEqual({ config: {} });
    await expect(a).resolves.toEqual({ data: [] });
  });

  it('rejects on an error answer and when the peer goes away', async () => {
    const { rpc } = connection();
    const failing = rpc.request('thread/resume', { threadId: 'x' });
    rpc.pushLine('{"id":1,"error":{"code":-32600,"message":"no rollout found"}}');
    await expect(failing).rejects.toBeInstanceOf(JsonRpcError);
    const waiting = rpc.request('turn/start', {});
    rpc.close(new Error('Codex exited with code 3.'));
    await expect(waiting).rejects.toThrow('exited with code 3');
    await expect(rpc.request('again')).rejects.toThrow('exited with code 3');
  });

  it('passes notifications on, answers server requests, and ignores what is not JSON-RPC', () => {
    const { rpc, written, notifications, requests } = connection();
    rpc.pushChunk('not json\n[1,2]\n{"method":"turn/started","params":{"threadId":"t"},"emittedAtMs":1}\n');
    rpc.pushChunk('{"id":"r-1","method":"item/fileChange/requestApproval","params":{"threadId":"t"}}\n{"id":7,"method":"boom"}\n');
    expect(notifications).toEqual([{ method: 'turn/started', params: { threadId: 't' } }]);
    expect(requests.map((r) => r.method)).toEqual(['item/fileChange/requestApproval', 'boom']);
    expect(written).toEqual([
      { id: 'r-1', result: { decision: 'decline' } },
      { id: 7, error: { code: -32603, message: 'nope' } },
    ]);
  });
});

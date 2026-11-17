import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, TOOL_CLASSES, type RegistryEntry } from '../../mcp/dist/server.js';
import { ToolGate, toolClass, toolKind, type ToolGateHost } from '../src/tool-gate.ts';
import { applyChatEvent } from '../src/transcript.ts';
import type { ChatEvent, ChatMessage, PermissionMode, ToolPart } from '../src/types.ts';

// The pinned server never reaches this engine in these tests: only docs and
// skills tools run, and every other call is denied before it would.
const pinned: RegistryEntry = {
  workspacePath: '/w',
  port: 1,
  pid: process.pid,
  version: '0.0.0',
  startedAt: new Date(0).toISOString(),
};

class FakeHost implements ToolGateHost {
  readonly workspacePath = '/w';
  readonly events: ChatEvent[] = [];
  readonly messages: ChatMessage[] = [];
  turn: { turnId: string; mode: PermissionMode } | null = { turnId: 't1', mode: 'ask' };
  persisted = 0;
  private messageId: string | null = null;

  activeTurn() {
    return this.turn;
  }
  assistantMessageId(): string {
    if (!this.messageId) {
      this.messageId = 'a1';
      this.emit({ type: 'message-start', message: { id: 'a1', role: 'assistant', turnId: 't1', createdAt: '' } });
    }
    return this.messageId;
  }
  emit(event: ChatEvent): void {
    this.events.push(event);
    applyChatEvent(this.messages, event);
  }
  saveImage(): string {
    return 'img.png';
  }
  persist(): void {
    this.persisted += 1;
  }
  tools(): ToolPart[] {
    return (this.messages[0]?.parts ?? []).filter((p): p is ToolPart => p.type === 'tool');
  }
}

const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) {
    await c.close().catch(() => {});
  }
});

async function connect(gate: ToolGate): Promise<Client> {
  const server = buildServer({ pinnedWorkspace: pinned, toolGate: gate });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'gate-test', version: '0.0.0' });
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}

const textOf = (result: any) => (result.content as any[]).map((b) => b.text).join('');

describe('ToolGate classification', () => {
  it('classifies every tool the pinned server offers, and nothing it does not', async () => {
    const client = await connect(new ToolGate(new FakeHost()));
    const { tools } = await client.listTools();
    const unclassified = tools.map((t) => t.name).filter((name) => toolClass(name) === undefined);
    // A new MCP tool must get a class in mcp/src/tool-classes.ts before it ships.
    expect(unclassified).toEqual([]);
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(TOOL_CLASSES).sort());
  });

  it('maps classes to the kinds a tool card shows', () => {
    expect(toolKind('get_scene_summary')).toBe('read');
    expect(toolKind('read_file')).toBe('read');
    expect(toolKind('screenshot')).toBe('read');
    expect(toolKind('write_file')).toBe('edit');
    expect(toolKind('rollback_to')).toBe('edit');
    expect(toolKind('export')).toBe('outside');
    expect(toolKind('not_a_tool')).toBe('other');
  });
});

describe('ToolGate decisions (phase 2: read-only)', () => {
  it('runs a read tool and records its result on a tool part', async () => {
    const host = new FakeHost();
    const client = await connect(new ToolGate(host));
    const result = await client.callTool({ name: 'read_skill', arguments: { name: 'fluidcad' } });
    expect(result.isError).not.toBe(true);

    const [part] = host.tools();
    expect(part).toMatchObject({
      source: 'fluidcad',
      name: 'read_skill',
      title: 'Read the fluidcad skill',
      kind: 'read',
      state: 'done',
      input: { name: 'fluidcad' },
    });
    expect(part.output?.text).toContain('fluidcad');
    // Saved when the call started and when it ended.
    expect(host.persisted).toBe(2);
    expect(host.events.map((e) => e.type)).toEqual(['message-start', 'part-start', 'part-update']);
  });

  it.each([
    ['write_file', { path: '/w/a.fluid.js', content: '' }, 'edit'],
    ['edit_range', { path: '/w/a.fluid.js', start: { line: 0, column: 0 }, end: { line: 1, column: 0 }, newText: '' }, 'edit'],
    ['recompute', {}, 'edit'],
    ['export', { shapeIds: ['s'], format: 'step' }, 'outside'],
  ])('denies %s with a message the model can act on', async (name, args, kind) => {
    const host = new FakeHost();
    const client = await connect(new ToolGate(host));
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`did not run ${name}`);
    expect(textOf(result)).toContain('Do not retry');
    const [part] = host.tools();
    expect(part).toMatchObject({ name, kind, state: 'denied' });
    expect(part.error).toContain('only reading');
  });

  it('runs nothing outside a turn', async () => {
    const host = new FakeHost();
    host.turn = null;
    const client = await connect(new ToolGate(host));
    const result = await client.callTool({ name: 'read_skill', arguments: { name: 'fluidcad' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('No chat turn is running');
    expect(host.events).toEqual([]);
  });

  it('titles edits by file and 1-based lines', async () => {
    const host = new FakeHost();
    const client = await connect(new ToolGate(host));
    await client.callTool({
      name: 'edit_range',
      arguments: { path: '/w/parts/bracket.fluid.js', start: { line: 11, column: 0 }, end: { line: 17, column: 0 }, newText: '' },
    });
    expect(host.tools()[0].title).toBe('Edit parts/bracket.fluid.js, lines 12–18');
  });
});

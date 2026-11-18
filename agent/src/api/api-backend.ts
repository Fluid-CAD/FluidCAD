// FluidCAD's own agent loop (docs/agent-chat-plan.md §20): the AI SDK's
// `streamText` on a model provider the user has a key for, or a local
// OpenAI-compatible server. Its tools are FluidCAD's, reached over the
// session's MCP endpoint (`mcpUrl`) like the CLIs reach them, so the gate's
// approvals, diffs and checkpoints apply unchanged and report the tool cards;
// the tool parts of the stream are dropped here. The conversation the model
// sees is ours to keep: `ModelMessage[]` beside `session.json`.

import fs from 'node:fs';
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { InvalidToolInputError, isStepCount, NoSuchToolError, streamText, type LanguageModel, type ModelMessage, type ToolSet, type UserContent } from 'ai';
import { Agent, fetch as undiciFetch } from 'undici';
import { AsyncQueue } from '../async-queue.ts';
import { TurnFailure, type AgentBackend, type AgentInstall, type AgentModel, type AgentRun, type BackendEvent, type DetectOptions, type OpenOptions, type TurnImage } from '../backend.ts';
import { splitApiModelId } from '../types.ts';
import { mapProviderError, redact, type ErrorContext } from './errors.ts';
import { HISTORY_FILE, historyPath, readHistory, writeHistory } from './history.ts';
import { createLanguageModel, providerOptionsFor, systemMessage, withoutImages } from './language-model.ts';
import type { ApiModelInfo } from './models.ts';
import { ProviderRegistry, type ResolvedProvider } from './providers.ts';

/** Model steps (requests) one turn may take before it stops and says so (§20.5). */
export const DEFAULT_STEP_LIMIT = 50;
/** How long an interrupt waits for the turn to wind down. */
const INTERRUPT_GRACE_MS = 5_000;
/** Characters per token of the prompt, measured on qwen3 (§20.6: 111 k chars, 26.9 k tokens). */
const CHARS_PER_TOKEN = 4;
/** A step whose reported input is below this share of the prompt's size was cut by the server. */
const TRUNCATED_SHARE = 0.6;

export const NOT_READY_PROBLEM = 'No model provider is ready. Add an API key in Settings → Agent, or a local server.';

export type CreateModel = (provider: ResolvedProvider, model: string, options: { images: boolean }) => LanguageModel;

export type ApiBackendOptions = {
  providers: ProviderRegistry;
  stepLimit?: number;
  /** The AI SDK model for a provider's model (tests pass mock models). */
  createModel?: CreateModel;
  /** The fetch the MCP client uses (default: no body timeout, §20.6). */
  mcpFetch?: typeof fetch;
  /** The client version the MCP handshake names. */
  clientVersion?: string;
};

/**
 * A fetch with no headers or body timeout, for the loopback MCP endpoint:
 * a call the gate holds for the user's approval keeps its response stream
 * silent for up to an hour, and Node's own fetch gives up after five
 * minutes of silence (§20.6).
 */
function patientFetch(): typeof fetch {
  const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
  return ((input: any, init?: any) => undiciFetch(input, { ...init, dispatcher })) as unknown as typeof fetch;
}

export class ApiBackend implements AgentBackend {
  readonly kind = 'api' as const;
  readonly providers: ProviderRegistry;
  private readonly options: ApiBackendOptions;
  private mcpFetchValue: typeof fetch | null = null;

  constructor(options: ApiBackendOptions) {
    this.options = options;
    this.providers = options.providers;
  }

  /** Nothing to locate: ready when any provider is (§20.3). No model request. */
  async detect(_options?: DetectOptions): Promise<AgentInstall> {
    const providers = await this.providers.statuses();
    const ready = providers.some((p) => p.ready);
    return {
      kind: 'api',
      path: null,
      version: null,
      minVersion: '',
      supported: true,
      loggedIn: ready,
      providers,
      ...(ready ? {} : { problem: NOT_READY_PROBLEM }),
    };
  }

  models(): Promise<AgentModel[]> {
    return this.providers.models();
  }

  private get mcpFetch(): typeof fetch {
    this.mcpFetchValue ??= this.options.mcpFetch ?? patientFetch();
    return this.mcpFetchValue;
  }

  async open(options: OpenOptions): Promise<AgentRun> {
    if (!options.model) {
      throw new TurnFailure({ kind: 'other', message: 'Pick a model for this chat first.' });
    }
    const split = splitApiModelId(options.model);
    if (!split) {
      throw new TurnFailure({ kind: 'other', message: `"${options.model}" names no provider; pick a model in the chat.` });
    }
    const provider = await this.providers.forModel(split.providerId);
    const info = await this.providers.modelInfo(provider, split.model);
    const images = provider.builtIn ? info.acceptsImages : provider.images && info.acceptsImages;

    let history: ModelMessage[] = [];
    const notes: string[] = [];
    const file = options.sessionDir ? historyPath(options.sessionDir, HISTORY_FILE) : null;
    if (options.resume && options.sessionDir) {
      const stored = historyPath(options.sessionDir, options.resume);
      const loaded = stored ? readHistory(stored) : null;
      if (loaded) {
        history = loaded.messages;
      } else {
        notes.push('The earlier conversation with the model could not be read; it goes on from here without it.');
      }
    }
    const createModel = this.options.createModel ?? ((p, m, o) => createLanguageModel(p, m, o));
    return new ApiRun({
      provider,
      info,
      images,
      model: createModel(provider, split.model, { images }),
      effort: options.effort ?? null,
      instructions: options.instructions,
      mcpUrl: options.mcpUrl,
      historyFile: file,
      history,
      notes,
      stepLimit: this.options.stepLimit ?? DEFAULT_STEP_LIMIT,
      mcpFetch: this.mcpFetch,
      clientVersion: this.options.clientVersion ?? '0.0.0',
    });
  }
}

export type ApiRunOptions = {
  provider: ResolvedProvider;
  info: ApiModelInfo;
  /** Images reach this model. */
  images: boolean;
  model: LanguageModel;
  effort: string | null;
  instructions: string;
  mcpUrl: string;
  /** Where the history is kept; null keeps it in memory only. */
  historyFile: string | null;
  history: ModelMessage[];
  /** Notices for the first turn (an unreadable history). */
  notes?: string[];
  stepLimit: number;
  mcpFetch: typeof fetch;
  clientVersion: string;
};

type Turn = { abort: AbortController; done: Promise<void> };

/** One chat session's conversation with one model; turns run one at a time. */
export class ApiRun implements AgentRun {
  readonly ref = HISTORY_FILE;
  private readonly o: ApiRunOptions;
  private readonly queue = new AsyncQueue<BackendEvent>();
  private readonly history: ModelMessage[];
  private readonly notes: string[];
  private mcp: { client: MCPClient; tools: ToolSet; promptTokens: number } | null = null;
  private connecting: Promise<{ client: MCPClient; tools: ToolSet; promptTokens: number }> | null = null;
  private turn: Turn | null = null;
  private turns = 0;
  private closed = false;
  private warnedContext = false;

  constructor(options: ApiRunOptions) {
    this.o = options;
    this.history = [...options.history];
    this.notes = [...(options.notes ?? [])];
  }

  get events(): AsyncIterable<BackendEvent> {
    return this.queue;
  }

  /** The conversation as the model sees it (tests). */
  get messages(): ModelMessage[] {
    return this.history;
  }

  send(input: { text: string; images?: TurnImage[] }): void {
    if (this.closed) {
      throw new Error('The chat with the model was closed.');
    }
    if (this.turn) {
      throw new Error('A turn is already running.');
    }
    const abort = new AbortController();
    const turn: Turn = { abort, done: Promise.resolve() };
    this.turn = turn;
    turn.done = this.runTurn(input, abort).catch((e) => {
      // runTurn reports its own failures; this is a bug's last stop.
      console.error('[agent] the API turn failed:', e);
      this.endTurn(turn, { type: 'turn-end', reason: 'error', error: { kind: 'other', message: redact(e instanceof Error ? e.message : String(e), { apiKey: this.o.provider.apiKey }) } });
    });
  }

  async interrupt(): Promise<void> {
    const turn = this.turn;
    if (!turn) {
      return;
    }
    turn.abort.abort();
    // A call the gate holds sees its signal only when the MCP session closes
    // (§20.6); the next turn connects again.
    await this.disconnect();
    await Promise.race([turn.done, delay(INTERRUPT_GRACE_MS)]);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const turn = this.turn;
    turn?.abort.abort();
    await this.disconnect();
    if (turn) {
      await Promise.race([turn.done, delay(INTERRUPT_GRACE_MS)]);
    }
    this.queue.end();
  }

  // ---------------------------------------------------------------------------

  private async runTurn(input: { text: string; images?: TurnImage[] }, abort: AbortController): Promise<void> {
    const turn = this.turn!;
    const turnNo = ++this.turns;
    for (const note of this.notes.splice(0)) {
      this.emit({ type: 'notice', level: 'info', text: note });
    }

    const userMessage = this.userMessage(input);
    this.history.push(userMessage);
    const userIndex = this.history.length - 1;

    let tools: ToolSet;
    let promptTokens: number;
    try {
      ({ tools, promptTokens } = await this.connect());
    } catch (e) {
      this.history.splice(userIndex);
      const reason = redact(e instanceof Error ? e.message : String(e), {});
      this.endTurn(turn, { type: 'turn-end', reason: 'error', error: { kind: 'other', message: `FluidCAD's tools did not connect: ${reason}` } });
      return;
    }
    if (abort.signal.aborted) {
      this.endTurn(turn, { type: 'turn-end', reason: 'interrupted' });
      return;
    }
    this.warnSmallContext(promptTokens);

    const p = this.o.provider;
    const errorContext: ErrorContext = { label: p.label, kind: p.kind, builtIn: p.builtIn, ...(p.baseURL ? { baseURL: p.baseURL } : {}), apiKey: p.apiKey };
    let step = -1;
    let completedSteps = 0;
    let stepText = '';
    const inFlight = new Map<string, string>();
    let lastFinish: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let sawUsage = false;
    let failure: unknown = null;

    try {
      const result = streamText({
        model: this.o.model,
        instructions: systemMessage(p, this.o.instructions),
        // A copy: the history grows under the stream as steps end.
        messages: this.o.images ? [...this.history] : withoutImages([...this.history]),
        tools,
        stopWhen: isStepCount(this.o.stepLimit),
        abortSignal: abort.signal,
        providerOptions: providerOptionsFor(p, this.o.info, this.o.effort),
        // A local server that is down stays down: say so at once.
        maxRetries: p.builtIn ? 2 : 0,
        ...(this.o.images ? {} : { prepareStep: ({ messages }: { messages: ModelMessage[] }) => ({ messages: withoutImages(messages) }) }),
        onStepEnd: (s) => {
          this.history.push(...(s.response.messages as ModelMessage[]));
          completedSteps += 1;
          this.save();
        },
        // Failures arrive as `error` parts; nothing is logged with request bodies.
        onError: () => {},
      });
      for await (const part of result.stream) {
        switch (part.type) {
          case 'start-step':
            step += 1;
            stepText = '';
            inFlight.clear();
            break;
          case 'text-delta':
            stepText += part.text;
            this.emit({ type: 'text-delta', id: `t${turnNo}-s${step}-${part.id}`, delta: part.text });
            break;
          case 'reasoning-delta':
            this.emit({ type: 'reasoning-delta', id: `t${turnNo}-s${step}-r${part.id}`, delta: part.text });
            break;
          case 'text-end':
            this.emit({ type: 'block-end', id: `t${turnNo}-s${step}-${part.id}` });
            break;
          case 'reasoning-end':
            this.emit({ type: 'block-end', id: `t${turnNo}-s${step}-r${part.id}` });
            break;
          // FluidCAD's tools are reported by the gate; the stream's tool parts are dropped (§20.5).
          case 'tool-call':
            inFlight.set(part.toolCallId, part.toolName);
            break;
          case 'tool-result':
            inFlight.delete(part.toolCallId);
            break;
          case 'tool-error':
            inFlight.delete(part.toolCallId);
            if (!abort.signal.aborted) {
              this.toolErrorNotice(part.toolName, part.error);
            }
            break;
          case 'finish-step':
            lastFinish = part.finishReason;
            if (part.usage.inputTokens !== undefined || part.usage.outputTokens !== undefined) {
              sawUsage = true;
              inputTokens += part.usage.inputTokens ?? 0;
              outputTokens += part.usage.outputTokens ?? 0;
            }
            this.checkTruncation(step, part.usage.inputTokens, promptTokens);
            break;
          case 'error':
            failure ??= part.error;
            break;
          default:
            break;
        }
      }
    } catch (e) {
      failure ??= e;
    }

    const usage = sawUsage ? { inputTokens, outputTokens } : null;
    if (abort.signal.aborted) {
      this.keepStoppedStep(stepText, [...inFlight.values()]);
      this.save();
      this.endTurn(turn, { type: 'turn-end', reason: 'interrupted' }, usage);
      return;
    }
    if (failure) {
      if (completedSteps === 0) {
        // Nothing of the turn reached the model's side: a retry should not send the message twice.
        this.history.splice(userIndex);
      }
      this.save();
      this.endTurn(turn, { type: 'turn-end', reason: 'error', error: mapProviderError(failure, errorContext) }, usage);
      return;
    }
    if (lastFinish === 'tool-calls' && completedSteps >= this.o.stepLimit) {
      this.emit({ type: 'notice', level: 'info', text: `Stopped after ${this.o.stepLimit} model steps in one turn. Send "continue" to let it carry on.` });
    } else if (lastFinish === 'content-filter') {
      this.emit({ type: 'notice', level: 'warning', text: 'The model declined to go on (its provider stopped the reply).' });
    } else if (lastFinish === 'length') {
      this.emit({ type: 'notice', level: 'warning', text: 'The reply stopped at the model\'s output limit.' });
    }
    this.save();
    this.endTurn(turn, { type: 'turn-end', reason: 'done' }, usage);
  }

  /** The user's message: the text, and its images (the attachments, the references capture) when the model takes images. */
  private userMessage(input: { text: string; images?: TurnImage[] }): ModelMessage {
    let text = input.text;
    const content: Exclude<UserContent, string> = [];
    const images = input.images ?? [];
    if (images.length > 0 && !this.o.images) {
      text += `\n\n(${images.length === 1 ? 'The image of this message is' : `The ${images.length} images of this message are`} not attached: this model does not take images.)`;
    } else {
      let unread = 0;
      for (const image of images) {
        try {
          content.push({ type: 'file', mediaType: image.mediaType, data: fs.readFileSync(image.path).toString('base64') });
        } catch {
          unread += 1;
        }
      }
      if (unread > 0) {
        text += `\n\n(${unread === 1 ? 'An image of this message' : `${unread} images of this message`} could not be read, so ${unread === 1 ? 'it is' : 'they are'} not attached.)`;
      }
    }
    return { role: 'user', content: [{ type: 'text', text }, ...content] };
  }

  /**
   * After a stop, the model's history keeps what it had said in the step it
   * was cut off in, and which tool calls were then in flight (they may or
   * may not have run). Reasoning is not kept: a cut-off block cannot be
   * replayed.
   */
  private keepStoppedStep(text: string, calls: string[]): void {
    const said = text.trim();
    if (said === '' && calls.length === 0) {
      return;
    }
    const lines = [said, calls.length > 0 ? `[Stopped by the user while calling ${[...new Set(calls)].join(', ')}; whether that ran is unknown.]` : '[Stopped by the user.]'];
    this.history.push({ role: 'assistant', content: [{ type: 'text', text: lines.filter((l) => l !== '').join('\n\n') }] });
  }

  private toolErrorNotice(name: string, error: unknown): void {
    if (NoSuchToolError.isInstance(error)) {
      this.emit({ type: 'notice', level: 'info', text: `The model asked for a tool FluidCAD does not have (${name}); it was told so.` });
    } else if (InvalidToolInputError.isInstance(error)) {
      this.emit({ type: 'notice', level: 'info', text: `The model called ${name} with input that does not fit the tool; it was told so.` });
    } else {
      const message = redact(error instanceof Error ? error.message : String(error), { apiKey: this.o.provider.apiKey });
      this.emit({ type: 'notice', level: 'warning', text: `A FluidCAD tool call (${name}) failed: ${message}` });
    }
  }

  /**
   * A custom entry whose context window is smaller than the instructions and
   * the tools need: said once per run (§20.5, §20.6).
   */
  private warnSmallContext(promptTokens: number): void {
    const p = this.o.provider;
    const window = p.contextWindow ?? (p.builtIn ? undefined : this.o.info.contextWindow);
    if (this.warnedContext || p.builtIn || !window || window >= promptTokens) {
      return;
    }
    this.warnedContext = true;
    this.emit({
      type: 'notice',
      level: 'warning',
      text: `${p.label} runs models with a context of ${window} tokens, but FluidCAD's instructions and tools alone take about ${roundUp(promptTokens)}. ` +
        `Give the model a context of at least ${roundUp(promptTokens * 1.3)} tokens on the server (for Ollama, OLLAMA_CONTEXT_LENGTH), then set it in Settings → Agent.`,
    });
  }

  /** A local server that reports fewer input tokens than the prompt has has cut it (Ollama's default context, §20.6). */
  private checkTruncation(step: number, reported: number | undefined, promptTokens: number): void {
    const p = this.o.provider;
    if (this.warnedContext || p.builtIn || step !== 0 || reported === undefined || reported <= 0 || reported >= promptTokens * TRUNCATED_SHARE) {
      return;
    }
    this.warnedContext = true;
    this.emit({
      type: 'notice',
      level: 'warning',
      text: `${p.label} read only ${reported} tokens of a prompt of about ${roundUp(promptTokens)}: its context is too small, and the model does not see FluidCAD's instructions and tools in full. ` +
        `Give it a context of at least ${roundUp(promptTokens * 1.3)} tokens (for Ollama, OLLAMA_CONTEXT_LENGTH) and set that in Settings → Agent.`,
    });
  }

  private async connect(): Promise<{ client: MCPClient; tools: ToolSet; promptTokens: number }> {
    if (this.mcp) {
      return this.mcp;
    }
    this.connecting ??= (async () => {
      const client = await createMCPClient({
        transport: { type: 'http', url: this.o.mcpUrl, fetch: this.o.mcpFetch, redirect: 'error' },
        clientName: 'fluidcad-agent',
        version: this.o.clientVersion,
        // FluidCAD's endpoint wants `initialize` first.
        protocolVersionDiscovery: false,
        onUncaughtError: (e) => console.error('[agent] MCP client:', e instanceof Error ? e.message : e),
      });
      try {
        const tools = (await client.tools()) as ToolSet;
        const connection = { client, tools, promptTokens: estimatePromptTokens(this.o.instructions, tools) };
        this.mcp = connection;
        return connection;
      } catch (e) {
        await client.close().catch(() => {});
        throw e;
      }
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async disconnect(): Promise<void> {
    const mcp = this.mcp ?? (await this.connecting?.catch((): null => null)) ?? null;
    this.mcp = null;
    if (mcp) {
      await mcp.client.close().catch(() => {});
    }
  }

  private save(): void {
    if (!this.o.historyFile) {
      return;
    }
    try {
      writeHistory(this.o.historyFile, this.o.provider.id, this.history);
    } catch (e) {
      console.error('[agent] could not save the model history:', e instanceof Error ? e.message : e);
    }
  }

  private emit(event: BackendEvent): void {
    this.queue.push(event);
  }

  private endTurn(turn: Turn, event: Extract<BackendEvent, { type: 'turn-end' }>, usage?: { inputTokens: number; outputTokens: number } | null): void {
    if (this.turn !== turn) {
      return;
    }
    // Cleared first: the session may send the next message as soon as it reads the end.
    this.turn = null;
    if (usage) {
      this.emit({ type: 'usage', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
    }
    this.emit(event);
  }
}

/** Roughly how many tokens the instructions and the tool schemas take (§20.6). */
export function estimatePromptTokens(instructions: string, tools: ToolSet): number {
  let chars = instructions.length;
  for (const [name, tool] of Object.entries(tools)) {
    const schema = (tool as { inputSchema?: { jsonSchema?: unknown } }).inputSchema?.jsonSchema ?? {};
    chars += name.length + (tool.description?.length ?? 0) + JSON.stringify(schema).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function roundUp(tokens: number): number {
  return Math.ceil(tokens / 1000) * 1000;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

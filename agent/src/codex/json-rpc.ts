// The wire of `codex app-server` (docs/agent-chat-plan.md §5.2, §19):
// JSON-RPC 2.0 without the `"jsonrpc"` field, one message per line, over the
// child's stdio. Three kinds of message arrive: responses to our requests
// (`id` and `result` or `error`), notifications (`method`, no `id`) and the
// server's own requests (`method` and `id`), which must be answered. Lines
// that are not JSON, and fields this client does not know, are ignored.

export type JsonRpcId = number | string;

export type JsonRpcErrorObject = { code: number; message: string; data?: unknown };

export type JsonRpcNotification = { method: string; params?: any };

export type JsonRpcServerRequest = { id: JsonRpcId; method: string; params?: any };

/** What answering a server request sends back: a result, or a JSON-RPC error. */
export type ServerRequestAnswer = { result: unknown } | { error: JsonRpcErrorObject };

export class JsonRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  readonly method: string;
  constructor(method: string, error: JsonRpcErrorObject) {
    super(error.message);
    this.method = method;
    this.code = error.code;
    this.data = error.data;
  }
}

export class JsonRpcClosedError extends Error {
  constructor(message = 'Codex is not running.') {
    super(message);
  }
}

export type JsonRpcHandlers = {
  onNotification(message: JsonRpcNotification): void;
  /** Answers a server request; anything it throws is sent back as an internal error. */
  onServerRequest(message: JsonRpcServerRequest): ServerRequestAnswer;
};

type Pending = {
  method: string;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

/**
 * One JSON-RPC connection. `write` sends one line; `pushChunk` feeds what the
 * peer printed; `close` fails every request still waiting.
 */
export class JsonRpcConnection {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private rest = '';
  private closedError: Error | null = null;

  constructor(
    private readonly write: (line: string) => void,
    private readonly handlers: JsonRpcHandlers,
  ) {}

  get isClosed(): boolean {
    return this.closedError !== null;
  }

  request<T = any>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    if (this.closedError) {
      return Promise.reject(this.closedError);
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`Codex did not answer ${method} within ${Math.round(timeoutMs / 1000)} s.`));
            }, timeoutMs)
          : null;
      timer?.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      this.send(params === undefined ? { id, method } : { id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closedError) {
      return;
    }
    this.send(params === undefined ? { method } : { method, params });
  }

  pushChunk(chunk: string): void {
    const text = this.rest + chunk;
    const lines = text.split('\n');
    this.rest = lines.pop() ?? '';
    for (const line of lines) {
      this.pushLine(line);
    }
  }

  /** Whatever is left without a newline (the peer exited mid-line). */
  flush(): void {
    if (this.rest.trim() !== '') {
      this.pushLine(this.rest);
    }
    this.rest = '';
  }

  pushLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') {
      return;
    }
    let message: any;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return;
    }
    const hasId = typeof message.id === 'number' || typeof message.id === 'string';
    const hasMethod = typeof message.method === 'string';
    if (hasId && !hasMethod) {
      this.onResponse(message);
    } else if (hasId && hasMethod) {
      this.onServerRequest(message);
    } else if (hasMethod) {
      try {
        this.handlers.onNotification({ method: message.method, params: message.params });
      } catch (e) {
        console.error(`[agent] handling the Codex notification ${message.method} failed:`, e);
      }
    }
  }

  /** The peer is gone: every waiting request fails with `error`. */
  close(error: Error = new JsonRpcClosedError()): void {
    if (this.closedError) {
      return;
    }
    this.closedError = error;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(error);
    }
  }

  private onResponse(message: any): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    if (message.error && typeof message.error === 'object') {
      pending.reject(
        new JsonRpcError(pending.method, {
          code: typeof message.error.code === 'number' ? message.error.code : -32000,
          message: typeof message.error.message === 'string' ? message.error.message : `${pending.method} failed.`,
          data: message.error.data,
        }),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  private onServerRequest(message: any): void {
    let answer: ServerRequestAnswer;
    try {
      answer = this.handlers.onServerRequest({ id: message.id, method: message.method, params: message.params });
    } catch (e) {
      answer = { error: { code: -32603, message: e instanceof Error ? e.message : String(e) } };
    }
    if (this.closedError) {
      return;
    }
    this.send('error' in answer ? { id: message.id, error: answer.error } : { id: message.id, result: answer.result });
  }

  private send(message: unknown): void {
    this.write(`${JSON.stringify(message)}\n`);
  }
}

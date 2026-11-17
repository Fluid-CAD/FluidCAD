import type {
  AgentInstall,
  AgentKind,
  AgentModel,
  ApprovalDecision,
  ChatEventEnvelope,
  PermissionMode,
  RevertResult,
  SendMessage,
  SessionSnapshot,
  SessionSummary,
} from './chat-types';

/** An answer from the agent API: the value, or why not (`status` 0: the engine did not answer). */
export type ChatAnswer<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

export type ChatStreamHandlers = {
  /** One `data:` payload, in order. */
  onEnvelope(envelope: ChatEventEnvelope): void;
  /**
   * The stream ended for good: the server refused it (the session is gone,
   * the engine answered an error). A dropped connection is not this — the
   * browser reconnects by itself with `Last-Event-ID`.
   */
  onClosed(): void;
};

export interface ChatStream {
  close(): void;
}

/**
 * The agent API as the panel uses it (docs/agent-chat-plan.md §7.1). The
 * page's only way to the runtime; tests use `FakeChatClient`.
 */
export interface ChatClient {
  /** What detection found for each CLI; `fresh` detects again (`POST agents/recheck`). */
  agents(fresh?: boolean): Promise<ChatAnswer<AgentInstall[]>>;
  models(kind: AgentKind): Promise<ChatAnswer<AgentModel[]>>;
  sessions(): Promise<ChatAnswer<SessionSummary[]>>;
  createSession(agent: AgentKind): Promise<ChatAnswer<{ id: string }>>;
  snapshot(id: string): Promise<ChatAnswer<SessionSnapshot>>;
  send(id: string, message: SendMessage): Promise<ChatAnswer<{ turnId: string }>>;
  cancel(id: string): Promise<ChatAnswer<null>>;
  /** Resume a turn an engine restart cut off, in permission `mode` (absent: ask). */
  continueTurn(id: string, mode?: PermissionMode): Promise<ChatAnswer<{ turnId: string }>>;
  /**
   * Answer a tool call waiting for approval (§12.1). Refused with 409 when it
   * was already settled (another tab, a stop), 400 when "Allow for this
   * session" is not offered, 404 when there is no such approval.
   */
  decideApproval(id: string, approvalId: string, decision: ApprovalDecision): Promise<ChatAnswer<null>>;
  /**
   * Revert `turnId` and every later turn that changed files, newest first
   * (§12.2). Refused with 409 while a turn or another revert runs.
   */
  revert(id: string, turnId: string): Promise<ChatAnswer<RevertResult>>;
  rename(id: string, title: string): Promise<ChatAnswer<null>>;
  remove(id: string): Promise<ChatAnswer<null>>;
  /** The URL of an image the session keeps under `files/` (relative). */
  fileUrl(id: string, name: string): string;
  /**
   * Attach to the session's event stream after `after` (the snapshot's
   * `seq`), for the snapshot's `epoch` (§7.3).
   */
  subscribe(id: string, from: { after: number; epoch: string }, handlers: ChatStreamHandlers): ChatStream;
}

const BASE = 'api/agent';

/**
 * {@link ChatClient} over the engine's HTTP routes: `fetch` and one
 * `EventSource` per attached session. Every URL is relative — the page is
 * served at `/` and at `/p/<id>/` — so none starts with a slash.
 */
export class HttpChatClient implements ChatClient {
  async agents(fresh = false): Promise<ChatAnswer<AgentInstall[]>> {
    const answer = fresh
      ? await this.request<{ agents: AgentInstall[] }>('POST', `${BASE}/agents/recheck`, {})
      : await this.request<{ agents: AgentInstall[] }>('GET', `${BASE}/agents`);
    return answer.ok === false ? answer : { ok: true, value: answer.value.agents };
  }

  async models(kind: AgentKind): Promise<ChatAnswer<AgentModel[]>> {
    const answer = await this.request<{ models: AgentModel[] }>('GET', `${BASE}/agents/${encodeURIComponent(kind)}/models`);
    return answer.ok === false ? answer : { ok: true, value: answer.value.models };
  }

  async sessions(): Promise<ChatAnswer<SessionSummary[]>> {
    const answer = await this.request<{ sessions: SessionSummary[] }>('GET', `${BASE}/sessions`);
    return answer.ok === false ? answer : { ok: true, value: answer.value.sessions };
  }

  createSession(agent: AgentKind): Promise<ChatAnswer<{ id: string }>> {
    return this.request('POST', `${BASE}/sessions`, { agent });
  }

  snapshot(id: string): Promise<ChatAnswer<SessionSnapshot>> {
    return this.request('GET', this.session(id));
  }

  send(id: string, message: SendMessage): Promise<ChatAnswer<{ turnId: string }>> {
    return this.request('POST', `${this.session(id)}/messages`, message);
  }

  cancel(id: string): Promise<ChatAnswer<null>> {
    return this.request('POST', `${this.session(id)}/cancel`, {});
  }

  continueTurn(id: string, mode?: PermissionMode): Promise<ChatAnswer<{ turnId: string }>> {
    return this.request('POST', `${this.session(id)}/continue`, mode ? { mode } : {});
  }

  decideApproval(id: string, approvalId: string, decision: ApprovalDecision): Promise<ChatAnswer<null>> {
    return this.request('POST', `${this.session(id)}/approvals/${encodeURIComponent(approvalId)}`, { decision });
  }

  revert(id: string, turnId: string): Promise<ChatAnswer<RevertResult>> {
    return this.request('POST', `${this.session(id)}/revert`, { turnId });
  }

  rename(id: string, title: string): Promise<ChatAnswer<null>> {
    return this.request('PATCH', this.session(id), { title });
  }

  remove(id: string): Promise<ChatAnswer<null>> {
    return this.request('DELETE', this.session(id));
  }

  fileUrl(id: string, name: string): string {
    return `${this.session(id)}/files/${encodeURIComponent(name)}`;
  }

  subscribe(id: string, from: { after: number; epoch: string }, handlers: ChatStreamHandlers): ChatStream {
    const query = new URLSearchParams({ after: String(from.after), epoch: from.epoch });
    const source = new EventSource(`${this.session(id)}/events?${query}`);
    let closed = false;
    source.onmessage = (message) => {
      if (closed) {
        return;
      }
      let envelope: ChatEventEnvelope;
      try {
        envelope = JSON.parse(message.data) as ChatEventEnvelope;
      } catch {
        return;
      }
      handlers.onEnvelope(envelope);
    };
    source.onerror = () => {
      // CONNECTING: the browser is reconnecting on its own (with Last-Event-ID).
      if (!closed && source.readyState === EventSource.CLOSED) {
        closed = true;
        handlers.onClosed();
      }
    };
    return {
      close: () => {
        closed = true;
        source.close();
      },
    };
  }

  private session(id: string): string {
    return `${BASE}/sessions/${encodeURIComponent(id)}`;
  }

  private async request<T>(method: string, url: string, body?: unknown): Promise<ChatAnswer<T>> {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      return { ok: false, status: 0, error: 'FluidCAD did not answer.' };
    }
    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as { error?: unknown } | null;
      const error = typeof json?.error === 'string' ? json.error : `The request failed (${res.status}).`;
      return { ok: false, status: res.status, error };
    }
    if (res.status === 204) {
      return { ok: true, value: null as T };
    }
    const value = (await res.json().catch(() => null)) as T;
    return { ok: true, value };
  }
}

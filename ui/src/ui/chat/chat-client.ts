import type {
  AgentInstall,
  AgentKind,
  AgentModel,
  ApiProviderStatus,
  ApprovalDecision,
  InstallTarget,
  ChatEventEnvelope,
  LoginStatus,
  ParamsKept,
  PermissionMode,
  QuestionReply,
  RevertResult,
  SendMessage,
  SessionSnapshot,
  SessionSummary,
  ChangePreviewPictures,
  VariantPicture,
  VariantsReply,
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
  /**
   * Start signing in to `kind` in the user's browser (Codex only): the page
   * to open. 409 when it is already signed in or not installed, 404 when the
   * agent signs in from a terminal only.
   */
  startLogin(kind: AgentKind): Promise<ChatAnswer<{ loginId: string; url: string }>>;
  loginStatus(kind: AgentKind, loginId: string): Promise<ChatAnswer<LoginStatus>>;
  cancelLogin(kind: AgentKind, loginId: string): Promise<ChatAnswer<null>>;
  /** The `api` agent's providers (§20.3): whether each has a key and is ready; never a key. */
  providers(): Promise<ChatAnswer<ApiProviderStatus[]>>;
  /**
   * Store a provider's API key on the engine (`PUT …/providers/:id/key`).
   * 409 when the environment sets it, 404 for a provider the engine does
   * not know (a custom entry not saved yet), 400 for an empty or overlong key.
   */
  setProviderKey(id: string, apiKey: string): Promise<ChatAnswer<null>>;
  removeProviderKey(id: string): Promise<ChatAnswer<null>>;
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
  /** `target`: where the user chose to install (an install's card). */
  decideApproval(id: string, approvalId: string, decision: ApprovalDecision, target?: InstallTarget): Promise<ChatAnswer<null>>;
  /**
   * Ask for the preview an approval card offers instead of building it
   * unasked (§25). Refused with 409 when it is not offered (building or
   * built already) or the approval was settled, 404 when there is none.
   */
  requestPreview(id: string, approvalId: string): Promise<ChatAnswer<null>>;
  /**
   * Hand over the pictures this page drew of the two sides of a change, to
   * be kept with the session. The first picture of a side is the one kept.
   */
  savePreviewPictures(id: string, approvalId: string, pictures: ChangePreviewPictures): Promise<ChatAnswer<null>>;
  /**
   * Answer (or skip) a question the agent asked. Refused with 409 when it
   * was already settled (another tab, a stop), 400 when the reply does not
   * fit the questions, 404 when there is no such question.
   */
  answerQuestion(id: string, questionId: string, reply: QuestionReply): Promise<ChatAnswer<null>>;
  /**
   * Reply to a variants card: a pick, the user's own words, or a skip.
   * Refused with 409 while the variants still build and once the card was
   * settled, 400 when the reply does not fit it, 404 when there is none.
   */
  chooseVariant(id: string, variantsId: string, reply: VariantsReply): Promise<ChatAnswer<null>>;
  /**
   * Hand over the picture this page drew of a variant's tile, to be kept
   * with the session. The first picture of a tile is the one kept.
   */
  saveVariantPicture(id: string, variantsId: string, picture: VariantPicture): Promise<ChatAnswer<null>>;
  /**
   * Tell the session what Keep wrote into the source from a parameter card
   * (§26). Refused with 400 when a value is not one of the card's or not a
   * value a parameter holds, 404 when there is no such card.
   */
  paramsKept(id: string, paramsId: string, kept: ParamsKept): Promise<ChatAnswer<null>>;
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

  startLogin(kind: AgentKind): Promise<ChatAnswer<{ loginId: string; url: string }>> {
    return this.request('POST', `${BASE}/agents/${encodeURIComponent(kind)}/login`, {});
  }

  loginStatus(kind: AgentKind, loginId: string): Promise<ChatAnswer<LoginStatus>> {
    return this.request('GET', `${BASE}/agents/${encodeURIComponent(kind)}/login/${encodeURIComponent(loginId)}`);
  }

  cancelLogin(kind: AgentKind, loginId: string): Promise<ChatAnswer<null>> {
    return this.request('POST', `${BASE}/agents/${encodeURIComponent(kind)}/login/${encodeURIComponent(loginId)}/cancel`, {});
  }

  async providers(): Promise<ChatAnswer<ApiProviderStatus[]>> {
    const answer = await this.request<{ providers: ApiProviderStatus[] }>('GET', `${BASE}/providers`);
    return answer.ok === false ? answer : { ok: true, value: answer.value.providers };
  }

  setProviderKey(id: string, apiKey: string): Promise<ChatAnswer<null>> {
    // The key goes in the body only: never in a URL, never logged.
    return this.request('PUT', this.providerKey(id), { apiKey });
  }

  removeProviderKey(id: string): Promise<ChatAnswer<null>> {
    return this.request('DELETE', this.providerKey(id));
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

  decideApproval(id: string, approvalId: string, decision: ApprovalDecision, target?: InstallTarget): Promise<ChatAnswer<null>> {
    return this.request('POST', `${this.session(id)}/approvals/${encodeURIComponent(approvalId)}`, { decision, ...(target ? { target } : {}) });
  }

  requestPreview(id: string, approvalId: string): Promise<ChatAnswer<null>> {
    return this.request('POST', `${this.session(id)}/approvals/${encodeURIComponent(approvalId)}/preview`, {});
  }

  savePreviewPictures(id: string, approvalId: string, pictures: ChangePreviewPictures): Promise<ChatAnswer<null>> {
    return this.request('POST', `${this.session(id)}/approvals/${encodeURIComponent(approvalId)}/preview/pictures`, pictures);
  }

  answerQuestion(id: string, questionId: string, reply: QuestionReply): Promise<ChatAnswer<null>> {
    return this.request('POST', `${this.session(id)}/questions/${encodeURIComponent(questionId)}`, reply);
  }

  chooseVariant(id: string, variantsId: string, reply: VariantsReply): Promise<ChatAnswer<null>> {
    return this.request('POST', `${this.session(id)}/variants/${encodeURIComponent(variantsId)}`, reply);
  }

  saveVariantPicture(id: string, variantsId: string, picture: VariantPicture): Promise<ChatAnswer<null>> {
    return this.request('POST', `${this.session(id)}/variants/${encodeURIComponent(variantsId)}/pictures`, picture);
  }

  paramsKept(id: string, paramsId: string, kept: ParamsKept): Promise<ChatAnswer<null>> {
    return this.request('POST', `${this.session(id)}/params/${encodeURIComponent(paramsId)}`, kept);
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

  private providerKey(id: string): string {
    return `${BASE}/providers/${encodeURIComponent(id)}/key`;
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

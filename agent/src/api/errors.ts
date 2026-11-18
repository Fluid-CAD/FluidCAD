// How a provider failure reads in the transcript (docs/agent-chat-plan.md
// §20.5): a refused key is `auth` with where to change it, a rate limit is
// `rate-limit`, an unreachable local server names its URL, anything else
// carries the provider's own words. No message ever carries a key.

import { APICallError, LoadAPIKeyError, RetryError } from 'ai';
import type { TurnError } from '../backend.ts';
import type { ApiProviderKind } from '../types.ts';

export type ErrorContext = {
  label: string;
  kind: ApiProviderKind;
  builtIn: boolean;
  baseURL?: string;
  /** The key in use: cut out of any text that would show it. */
  apiKey?: string | null;
};

const MAX_MESSAGE_CHARS = 600;

/** The TurnError for `error`, raised by a request to the provider in `ctx`. */
export function mapProviderError(error: unknown, ctx: ErrorContext): TurnError {
  const e = unwrap(error);
  if (LoadAPIKeyError.isInstance(e)) {
    return { kind: 'auth', message: `${ctx.label} has no API key. Add one in Settings → Agent.` };
  }
  if (APICallError.isInstance(e)) {
    const status = e.statusCode;
    if (status === 401 || status === 403) {
      return {
        kind: 'auth',
        message: ctx.builtIn
          ? `The ${ctx.label} key was refused. Change it in Settings → Agent.`
          : `${ctx.label} refused the request (HTTP ${status}). Check its API key in Settings → Agent.`,
      };
    }
    if (status === 429) {
      const resetsAt = retryAfter(e.responseHeaders);
      return {
        kind: 'rate-limit',
        message: `${ctx.label} is limiting requests: ${providerText(e, ctx)}`,
        ...(resetsAt ? { resetsAt } : {}),
      };
    }
    if (status === undefined && isConnectionFailure(e)) {
      return {
        kind: 'other',
        message: ctx.builtIn
          ? `Could not reach the ${ctx.label}: ${redact(causeText(e), ctx)}`
          : `Could not reach ${ctx.label} at ${ctx.baseURL ?? 'its base URL'}. Is the server running?`,
      };
    }
    if (isContextFull(e)) {
      return { kind: 'other', message: 'The conversation no longer fits the model\'s context window. Start a new chat to carry on.' };
    }
    if (!ctx.builtIn && status === 404) {
      return { kind: 'other', message: `${ctx.label} at ${ctx.baseURL ?? 'its base URL'} answered 404: ${providerText(e, ctx)} Check the model name and the base URL.` };
    }
    return { kind: 'other', message: `${ctx.label}: ${providerText(e, ctx)}${status ? ` (HTTP ${status})` : ''}` };
  }
  const text = e instanceof Error ? e.message : String(e);
  return { kind: 'other', message: `${ctx.label}: ${redact(text, ctx)}` };
}

/** The error a retry wrapper gave up on. */
function unwrap(error: unknown): unknown {
  let e = error;
  for (let i = 0; i < 4 && RetryError.isInstance(e); i++) {
    e = e.lastError;
  }
  return e;
}

/** The provider's own message: the body's `error.message` when there is one, else the error's. */
function providerText(e: APICallError, ctx: ErrorContext): string {
  let text = e.message;
  if (e.responseBody) {
    try {
      const body = JSON.parse(e.responseBody);
      const message = body?.error?.message ?? body?.message ?? (typeof body?.error === 'string' ? body.error : null);
      if (typeof message === 'string' && message.trim() !== '') {
        text = message;
      }
    } catch {
      // Not JSON: the error's own message.
    }
  }
  return redact(text, ctx);
}

function causeText(e: APICallError): string {
  const cause = (e as { cause?: unknown }).cause;
  const code = (cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? `${e.message} (${code})` : e.message;
}

function isConnectionFailure(e: APICallError): boolean {
  return /cannot connect|fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket/i.test(`${e.message} ${(e as { cause?: { code?: string } }).cause?.code ?? ''}`);
}

function isContextFull(e: APICallError): boolean {
  const text = `${e.message} ${e.responseBody ?? ''}`;
  return /prompt is too long|context[_ ]length[_ ]exceeded|maximum context length|context window|too many tokens|exceeds the context/i.test(text);
}

/** `Retry-After` (seconds, or an HTTP date) as an ISO instant. */
function retryAfter(headers: Record<string, string> | undefined): string | undefined {
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (!raw) {
    return undefined;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return new Date(Date.now() + seconds * 1000).toISOString();
  }
  const date = Date.parse(raw);
  return Number.isFinite(date) ? new Date(date).toISOString() : undefined;
}

/**
 * `text` without the key in use and without anything shaped like a
 * provider key, one line at a time, cut to a readable length.
 */
export function redact(text: string, ctx: Pick<ErrorContext, 'apiKey'>): string {
  let out = text;
  const key = ctx.apiKey?.trim();
  if (key && key.length >= 6) {
    out = out.split(key).join('[key]');
    // A provider may echo part of it ("sk-ant-…abcd").
    if (key.length > 12) {
      out = out.split(key.slice(-8)).join('[key]');
    }
  }
  out = out
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_\-]{8,}/g, '[key]')
    .replace(/\b(Bearer|x-api-key:?)\s+\S+/gi, '$1 [key]')
    .replace(/\s+/g, ' ')
    .trim();
  return out.length > MAX_MESSAGE_CHARS ? `${out.slice(0, MAX_MESSAGE_CHARS - 1)}…` : out;
}

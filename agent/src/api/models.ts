// What each model provider offers (docs/agent-chat-plan.md §20.3): read from
// its models endpoint, never hard-coded, except Anthropic's one suggested
// default. Each list is filtered to models the agent can use (chat models
// that take tools) and says, where the provider tells, which efforts a model
// takes, whether it takes images, and its context window.

import type { ApiProviderKind } from '../types.ts';

/** The one model FluidCAD suggests (§20.3); every other id comes from the provider. */
export const SUGGESTED_MODELS: Partial<Record<ApiProviderKind, string>> = { anthropic: 'claude-opus-5-5' };

/** One model of one provider, as the driver uses it. `id` is the provider's own (no `<providerId>/`). */
export type ApiModelInfo = {
  id: string;
  label?: string;
  efforts?: string[];
  defaultEffort?: string;
  acceptsImages: boolean;
  contextWindow?: number;
  /** Anthropic: the model takes adaptive thinking (summarized display is asked for). */
  adaptiveThinking?: boolean;
  /** The model reasons (OpenAI reasoning models: summaries and encrypted reasoning are asked for). */
  reasoning?: boolean;
};

export type ModelListSource = {
  kind: ApiProviderKind;
  /** openai-compatible: the server's base URL. */
  baseURL?: string;
  apiKey: string | null;
  /** openai-compatible: whether images are sent to its models. */
  images?: boolean;
};

/** The provider's models endpoint failed; `status` is the HTTP status when there was one. */
export class ModelListError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
  }
}

const LIST_TIMEOUT_MS = 10_000;
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';
const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
/** The levels OpenAI's and OpenRouter's reasoning models all take. */
const REASONING_EFFORTS = ['low', 'medium', 'high'];

/** Reads the models of one provider. Throws ModelListError; the message never carries the key. */
export async function listModels(source: ModelListSource, fetchFn: typeof fetch = fetch): Promise<ApiModelInfo[]> {
  switch (source.kind) {
    case 'anthropic':
      return parseAnthropicModels(await getAllAnthropicPages(source.apiKey, fetchFn));
    case 'openai':
      return parseOpenAIModels(await getJson(OPENAI_MODELS_URL, bearer(source.apiKey), fetchFn));
    case 'openrouter':
      return parseOpenRouterModels(await getJson(OPENROUTER_MODELS_URL, bearer(source.apiKey), fetchFn));
    case 'openai-compatible':
      return parseCompatibleModels(await getJson(`${source.baseURL}/models`, bearer(source.apiKey), fetchFn), source.images === true);
  }
}

function bearer(apiKey: string | null): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

async function getAllAnthropicPages(apiKey: string | null, fetchFn: typeof fetch): Promise<unknown[]> {
  const headers = { 'anthropic-version': '2023-06-01', ...(apiKey ? { 'x-api-key': apiKey } : {}) };
  const data: unknown[] = [];
  let after: string | null = null;
  // A few pages at most; the list holds a couple dozen models.
  for (let page = 0; page < 10; page++) {
    const url = `${ANTHROPIC_MODELS_URL}?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`;
    const body = (await getJson(url, headers, fetchFn)) as { data?: unknown[]; has_more?: boolean; last_id?: string };
    data.push(...(Array.isArray(body?.data) ? body.data : []));
    if (!body?.has_more || typeof body.last_id !== 'string') {
      break;
    }
    after = body.last_id;
  }
  return data;
}

async function getJson(url: string, headers: Record<string, string>, fetchFn: typeof fetch): Promise<any> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
  } catch (e) {
    const cause = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e);
    throw new ModelListError(`Could not reach ${originOf(url)}: ${cause}`, null);
  }
  if (!res.ok) {
    throw new ModelListError(`${originOf(url)} answered HTTP ${res.status} to the model list.`, res.status);
  }
  try {
    return await res.json();
  } catch {
    throw new ModelListError(`${originOf(url)} did not answer the model list with JSON.`, res.status);
  }
}

function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'the server';
  }
}

const supported = (value: any): boolean => value?.supported === true;

/**
 * Anthropic's `GET /v1/models`: `display_name`, `max_input_tokens` and
 * `capabilities` (effort levels, image input, adaptive thinking), §20.6.
 */
export function parseAnthropicModels(data: unknown[]): ApiModelInfo[] {
  const out: ApiModelInfo[] = [];
  for (const raw of data) {
    const m = raw as any;
    if (typeof m?.id !== 'string' || m.id === '') {
      continue;
    }
    const caps = m.capabilities;
    const info: ApiModelInfo = {
      id: m.id,
      ...(typeof m.display_name === 'string' ? { label: m.display_name } : {}),
      // Every current model takes images; trust the list when it says.
      acceptsImages: caps?.image_input ? supported(caps.image_input) : true,
      ...(typeof m.max_input_tokens === 'number' ? { contextWindow: m.max_input_tokens } : {}),
    };
    if (supported(caps?.effort)) {
      const efforts = ['low', 'medium', 'high', 'xhigh', 'max'].filter((level) => supported(caps.effort[level]));
      if (efforts.length > 0) {
        info.efforts = efforts;
        // Anthropic's own default.
        info.defaultEffort = efforts.includes('high') ? 'high' : efforts[efforts.length - 1];
      }
    }
    if (supported(caps?.thinking?.types?.adaptive)) {
      info.adaptiveThinking = true;
    }
    out.push(info);
  }
  return out;
}

/** Ids of OpenAI models that are not chat models, or do not take function tools. */
const OPENAI_NOT_CHAT = /(realtime|audio|tts|transcribe|whisper|image|dall-e|embedding|moderation|search|live|instruct|diarize|chat-latest|babbage|davinci|computer-use|translate|sora)/;
/** A dated snapshot (`gpt-5-2025-08-07`): listed only when its alias is not. */
const DATED_SNAPSHOT = /-\d{4}-\d{2}-\d{2}$/;

/** Whether an OpenAI model id is a reasoning model (o-series, gpt-5 and later). */
export function isOpenAIReasoningModel(id: string): boolean {
  return /^o\d/.test(id) || /^gpt-([5-9]|\d{2,})/.test(id);
}

/** OpenAI's `GET /v1/models` lists ids only (§20.6): chat models are picked by id. */
export function parseOpenAIModels(body: any): ApiModelInfo[] {
  const ids: string[] = (Array.isArray(body?.data) ? body.data : [])
    .map((m: any) => m?.id)
    .filter((id: unknown): id is string => typeof id === 'string' && /^(gpt-|o\d)/.test(id) && !OPENAI_NOT_CHAT.test(id));
  const all = new Set(ids);
  return ids
    .filter((id) => !DATED_SNAPSHOT.test(id) || !all.has(id.replace(DATED_SNAPSHOT, '')))
    .sort(compareModelIds)
    .map((id) => {
      const reasoning = isOpenAIReasoningModel(id);
      return {
        id,
        acceptsImages: !/^o\d-mini/.test(id),
        ...(reasoning ? { reasoning: true, efforts: [...REASONING_EFFORTS], defaultEffort: 'medium' } : {}),
      };
    });
}

/** OpenRouter's `GET /api/v1/models`: only models that take tools; images and reasoning from what each lists. */
export function parseOpenRouterModels(body: any): ApiModelInfo[] {
  const out: ApiModelInfo[] = [];
  for (const m of Array.isArray(body?.data) ? body.data : []) {
    const params: unknown[] = Array.isArray(m?.supported_parameters) ? m.supported_parameters : [];
    if (typeof m?.id !== 'string' || !params.includes('tools')) {
      continue;
    }
    const inputs: unknown[] = Array.isArray(m?.architecture?.input_modalities) ? m.architecture.input_modalities : [];
    const reasoning = params.includes('reasoning');
    out.push({
      id: m.id,
      ...(typeof m.name === 'string' ? { label: m.name } : {}),
      acceptsImages: inputs.includes('image'),
      ...(typeof m.context_length === 'number' ? { contextWindow: m.context_length } : {}),
      ...(reasoning ? { reasoning: true, efforts: [...REASONING_EFFORTS], defaultEffort: 'medium' } : {}),
    });
  }
  return out.sort((a, b) => compareModelIds(a.id, b.id));
}

/** An OpenAI-compatible server's `GET <baseURL>/models`: ids; images as the entry says. */
export function parseCompatibleModels(body: any, images: boolean): ApiModelInfo[] {
  const ids: string[] = (Array.isArray(body?.data) ? body.data : [])
    .map((m: any) => m?.id)
    .filter((id: unknown): id is string => typeof id === 'string' && id !== '');
  return [...new Set(ids)].sort(compareModelIds).map((id) => ({ id, acceptsImages: images }));
}

function compareModelIds(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true });
}

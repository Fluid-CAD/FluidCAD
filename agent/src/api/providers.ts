// The API agent's model providers (docs/agent-chat-plan.md §20.2): the three
// built-ins, the user's custom OpenAI-compatible entries (`agent.providers`),
// where each one's key comes from, whether it is ready, and the models it
// offers. Keys stay in here and in the driver: statuses carry only whether
// there is one and where it comes from.

import { AgentCredentials } from '../../../server/dist/agent-credentials.js';
import type { AgentProviderConfig, Preferences } from '../../../server/dist/preferences.js';
import type { AgentModel } from '../backend.ts';
import { TurnFailure } from '../backend.ts';
import type { ApiProviderKind, ApiProviderStatus } from '../types.ts';
import { listModels, ModelListError, SUGGESTED_MODELS, type ApiModelInfo } from './models.ts';

/** A provider with everything the driver needs, the key included. Never sent to the page. */
export type ResolvedProvider = {
  id: string;
  kind: ApiProviderKind;
  label: string;
  builtIn: boolean;
  baseURL?: string;
  apiKey: string | null;
  keySource: 'env' | 'stored' | null;
  /** Whether images are sent to its models (custom entries: `images`, default false). */
  images: boolean;
  contextWindow?: number;
  /** Custom entries: models to offer when the server cannot list them. */
  models?: string[];
};

const BUILT_INS: { id: string; kind: ApiProviderKind; label: string }[] = [
  { id: 'anthropic', kind: 'anthropic', label: 'Anthropic API' },
  { id: 'openai', kind: 'openai', label: 'OpenAI API' },
  { id: 'openrouter', kind: 'openrouter', label: 'OpenRouter' },
];

export const BUILT_IN_PROVIDER_IDS = BUILT_INS.map((p) => p.id);

/** How long a provider's model list is kept. */
export const MODEL_CACHE_MS = 5 * 60 * 1000;
/** How long a failed listing is remembered before it is tried again. */
const FAILED_LIST_CACHE_MS = 30 * 1000;

/** `setKey`/`deleteKey` refused: `not-found` (no such provider), `env` (its key comes from the environment), `invalid`. */
export class ProviderKeyError extends Error {
  readonly reason: 'not-found' | 'env' | 'invalid';
  constructor(reason: 'not-found' | 'env' | 'invalid', message: string) {
    super(message);
    this.reason = reason;
  }
}

export type ProviderRegistryOptions = {
  loadPreferences(): Promise<Preferences>;
  /** Where the built-ins' variables are read (the engine's environment). */
  env: NodeJS.ProcessEnv;
  credentials?: AgentCredentials;
  /** For the model lists (tests). */
  fetch?: typeof fetch;
  now?: () => number;
};

type CachedList = { key: string; at: number; ok: boolean; promise: Promise<ApiModelInfo[]> };

export class ProviderRegistry {
  readonly credentials: AgentCredentials;
  private readonly options: ProviderRegistryOptions;
  private readonly lists = new Map<string, CachedList>();
  /** Why a provider's last listing failed, when its key was refused (shown as the status's problem). */
  private readonly refused = new Map<string, string>();

  constructor(options: ProviderRegistryOptions) {
    this.options = options;
    this.credentials = options.credentials ?? new AgentCredentials();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Every provider, key resolved: the built-ins, then the custom entries in the user's order. */
  async resolveAll(): Promise<ResolvedProvider[]> {
    const prefs = await this.options.loadPreferences();
    const env = this.options.env;
    const out: ResolvedProvider[] = BUILT_INS.map((p) => {
      const key = this.credentials.resolve(p.id, env);
      return { ...p, builtIn: true, apiKey: key?.apiKey ?? null, keySource: key?.source ?? null, images: true };
    });
    for (const entry of customEntries(prefs)) {
      const stored = this.credentials.stored(entry.id);
      out.push({
        id: entry.id,
        kind: 'openai-compatible',
        label: entry.label,
        builtIn: false,
        baseURL: entry.baseURL,
        apiKey: stored,
        keySource: stored ? 'stored' : null,
        images: entry.images === true,
        ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
        ...(entry.models && entry.models.length > 0 ? { models: [...entry.models] } : {}),
      });
    }
    return out;
  }

  /** Provider `id`, key resolved; null when there is no such provider. */
  async resolve(id: string): Promise<ResolvedProvider | null> {
    return (await this.resolveAll()).find((p) => p.id === id) ?? null;
  }

  /** What Settings and the panel see (§20.3). */
  async statuses(): Promise<ApiProviderStatus[]> {
    return (await this.resolveAll()).map((p) => this.status(p));
  }

  private status(p: ResolvedProvider): ApiProviderStatus {
    const hasKey = p.apiKey !== null;
    const ready = p.builtIn ? hasKey : !!p.baseURL;
    const problem = p.builtIn && !hasKey ? 'No API key.' : hasKey ? this.refused.get(p.id) : undefined;
    return {
      id: p.id,
      kind: p.kind,
      label: p.label,
      builtIn: p.builtIn,
      ...(p.baseURL ? { baseURL: p.baseURL } : {}),
      hasKey,
      keySource: p.keySource,
      ...(p.apiKey !== null ? { keyPreview: keyPreview(p.apiKey) } : {}),
      ...(p.builtIn ? { envVar: AgentCredentials.envVar(p.id) } : {}),
      ready,
      images: p.images,
      ...(p.contextWindow !== undefined ? { contextWindow: p.contextWindow } : {}),
      ...(problem ? { problem } : {}),
    };
  }

  /** Whether provider `p` can be asked for anything. */
  static isReady(p: ResolvedProvider): boolean {
    return p.builtIn ? p.apiKey !== null : !!p.baseURL;
  }

  // ---------------------------------------------------------------------------
  // Models
  // ---------------------------------------------------------------------------

  /** The models of every ready provider, provider-qualified (§20.3). */
  async models(): Promise<AgentModel[]> {
    const providers = (await this.resolveAll()).filter(ProviderRegistry.isReady);
    const lists = await Promise.all(providers.map(async (p) => ({ p, models: await this.providerModels(p) })));
    const out: AgentModel[] = [];
    for (const { p, models } of lists) {
      const suggested = SUGGESTED_MODELS[p.kind];
      for (const m of models) {
        out.push({
          id: `${p.id}/${m.id}`,
          label: m.label ?? m.id,
          provider: p.id,
          ...(m.efforts && m.efforts.length > 0 ? { efforts: [...m.efforts] } : {}),
          ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}),
          acceptsImages: m.acceptsImages,
          ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
          ...(p.builtIn && suggested === m.id ? { isDefault: true } : {}),
        });
      }
    }
    return out;
  }

  /**
   * The models of provider `p`: its list, cached for a few minutes. A list
   * that fails gives the suggested default (Anthropic) or the entry's own
   * `models`, else nothing; a refused key is remembered for the status.
   */
  async providerModels(p: ResolvedProvider): Promise<ApiModelInfo[]> {
    const key = cacheKey(p);
    const cached = this.lists.get(p.id);
    const age = cached ? this.now() - cached.at : Infinity;
    let listed: ApiModelInfo[] | null;
    if (cached && cached.key === key && age < (cached.ok ? MODEL_CACHE_MS : FAILED_LIST_CACHE_MS)) {
      listed = await cached.promise.catch((): null => null);
    } else {
      const entry: CachedList = { key, at: this.now(), ok: true, promise: listModels({ kind: p.kind, baseURL: p.baseURL, apiKey: p.apiKey, images: p.images }, this.options.fetch) };
      this.lists.set(p.id, entry);
      listed = await entry.promise.then(
        (models): ApiModelInfo[] => {
          this.refused.delete(p.id);
          return models;
        },
        (e): null => {
          entry.ok = false;
          if (e instanceof ModelListError && (e.status === 401 || e.status === 403)) {
            this.refused.set(p.id, `The API key was refused (HTTP ${e.status}).`);
          } else {
            this.refused.delete(p.id);
          }
          return null;
        },
      );
    }
    const fallback = (): ApiModelInfo[] => {
      const suggested = SUGGESTED_MODELS[p.kind];
      if (p.builtIn) {
        return suggested ? [{ id: suggested, acceptsImages: true }] : [];
      }
      return (p.models ?? []).map((id) => ({ id, acceptsImages: p.images }));
    };
    if (!listed) {
      return fallback();
    }
    // A custom entry's own names come along when its server does not list them.
    const extra = p.builtIn ? [] : (p.models ?? []).filter((id) => !listed!.some((m) => m.id === id)).map((id) => ({ id, acceptsImages: p.images }));
    return [...listed, ...extra];
  }

  /**
   * What the driver knows of `model` on provider `p`: from the provider's
   * list when it is there, else assumed (built-ins take images; custom
   * entries as configured).
   */
  async modelInfo(p: ResolvedProvider, model: string): Promise<ApiModelInfo> {
    const found = (await this.providerModels(p)).find((m) => m.id === model);
    if (found) {
      return found;
    }
    return { id: model, acceptsImages: p.builtIn ? true : p.images };
  }

  // ---------------------------------------------------------------------------
  // Keys
  // ---------------------------------------------------------------------------

  /** Stores a key for provider `id`. Refused for an unknown id, a key from the environment, or a bad key. */
  async setKey(id: string, apiKey: unknown): Promise<void> {
    const provider = await this.resolve(id);
    if (!provider) {
      throw new ProviderKeyError('not-found', `No such provider: ${id}`);
    }
    if (provider.keySource === 'env') {
      throw new ProviderKeyError('env', `The ${provider.label} key comes from ${AgentCredentials.envVar(id)}; unset it to use a stored key.`);
    }
    if (!AgentCredentials.isValidKey(apiKey)) {
      throw new ProviderKeyError('invalid', '`apiKey` must be one line of at most 512 printable characters.');
    }
    this.credentials.write(id, apiKey);
    this.clearCaches();
  }

  /** Forgets provider `id`'s stored key (the environment's, if any, still applies). */
  async deleteKey(id: string): Promise<void> {
    const provider = await this.resolve(id);
    if (!provider) {
      throw new ProviderKeyError('not-found', `No such provider: ${id}`);
    }
    this.credentials.delete(id);
    this.clearCaches();
  }

  /** Forgets every model list (a key changed). */
  clearCaches(): void {
    this.lists.clear();
    this.refused.clear();
  }

  /** The provider of a provider-qualified model, ready, with its key; TurnFailure otherwise. */
  async forModel(providerId: string): Promise<ResolvedProvider> {
    const provider = await this.resolve(providerId);
    if (!provider) {
      throw new TurnFailure({ kind: 'other', message: `There is no model provider "${providerId}". Pick a model in the chat, or add the provider in Settings → Agent.` });
    }
    if (!ProviderRegistry.isReady(provider)) {
      throw new TurnFailure({ kind: 'auth', message: `${provider.label} has no API key. Add one in Settings → Agent.` });
    }
    return provider;
  }
}

/** The custom entries of `prefs`, built-in ids left out whatever the file says. */
function customEntries(prefs: Preferences): AgentProviderConfig[] {
  const entries = Array.isArray(prefs.agent?.providers) ? prefs.agent!.providers! : [];
  return entries.filter((e) => e && typeof e.id === 'string' && !BUILT_IN_PROVIDER_IDS.includes(e.id) && typeof e.baseURL === 'string');
}

/** What a cached list depends on; the key only through a short digest. */
function cacheKey(p: ResolvedProvider): string {
  return JSON.stringify([p.kind, p.baseURL ?? null, p.images, p.models ?? null, p.keySource, p.apiKey ? digest(p.apiKey) : null]);
}

function digest(text: string): string {
  // FNV-1a: enough to tell keys apart in memory; never leaves the process.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * What the page may see of `key`: its first characters and "…", at most 10
 * and at most a quarter of the key, so a short key shows little of itself.
 */
export function keyPreview(key: string): string {
  return `${key.slice(0, Math.min(10, Math.floor(key.length / 4)))}…`;
}

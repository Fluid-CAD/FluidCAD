/**
 * Which hub the CLI and the engine talk to (hub-plan "FluidCAD code"). The
 * hub URL is never hard-coded anywhere else: it resolves, in order, from
 * `--hub <url>`, then `FLUIDCAD_HUB_URL`, then {@link HubConfig.DEFAULT_URL}.
 *
 * A hub is an origin: its pages and its API (`/api/v1`) share it, and
 * credentials are keyed by it, so a URL with a path, a query or a
 * fragment is refused rather than guessed at.
 */

export type HubConfigSource = 'flag' | 'env' | 'default';

export type HubConfigOptions = {
  /** `--hub <url>`, when given. */
  hub?: string | null;
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
};

export class HubConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HubConfigError';
  }
}

export class HubConfig {
  static readonly DEFAULT_URL = 'https://hub.fluidcad.io';
  static readonly ENV_URL = 'FLUIDCAD_HUB_URL';
  static readonly API_PATH = '/api/v1';

  /** `https://hub.fluidcad.io`, no trailing slash. */
  readonly origin: string;
  /** `https://hub.fluidcad.io/api/v1`. */
  readonly apiBase: string;
  /** Where {@link origin} came from. */
  readonly source: HubConfigSource;

  private constructor(origin: string, source: HubConfigSource) {
    this.origin = origin;
    this.apiBase = origin + HubConfig.API_PATH;
    this.source = source;
  }

  /** `--hub`, then `FLUIDCAD_HUB_URL`, then the default. Blank values count as unset. */
  static resolve(options: HubConfigOptions = {}): HubConfig {
    const env = options.env ?? process.env;
    const flag = options.hub?.trim();
    if (flag) {
      return new HubConfig(HubConfig.originOf(flag, '--hub'), 'flag');
    }
    const fromEnv = env[HubConfig.ENV_URL]?.trim();
    if (fromEnv) {
      return new HubConfig(HubConfig.originOf(fromEnv, HubConfig.ENV_URL), 'env');
    }
    return new HubConfig(HubConfig.DEFAULT_URL, 'default');
  }

  /** A hub page, e.g. `url('/cli/authorize')`. */
  url(pathname: string): string {
    return this.origin + HubConfig.leadingSlash(pathname);
  }

  /** An API route, e.g. `api('/me')` → `<origin>/api/v1/me`. */
  api(pathname: string): string {
    return pathname === '' || pathname === '/' ? this.apiBase : this.apiBase + HubConfig.leadingSlash(pathname);
  }

  /** The origin of an http(s) URL with trailing slashes trimmed; anything else is refused with a sentence naming `label`. */
  private static originOf(value: string, label: string): string {
    const trimmed = value.replace(/\/+$/, '');
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new HubConfigError(`${label} must be a URL like ${HubConfig.DEFAULT_URL}, not "${value}".`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new HubConfigError(`${label} must be an http or https URL, not "${value}".`);
    }
    if (url.username || url.password) {
      throw new HubConfigError(`${label} must not carry a user name or password.`);
    }
    if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
      throw new HubConfigError(`${label} is the hub's address alone, like ${url.origin}: drop "${url.pathname}${url.search}${url.hash}".`);
    }
    return url.origin;
  }

  private static leadingSlash(pathname: string): string {
    return pathname.startsWith('/') ? pathname : `/${pathname}`;
  }
}

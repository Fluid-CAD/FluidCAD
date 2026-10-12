import os from 'os';
import { readPackageVersion } from './workspace.js';

/**
 * Shared by `login`, `logout`, `whoami`, `publish`, `install`, `yank`, `unyank`, `deprecate` and `listing`: the compiled hub classes they
 * wrap, and how they talk to the terminal. The rules — which hub, which
 * token, the sign-in flow — live in the server's `server/src/hub/`, typed
 * and tested there; these commands are the terminal around them.
 */
export class HubCli {
  /** The server's hub classes, imported lazily: the rest of the CLI doesn't need them at startup. */
  static async load() {
    const [config, credentials, client, transport, login, error] = await Promise.all([
      import('../../server/dist/hub/hub-config.js'),
      import('../../server/dist/hub/hub-credentials.js'),
      import('../../server/dist/hub/hub-client.js'),
      import('../../server/dist/hub/hub-transport.js'),
      import('../../server/dist/hub/hub-login.js'),
      import('../../server/dist/hub/hub-request-error.js'),
    ]);
    return {
      HubConfig: config.HubConfig,
      HubConfigError: config.HubConfigError,
      HubCredentials: credentials.HubCredentials,
      HubClient: client.HubClient,
      HubTransport: transport.HubTransport,
      HubLogin: login.HubLogin,
      HubLoginError: login.HubLoginError,
      HubRequestError: error.HubRequestError,
    };
  }

  /**
   * {@link load}, plus what `publish` needs: `HubPublisher` and its error,
   * and the packer. Separate because the packer pulls in the engine.
   */
  static async loadPublisher() {
    const [hub, publisher, publishError, builder] = await Promise.all([
      HubCli.load(),
      import('../../server/dist/hub/hub-publisher.js'),
      import('../../server/dist/hub/hub-publish-error.js'),
      import('../../server/dist/packages/package-builder.js'),
    ]);
    return {
      ...hub,
      HubPublisher: publisher.HubPublisher,
      HubPublishError: publishError.HubPublishError,
      packPackage: builder.packPackage,
      PackageBuildError: builder.PackageBuildError,
    };
  }

  /**
   * {@link load}, plus what `yank`, `unyank`, `deprecate` and `listing`
   * need (H12): `HubMaintainer` and its error. No packer: these commands
   * never boot the engine.
   */
  static async loadMaintainer() {
    const [hub, maintainer, maintainError] = await Promise.all([
      HubCli.load(),
      import('../../server/dist/hub/hub-maintainer.js'),
      import('../../server/dist/hub/hub-maintain-error.js'),
    ]);
    return { ...hub, HubMaintainer: maintainer.HubMaintainer, HubMaintainError: maintainError.HubMaintainError };
  }

  /** How long `package init` waits for `GET /me` when the stored credential names no handle. */
  static HANDLE_TIMEOUT_MS = 5000;

  /** This FluidCAD's version. */
  static version() {
    return readPackageVersion();
  }

  /**
   * The handle this machine is signed in to the hub as (`--hub`, then
   * `FLUIDCAD_HUB_URL`, then the default), for `package init` (HD30): the
   * stored credential's, with no network; only a token that names none (a
   * `FLUIDCAD_HUB_TOKEN`, or credentials written before a handle was
   * claimed) asks `GET /me`, with a short timeout. `{ handle, origin }`, or
   * null when signed out; any failure counts as signed out, never as an
   * error.
   */
  static async signedInHandle(opts) {
    try {
      const mods = await HubCli.load();
      const config = mods.HubConfig.resolve({ hub: opts.hub });
      const credential = mods.HubCredentials.read(config.origin);
      if (!credential) {
        return null;
      }
      if (credential.handle) {
        return { handle: credential.handle, origin: config.origin };
      }
      const transport = new mods.HubTransport({ version: HubCli.version(), client: 'cli', timeoutMs: HubCli.HANDLE_TIMEOUT_MS });
      const me = await new mods.HubClient(config, transport, credential.token).me();
      return me.account.handle ? { handle: me.account.handle, origin: config.origin } : null;
    } catch {
      return null;
    }
  }

  /** A client for `config`'s hub, sending `token`. */
  static client(mods, config, token = null) {
    return new mods.HubClient(config, new mods.HubTransport({ version: HubCli.version(), client: 'cli' }), token);
  }

  /** `--hub`, then `FLUIDCAD_HUB_URL`, then the default; a bad URL is printed and exits 1. */
  static config(mods, opts) {
    try {
      return mods.HubConfig.resolve({ hub: opts.hub });
    } catch (err) {
      HubCli.exitOnRefusal(err, mods);
    }
  }

  /** `@acme (acme@example.com)`, or the email alone when there is no handle. */
  static who(handle, email) {
    if (handle) {
      return email ? `@${handle} (${email})` : `@${handle}`;
    }
    return email ?? 'your account';
  }

  /** The path as the user knows it: the home directory as `~`. */
  static displayPath(file) {
    const home = os.homedir();
    if (home && (file === home || file.startsWith(home + '/') || file.startsWith(home + '\\'))) {
      return '~' + file.slice(home.length);
    }
    return file;
  }

  /** A refusal the hub classes word for the user: print it and exit 1. Anything else is rethrown. */
  static exitOnRefusal(err, mods) {
    const refusals = [mods.HubConfigError, mods.HubLoginError, mods.HubRequestError, mods.HubPublishError, mods.HubMaintainError].filter(Boolean);
    if (refusals.some((type) => err instanceof type)) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

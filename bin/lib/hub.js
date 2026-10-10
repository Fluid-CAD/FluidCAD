import os from 'os';
import { readPackageVersion } from './workspace.js';

/**
 * Shared by `login`, `logout` and `whoami`: the compiled hub classes they
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

  /** This FluidCAD's version. */
  static version() {
    return readPackageVersion();
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
    const refusals = [mods.HubConfigError, mods.HubLoginError, mods.HubRequestError];
    if (refusals.some((type) => err instanceof type)) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

import { HubCli } from '../lib/hub.js';
import { openBrowser } from '../lib/browser.js';

/**
 * `fluidcad login` (HD7): signs this machine in to the hub and saves the
 * token in `$FLUIDCAD_HOME/credentials.json`, keyed by the hub's origin.
 * - In a browser: loopback + PKCE (`HubLogin`).
 * - `--with-token`: reads a token from stdin (a personal token made on the
 *   web, or CI), checks it with `GET /me`, then saves it.
 */
async function runLogin(opts) {
  const mods = await HubCli.load();
  const config = HubCli.config(mods, opts);
  try {
    const signedIn = opts.withToken ? await loginWithToken(mods, config) : await loginInBrowser(mods, config);
    console.log(`✓ Signed in as ${HubCli.who(signedIn.handle, signedIn.email)} · saved to ${HubCli.displayPath(signedIn.path)}`);
    if (config.source !== 'default') {
      console.log(`  hub: ${config.origin}`);
    }
    if (process.env[mods.HubCredentials.ENV_TOKEN]) {
      console.log(`  ${mods.HubCredentials.ENV_TOKEN} is set, and it wins over the saved token while it is.`);
    }
  } catch (err) {
    HubCli.exitOnRefusal(err, mods);
  }
}

function loginInBrowser(mods, config) {
  return mods.HubLogin.run({
    config,
    openBrowser,
    print: (line) => console.log(line),
    version: HubCli.version(),
  });
}

async function loginWithToken(mods, config) {
  if (process.stdin.isTTY) {
    console.error('Paste the token, then press Enter and Ctrl+D:');
  }
  const token = (await readStdin()).trim();
  if (!token) {
    console.error('No token on stdin. Pipe one in: `fluidcad login --with-token < token.txt`.');
    process.exit(1);
  }
  let me;
  try {
    me = await HubCli.client(mods, config, token).me();
  } catch (err) {
    if (err instanceof mods.HubRequestError && err.unauthorized) {
      console.error(`${config.origin} doesn't accept that token (revoked, expired or mistyped). Nothing was saved.`);
      process.exit(1);
    }
    throw err;
  }
  const entry = { token, tokenId: me.token?.id ?? null, handle: me.account.handle, email: me.account.email };
  const path = mods.HubCredentials.write(config.origin, entry);
  return { handle: entry.handle, email: entry.email, path };
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

export function registerLoginCommand(program) {
  program
    .command('login')
    .description('Sign this machine in to the FluidCAD hub')
    .option('--hub <url>', 'Hub URL (default: $FLUIDCAD_HUB_URL or https://hub.fluidcad.io)')
    .option('--with-token', 'Read an API token from stdin instead of signing in through the browser')
    .action((opts) => {
      runLogin(opts)
        // The loopback server and the keep-alive sockets are closed; exit
        // anyway so nothing left in the event loop holds the terminal.
        .then(() => process.exit(0))
        .catch((err) => {
          console.error(err?.message ?? err);
          process.exit(1);
        });
    });
}

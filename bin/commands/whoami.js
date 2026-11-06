import { HubCli } from '../lib/hub.js';

/**
 * `fluidcad whoami`: who this machine is signed in to the hub as, asked of
 * the hub itself (`GET /me`, whose `token` field says which kind of token
 * this is). Exits 1 when signed out, or when the hub refuses the token.
 */
async function runWhoami(opts) {
  const mods = await HubCli.load();
  const config = HubCli.config(mods, opts);
  const credential = mods.HubCredentials.read(config.origin);
  if (!credential) {
    console.error(`Not signed in to ${config.origin}. Run \`fluidcad login\`${config.source === 'flag' ? ` --hub ${config.origin}` : ''}.`);
    process.exit(1);
  }
  const from = credential.source === 'env' ? mods.HubCredentials.ENV_TOKEN : HubCli.displayPath(mods.HubCredentials.path());

  let me;
  try {
    me = await HubCli.client(mods, config, credential.token).me();
  } catch (err) {
    if (err instanceof mods.HubRequestError && err.unauthorized) {
      console.error(`${config.origin} no longer accepts the token from ${from} (revoked or expired). Run \`fluidcad login\`.`);
      process.exit(1);
    }
    HubCli.exitOnRefusal(err, mods);
  }

  console.log(HubCli.who(me.account.handle, me.account.email));
  console.log(`  hub:   ${config.origin}`);
  const token = me.token;
  const kind = token ? `${token.kind} token …${token.suffix}${token.scopes.length ? ` (${token.scopes.join(', ')})` : ''}` : 'unknown';
  console.log(`  token: ${kind}, from ${from}`);
}

export function registerWhoamiCommand(program) {
  program
    .command('whoami')
    .description('Show who this machine is signed in to the FluidCAD hub as')
    .option('--hub <url>', 'Hub URL (default: $FLUIDCAD_HUB_URL or https://hub.fluidcad.io)')
    .action((opts) => {
      runWhoami(opts)
        .then(() => process.exit(0))
        .catch((err) => {
          console.error(err?.message ?? err);
          process.exit(1);
        });
    });
}

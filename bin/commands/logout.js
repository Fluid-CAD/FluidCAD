import { HubCli } from '../lib/hub.js';

/**
 * `fluidcad logout` (HD8): revokes this machine's token on the hub, then
 * forgets it locally (`HubLogout`, which the Hub panel's Sign out runs
 * too). A token the hub already refuses (401) is simply forgotten. When the
 * hub can't be reached, the token is still forgotten here, and the command
 * says the hub still has it and exits 1.
 *
 * Only the saved token is signed out: `FLUIDCAD_HUB_TOKEN` belongs to
 * whoever set it, so it is never revoked here, only mentioned.
 */
async function runLogout(opts) {
  const mods = await HubCli.load();
  const config = HubCli.config(mods, opts);
  const result = await mods.HubLogout.run({ config, client: HubCli.client(mods, config) });
  const envNote = () => {
    if (result.envToken) {
      console.log(`  ${mods.HubCredentials.ENV_TOKEN} is still set; unset it to stop using that token.`);
    }
  };

  if (result.outcome === 'not-signed-in') {
    console.log(`Not signed in to ${config.origin}.`);
    envNote();
    return;
  }

  const who = HubCli.who(result.handle, result.email);
  if (result.outcome === 'not-revoked') {
    console.error(`Signed ${who} out on this machine, but ${config.origin} couldn't revoke the token: ${result.reason}`);
    console.error('The token stays valid on the hub until it is revoked there or goes unused for a year.');
    envNote();
    process.exit(1);
  }
  console.log(`✓ Signed ${who} out of ${config.origin} · ${result.outcome === 'already-revoked' ? 'the token was already revoked' : 'the token is revoked'}`);
  envNote();
}

export function registerLogoutCommand(program) {
  program
    .command('logout')
    .description('Revoke this machine\'s hub token and forget it')
    .option('--hub <url>', 'Hub URL (default: $FLUIDCAD_HUB_URL or https://hub.fluidcad.io)')
    .action((opts) => {
      runLogout(opts)
        .then(() => process.exit(0))
        .catch((err) => {
          console.error(err?.message ?? err);
          process.exit(1);
        });
    });
}

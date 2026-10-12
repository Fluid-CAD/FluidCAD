import { HubMaintainCli } from '../lib/hub-maintain.js';

/**
 * `fluidcad yank @scope/name@version --reason <text>` and `fluidcad unyank
 * @scope/name@version` (H12, HD11): the owner takes a published version out
 * of latest, search and installs by name, or brings it back. A project that
 * pins a yanked version keeps installing it by its exact version, and its
 * bytes never change. In the package's workspace the version alone is
 * enough (`fluidcad yank 0.2.0 --reason …`). The rules live in the server's
 * `HubMaintainer`; this is the terminal around it.
 */
class YankCli {
  static async yank(spec, opts) {
    await HubMaintainCli.run(opts, async (maintainer, { mods, hub, workspace }) => {
      const ref = mods.HubMaintainer.versionRef(spec, workspace);
      const result = await maintainer.yank(ref, opts.reason ?? '');
      const at = `${ref.name}@${ref.version}`;
      console.log(`✓ Yanked ${at} on ${hub}: ${HubMaintainCli.quoted(result.yanked?.reason ?? '')}`);
      if (result.latestVersion) {
        console.log(`  Installs by name now get ${result.latestVersion}; \`fluidcad install ${at}\` still installs ${ref.version}.`);
      } else {
        console.log(`  No version is left for an install by name, so ${ref.name} leaves search; its page and \`fluidcad install ${at}\` still work.`);
      }
      console.log(`  \`fluidcad unyank ${at}\` brings it back.`);
    });
  }

  static async unyank(spec, opts) {
    await HubMaintainCli.run(opts, async (maintainer, { mods, hub, workspace }) => {
      const ref = mods.HubMaintainer.versionRef(spec, workspace);
      const result = await maintainer.unyank(ref);
      console.log(`✓ Unyanked ${ref.name}@${ref.version} on ${hub}.`);
      if (result.isLatest) {
        console.log(`  It is the latest again: installs by name get ${ref.version}.`);
      } else if (result.latestVersion) {
        console.log(`  Installs by name get ${result.latestVersion}, the latest.`);
      }
    });
  }
}

export function registerYankCommands(program) {
  program
    .command('yank')
    .description('Take a published version out of latest, search and installs by name (exact installs keep working)')
    .argument('<version>', '@scope/name@version, or the version alone in the package\'s workspace')
    .requiredOption('--reason <text>', 'Why, shown as "Yanked: <reason>" beside the version (at most 280 characters)')
    .option('-w, --workspace <path>', 'Workspace directory (defaults to cwd)')
    .option('--hub <url>', 'Hub URL (default: $FLUIDCAD_HUB_URL or https://hub.fluidcad.io)')
    .action(HubMaintainCli.action((spec, opts) => YankCli.yank(spec, opts)));

  program
    .command('unyank')
    .description('Bring a yanked version back to latest, search and installs by name')
    .argument('<version>', '@scope/name@version, or the version alone in the package\'s workspace')
    .option('-w, --workspace <path>', 'Workspace directory (defaults to cwd)')
    .option('--hub <url>', 'Hub URL (default: $FLUIDCAD_HUB_URL or https://hub.fluidcad.io)')
    .action(HubMaintainCli.action((spec, opts) => YankCli.unyank(spec, opts)));
}

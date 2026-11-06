import { HubMaintainCli } from '../lib/hub-maintain.js';

/**
 * `fluidcad deprecate [@scope/name] [message] [--clear]` (H12): the owner
 * deprecates a package with a message (what to use instead, or why), or
 * clears it. The package stays listed and installable; search, its page,
 * FluidCAD's Hub panel and `fluidcad install` show the message. Without a
 * name, the workspace's package; the first word is the name only when it
 * is a package name (a message has spaces). The rules live in the server's
 * `HubMaintainer`; this is the terminal around it.
 */
class DeprecateCli {
  static async run(first, rest, opts) {
    await HubMaintainCli.run(opts, async (maintainer, { mods, hub, workspace }) => {
      const named = first !== undefined && /^@[^\s/]+\/[^\s]+$/.test(first);
      const name = mods.HubMaintainer.packageName(named ? first : null, workspace);
      const words = [...(named || first === undefined ? [] : [first]), ...rest];
      if (opts.clear && words.length > 0) {
        throw new mods.HubMaintainError('bad-request', 'Pass a message or --clear, not both.');
      }
      if (!opts.clear && words.length === 0) {
        throw new mods.HubMaintainError('bad-request', `Write the message (what to use instead, or why), such as \`fluidcad deprecate ${name} "Use @acme/other instead."\`, or pass --clear.`);
      }
      const listing = await maintainer.deprecate(name, opts.clear ? null : words.join(' '));
      if (listing.deprecatedMessage) {
        console.log(`✓ Deprecated ${name} on ${hub}: ${HubMaintainCli.quoted(listing.deprecatedMessage)}`);
        console.log('  It stays installable; search, its page, FluidCAD\'s Hub panel and `fluidcad install` show the message.');
      } else {
        console.log(`✓ ${name} is no longer deprecated on ${hub}.`);
      }
    });
  }
}

export function registerDeprecateCommand(program) {
  program
    .command('deprecate')
    .description('Deprecate a package with a message (it stays installable), or clear it with --clear')
    .argument('[name]', '@scope/name (defaults to the workspace\'s package)')
    .argument('[message...]', 'What to use instead, or why (at most 280 characters)')
    .option('--clear', 'Clear the deprecation')
    .option('-w, --workspace <path>', 'Workspace directory (defaults to cwd)')
    .option('--hub <url>', 'Hub URL (default: $FLUIDCAD_HUB_URL or https://hub.fluidcad.io)')
    .action(HubMaintainCli.action((first, rest, opts) => DeprecateCli.run(first, rest ?? [], opts)));
}

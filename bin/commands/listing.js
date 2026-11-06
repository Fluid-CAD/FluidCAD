import { HubMaintainCli } from '../lib/hub-maintain.js';

/**
 * `fluidcad listing …` (H12, HD28): after the first publish, the owner
 * changes what the first-publish wizard set, from the terminal; the hub's
 * Manage page does the same in the browser.
 * - `listing show`: the license, links, deprecation, open version and
 *   screenshots;
 * - `listing screenshots list | add <file…> | remove <id> | order <id…> |
 *   card <id>`: a screenshot is named by its id, the start of its id, or its
 *   number in `list`;
 * - `listing set --license <spdx> --homepage <url> --repository <url>`: the
 *   license is the hub's list's (the hub says which), and goes on the open
 *   version too, which is approved under it; an empty link clears it;
 * - `listing notes <text>`: the open version's release notes.
 * The package is `--package @scope/name`, else the workspace's. The rules
 * live in the server's `HubMaintainer`; this is the terminal around it.
 */
class ListingCli {
  static async show(opts) {
    await HubMaintainCli.run(opts, async (maintainer, { mods, workspace }) => {
      const name = mods.HubMaintainer.packageName(opts.package, workspace);
      const { listing, open, latestVersion } = await maintainer.listing(name);
      console.log(`${name}${latestVersion ? ` · latest ${latestVersion}` : ' · nothing published'}`);
      console.log(`  license     ${listing.license ?? 'none'}`);
      console.log(`  homepage    ${listing.homepageUrl ?? 'none'}`);
      console.log(`  repository  ${listing.repositoryUrl ?? 'none'}`);
      console.log(`  deprecated  ${listing.deprecatedMessage ? HubMaintainCli.quoted(listing.deprecatedMessage) : 'no'}`);
      if (open) {
        const state = open.status === 'draft' ? 'a draft' : 'in review';
        console.log(`  ${open.version} is ${state}: license ${open.license ?? 'none'}, notes ${open.notes ? HubMaintainCli.quoted(open.notes) : 'none'}`);
      }
      console.log(`  screenshots ${listing.media.length} (\`fluidcad listing screenshots list\`)`);
    });
  }

  static async list(opts) {
    await HubMaintainCli.run(opts, async (maintainer, { mods, workspace }) => {
      const name = mods.HubMaintainer.packageName(opts.package, workspace);
      ListingCli.printMedia(name, (await maintainer.screenshots(name)).media);
    });
  }

  static async add(files, opts) {
    await HubMaintainCli.run(opts, async (maintainer, { mods, workspace }) => {
      const name = mods.HubMaintainer.packageName(opts.package, workspace);
      const added = await maintainer.addScreenshots(name, files, { caption: opts.caption });
      for (const media of added) {
        console.log(`✓ Added ${ListingCli.label(media)} as number ${media.position + 1}${media.isCard ? ', the card image' : ''}.`);
      }
    });
  }

  static async remove(ref, opts) {
    await HubMaintainCli.run(opts, async (maintainer, { mods, workspace }) => {
      const name = mods.HubMaintainer.packageName(opts.package, workspace);
      const removed = await maintainer.removeScreenshot(name, ref);
      console.log(`✓ Removed ${ListingCli.label(removed)} from ${name}.`);
    });
  }

  static async order(refs, opts) {
    await HubMaintainCli.run(opts, async (maintainer, { mods, workspace }) => {
      const name = mods.HubMaintainer.packageName(opts.package, workspace);
      const list = await maintainer.orderScreenshots(name, refs);
      console.log(`✓ ${name}'s screenshots, in their new order:`);
      ListingCli.printMedia(name, list.media);
    });
  }

  static async card(ref, opts) {
    await HubMaintainCli.run(opts, async (maintainer, { mods, workspace }) => {
      const name = mods.HubMaintainer.packageName(opts.package, workspace);
      const media = await maintainer.cardScreenshot(name, ref);
      console.log(`✓ ${ListingCli.label(media)} is ${name}'s card image: search and FluidCAD's Hub panel show it.`);
    });
  }

  static async set(opts) {
    await HubMaintainCli.run(opts, async (maintainer, { mods, workspace }) => {
      const name = mods.HubMaintainer.packageName(opts.package, workspace);
      const link = (value) => (value === undefined ? undefined : value.trim() === '' ? null : value.trim());
      const { listing, openVersion } = await maintainer.setListing(name, {
        license: opts.license,
        homepageUrl: link(opts.homepage),
        repositoryUrl: link(opts.repository),
      });
      console.log(`✓ Saved ${name}'s listing:`);
      if (opts.license !== undefined) {
        const also = openVersion ? `, and ${openVersion.version} (${openVersion.status === 'draft' ? 'a draft' : 'in review'}), which is approved under it` : '';
        console.log(`  license     ${listing.license}${also}`);
      }
      if (opts.homepage !== undefined) {
        console.log(`  homepage    ${listing.homepageUrl ?? 'none'}`);
      }
      if (opts.repository !== undefined) {
        console.log(`  repository  ${listing.repositoryUrl ?? 'none'}`);
      }
    });
  }

  static async notes(words, opts) {
    await HubMaintainCli.run(opts, async (maintainer, { mods, workspace }) => {
      const name = mods.HubMaintainer.packageName(opts.package, workspace);
      const version = await maintainer.notes(name, words.join(' '));
      const state = version.status === 'draft' ? 'a draft' : 'in review';
      console.log(`✓ Saved the release notes of ${name}@${version.version} (${state}): ${version.notes ? HubMaintainCli.quoted(version.notes) : 'none'}`);
    });
  }

  /** One numbered line per screenshot, with the id the other commands take. */
  static printMedia(name, media) {
    if (media.length === 0) {
      console.log(`${name} has no screenshots. \`fluidcad listing screenshots add <file…>\` adds some.`);
      return;
    }
    for (const item of media) {
      const facts = [ListingCli.label(item), `${item.width} × ${item.height}`, HubMaintainCli.size(item.bytes)];
      if (item.isCard) {
        facts.push('card image');
      }
      if (item.caption) {
        facts.push(HubMaintainCli.quoted(item.caption));
      }
      console.log(`${String(item.position + 1).padStart(2)}. ${item.id}  ${facts.join(' · ')}`);
    }
  }

  /** What a screenshot is called: its file name, the model it was captured from, or its number. */
  static label(media) {
    if (media.fileName) {
      return media.fileName;
    }
    if (media.modelModule) {
      return `a capture of ${media.modelModule}`;
    }
    return `screenshot ${media.position + 1}`;
  }
}

export function registerListingCommand(program) {
  const common = (command) =>
    command
      .option('-p, --package <name>', '@scope/name (defaults to the workspace\'s package)')
      .option('-w, --workspace <path>', 'Workspace directory (defaults to cwd)')
      .option('--hub <url>', 'Hub URL (default: $FLUIDCAD_HUB_URL or https://hub.fluidcad.io)');

  const listing = program
    .command('listing')
    .description("Change a published package's listing on the hub: screenshots, license, links, release notes");

  common(listing.command('show').description('Show the license, links, deprecation, open version and screenshots'))
    .action(HubMaintainCli.action((opts) => ListingCli.show(opts)));

  const screenshots = listing.command('screenshots').description('List, add, remove, order the screenshots, or pick the card image');
  common(screenshots.command('list').description('List the screenshots with their ids, in order'))
    .action(HubMaintainCli.action((opts) => ListingCli.list(opts)));
  common(screenshots.command('add').description('Add PNG, JPEG or WebP images (up to 2 MB and 4096 px a side, 12 per package)').argument('<files...>', 'Image files'))
    .option('--caption <text>', 'A caption for each (at most 140 characters)')
    .action(HubMaintainCli.action((files, opts) => ListingCli.add(files, opts)));
  common(screenshots.command('remove').description('Delete a screenshot').argument('<id>', 'Its id, the start of its id, or its number in `list`'))
    .action(HubMaintainCli.action((ref, opts) => ListingCli.remove(ref, opts)));
  common(screenshots.command('order').description('Put screenshots first, in this order (the rest follow)').argument('<ids...>', 'Ids, starts of ids, or numbers in `list`'))
    .action(HubMaintainCli.action((refs, opts) => ListingCli.order(refs, opts)));
  common(screenshots.command('card').description('Make a screenshot the card image (search and the Hub panel show it)').argument('<id>', 'Its id, the start of its id, or its number in `list`'))
    .action(HubMaintainCli.action((ref, opts) => ListingCli.card(ref, opts)));

  common(listing.command('set').description('Set the license (from the hub\'s list) and the https links; an empty link clears it'))
    .option('--license <spdx>', 'An SPDX id from the hub\'s list, such as MIT; the open version takes it too')
    .option('--homepage <url>', 'An https link, or "" to clear it')
    .option('--repository <url>', 'An https link, or "" to clear it')
    .action(HubMaintainCli.action((opts) => ListingCli.set(opts)));

  common(listing.command('notes').description("Set the open version's release notes (at most 280 characters)").argument('<text...>', 'The notes'))
    .action(HubMaintainCli.action((words, opts) => ListingCli.notes(words, opts)));
}

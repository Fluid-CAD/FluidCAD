import { HubCli } from '../lib/hub.js';
import { loadPackages } from '../lib/packages.js';

/**
 * `fluidcad search [terms…]`: packages on the hub (hub-plan H10, from the
 * user's search design of 2026-10-11), with what this machine already has
 * of each. The rules live in the server's `HubBridge` and `HubSearchQuery`
 * (the engine's `/api/hub/search` answers the same), the output in
 * `HubSearchText`; this is the terminal around them.
 *
 * It always sends this FluidCAD's version and feature SDK, and lists every
 * package (H11 decision 2): one this FluidCAD can't run is marked with why
 * (`requires FluidCAD X+`). No sort or direction is sent unless asked for:
 * the hub picks (best match with terms, most installed without, each in
 * its own direction). `@handle` among the terms keeps to one publisher.
 */
class SearchCli {
  static async load() {
    const [hub, packages, bridge, query, text] = await Promise.all([
      HubCli.load(),
      loadPackages(),
      import('../../server/dist/hub/hub-bridge.js'),
      import('../../server/dist/hub/hub-search-query.js'),
      import('../../server/dist/hub/hub-search-text.js'),
    ]);
    return {
      ...hub,
      ...packages,
      HubBridge: bridge.HubBridge,
      HubBridgeError: bridge.HubBridgeError,
      HubSearchQuery: query.HubSearchQuery,
      HubSearchText: text.HubSearchText,
    };
  }

  static async run(terms, opts) {
    const mods = await SearchCli.load();
    const config = HubCli.config(mods, opts);
    const cwd = process.cwd();
    const bridge = new mods.HubBridge({
      hub: config.origin,
      project: mods.PackagePins.isProject(cwd) ? cwd : null,
      engineVersion: HubCli.version(),
      client: 'cli',
    });
    const query = mods.HubSearchQuery.from({
      q: terms.join(' '),
      contents: SearchCli.commaList(opts.contents),
      keyword: opts.keyword ?? [],
      units: opts.units ? [opts.units] : [],
      license: opts.license ?? [],
      sort: opts.sort ?? null,
      order: opts.order ?? null,
      page: opts.page ?? null,
      limit: opts.limit ?? null,
    });
    let answer;
    try {
      answer = await bridge.search(query);
    } catch (err) {
      SearchCli.exitOnRefusal(err, mods);
    }
    if (opts.json) {
      console.log(JSON.stringify(answer, null, 2));
      return;
    }
    for (const line of mods.HubSearchText.lines(answer)) {
      console.log(line);
    }
  }

  /** `features,parts` → `['features', 'parts']`. */
  static commaList(value) {
    return (value ?? '').split(',').map((part) => part.trim()).filter((part) => part !== '');
  }

  /** `--keyword` and `--license` repeat. */
  static collect(value, previous) {
    return [...(previous ?? []), value];
  }

  /** The hub's refusal or no answer at all, worded for the terminal: print it and exit 1. */
  static exitOnRefusal(err, mods) {
    if (err instanceof mods.HubRequestError) {
      if (err.unreachable || err.status >= 500) {
        console.error(`${err.message} Nothing was searched: check the connection (or --hub) and try again.`);
      } else {
        console.error(err.sentence);
      }
      process.exit(1);
    }
    HubCli.exitOnRefusal(err, mods);
  }
}

export function registerSearchCommand(program) {
  program
    .command('search')
    .description("Search the FluidCAD hub for packages; ones this FluidCAD can't run are marked with why")
    .argument('[terms...]', 'Words to match (name, features, parts, keywords, description); @handle keeps to one publisher')
    .option('--contents <list>', 'Packages holding any of: features, parts, assemblies (comma list)')
    .option('--keyword <word>', 'Packages with this keyword (repeat for any of several)', SearchCli.collect)
    .option('--units <system>', 'metric or imperial')
    .option('--license <spdx>', 'Packages under this license, such as MIT or Apache-2.0 (repeat for any of several)', SearchCli.collect)
    .option('--sort <sort>', 'relevance, installs, likes, updated or newest (default: the hub picks)')
    .option('--order <direction>', "asc or desc (default: the sort's own; relevance has only one)")
    .option('--page <n>', 'Page number, from 1')
    .option('--limit <n>', 'Results per page (at most 50)')
    .option('--hub <url>', 'Hub URL (default: $FLUIDCAD_HUB_URL or https://hub.fluidcad.io)')
    .option('--json', "Print the engine's annotated answer as JSON")
    .action((terms, opts) => {
      SearchCli.run(terms ?? [], opts)
        .then(() => process.exit(0))
        .catch((err) => {
          console.error(err?.message ?? err);
          process.exit(1);
        });
    });
}

import { resolve } from 'path';
import { HubCli } from '../lib/hub.js';
import { openBrowser } from '../lib/browser.js';
import { confirm, isInteractive } from '../lib/prompt.js';

/**
 * `fluidcad publish` (HD10, HD26–HD28): packs this workspace's package and
 * uploads it to the hub in one command.
 * - A package's first version becomes a draft: the command opens the
 *   first-publish wizard in the browser (screenshots, license, release
 *   notes), which submits it for review.
 * - Later versions go straight to review, with `--notes`.
 * - `--status` shows where the package stands; `--withdraw` withdraws its
 *   draft or the version in review.
 *
 * The rules, the hub checks and their sentences live in the server's
 * `HubPublisher`; this is the terminal around it.
 */
async function runPublish(opts) {
  if (opts.status && opts.withdraw) {
    fail('Pass --status or --withdraw, not both.');
  }
  const mods = await HubCli.loadPublisher();
  const config = HubCli.config(mods, opts);
  const workspace = resolve(opts.workspace ?? process.cwd());
  const publisher = new mods.HubPublisher({
    config,
    credential: mods.HubCredentials.read(config.origin),
    version: HubCli.version(),
    pack: (inputs) => PublishView.quietly(() => mods.packPackage(inputs)),
  });
  try {
    const { name } = mods.HubPublisher.packageIn(workspace);
    if (opts.status) {
      PublishView.printStatus(await publisher.status(name), config);
    } else if (opts.withdraw) {
      await withdraw(publisher, name, opts);
    } else {
      await publish(publisher, workspace, opts);
    }
  } catch (err) {
    if (err instanceof mods.HubPublishError || err instanceof mods.PackageBuildError || err instanceof NotInteractive) {
      PublishView.endProgress();
      fail(err.message);
    }
    HubCli.exitOnRefusal(err, mods);
  }
}

async function publish(publisher, workspace, opts) {
  const result = await publisher.publish({
    workspacePath: workspace,
    notes: opts.notes ?? null,
    dryRun: Boolean(opts.dryRun),
    onProgress: (progress) => PublishView.progress(progress),
    confirm: async (summary) => {
      PublishView.endProgress();
      PublishView.printSummary(summary);
      return opts.yes ? true : ask('Upload it?');
    },
  });
  PublishView.endProgress();
  if (!result) {
    console.log('Nothing was uploaded.');
    return;
  }
  const { summary, upload } = result;
  const at = `${upload.name}@${upload.version}`;
  if (upload.dryRun) {
    // No confirmation was asked, so the summary comes now.
    PublishView.printSummary(summary);
  }
  if (upload.dryRun) {
    const next = upload.status === 'draft' ? 'a draft you finish in your browser' : 'submitted for review';
    console.log(`✓ Dry run: ${config(publisher)} accepts ${at} · ${upload.integrity} · it would be ${next}. Nothing was stored.`);
    return;
  }
  if (upload.replaced) {
    console.log(`  Replaced the draft of ${at}; the wizard keeps what you filled in.`);
  }
  if (upload.status === 'draft') {
    console.log(`✓ Uploaded ${at} · ${upload.integrity} · finish publishing in your browser: ${upload.wizardUrl}`);
    await openBrowser(upload.wizardUrl);
    return;
  }
  console.log(`✓ Submitted ${at} for review · ${upload.integrity} · ${upload.reviewUrl}`);
}

async function withdraw(publisher, name, opts) {
  const withdrawn = await publisher.withdraw(name, {
    confirm: (open) => {
      const state = open.status === 'draft' ? 'the draft' : 'in review';
      console.log(`${name}@${open.version} is ${state} on ${config(publisher)}. Withdrawing deletes it there; its number is free again.`);
      return opts.yes ? true : ask('Withdraw it?');
    },
  });
  if (!withdrawn) {
    console.log('Nothing was withdrawn.');
    return;
  }
  console.log(`✓ Withdrew ${name}@${withdrawn.version} from ${config(publisher)}.`);
}

function config(publisher) {
  return publisher.config.origin;
}

/** Thrown, not exited on, so the publisher still removes its scratch directory. */
class NotInteractive extends Error {}

/** A y/N question; without a terminal, `-y` is the only yes. */
async function ask(question) {
  if (!isInteractive()) {
    throw new NotInteractive('Pass -y to go ahead without being asked (this is not an interactive terminal). Nothing was sent.');
  }
  return confirm(question);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** How publishing reads in the terminal. */
class PublishView {
  static progressShown = false;

  /** One line that updates itself on a terminal; nothing but the steps elsewhere. */
  static progress(progress) {
    const tty = Boolean(process.stdout.isTTY);
    switch (progress.step) {
      case 'checking':
        return;
      case 'packing':
        PublishView.line('Packing…', tty);
        return;
      case 'uploading': {
        if (!tty) {
          if (progress.sent === 0) {
            PublishView.line(`Uploading ${PublishView.size(progress.total)}…`, false);
          }
          return;
        }
        const percent = progress.total === 0 ? 100 : Math.floor((progress.sent / progress.total) * 100);
        PublishView.line(`Uploading ${PublishView.size(progress.sent)} of ${PublishView.size(progress.total)} (${percent}%)`, true);
        return;
      }
      case 'verifying':
        PublishView.line('The hub is checking the archive…', tty);
        return;
    }
  }

  static line(text, tty) {
    if (tty) {
      process.stdout.write(`\r\x1b[2K${text}`);
      PublishView.progressShown = true;
    } else {
      process.stdout.write(`${text}\n`);
    }
  }

  /** Ends an updating line, so what comes next starts on its own. */
  static endProgress() {
    if (PublishView.progressShown) {
      process.stdout.write('\r\x1b[2K');
      PublishView.progressShown = false;
    }
  }

  /** What will be uploaded: the package, its folders, its hash, and what happens next. */
  static printSummary(summary) {
    const { contents } = summary;
    console.log(`${summary.dryRun ? 'Checking' : 'Publishing'} ${summary.name} ${summary.version} on ${summary.hub} as @${summary.handle}:`);
    const rows = [
      ['features/', PublishView.count(contents.features.length, 'feature')],
      ['parts/', PublishView.count(contents.parts.length, 'part')],
      ['assemblies/', PublishView.count(contents.assemblies.length, 'assembly', 'assemblies')],
    ];
    if (contents.docs?.length > 0) {
      rows.push(['docs/', PublishView.count(contents.docs.length, 'page')]);
    }
    for (const [folder, counted] of rows) {
      console.log(`  ${folder.padEnd(12)}${counted}`);
    }
    console.log(`  ${PublishView.count(summary.files, 'file')}, ${PublishView.size(summary.size)}`);
    console.log(`  integrity: ${summary.integrity}`);
    if (summary.notes) {
      console.log(`  notes: ${summary.notes}`);
    }
    if (summary.replacesDraft) {
      console.log(`  replaces the draft of ${summary.version} on the hub (the wizard keeps what you filled in)`);
    } else if (summary.becomes === 'draft') {
      console.log('  first version: you finish publishing in your browser (screenshots, license, release notes)');
    } else {
      console.log('  goes straight to review: an admin approves it before it is public');
    }
    PublishView.printWarnings(summary.warnings ?? []);
  }

  /** Pack's warnings, under the summary: they never stop the upload, and the hub doesn't repeat them. */
  static printWarnings(warnings) {
    if (warnings.length === 0) {
      return;
    }
    console.log(`  ${PublishView.count(warnings.length, 'warning')} (nothing is refused for them):`);
    for (const warning of warnings) {
      console.log(`    ! ${warning.message}`);
    }
  }

  /** `--status`: the open version, or the latest rejection, then the latest published version. */
  static printStatus(status, config) {
    const pkg = status.package;
    if (!pkg) {
      console.log(`${status.name} is not on ${config.origin} yet. \`fluidcad publish\` uploads its first version.`);
      return;
    }
    const open = pkg.openVersion;
    const rejected = pkg.rejectedVersion;
    if (open) {
      const at = `${status.name}@${open.version}`;
      if (open.status === 'draft') {
        console.log(`${at} is a draft · finish publishing in your browser: ${open.wizardUrl}`);
        if (open.draftExpiresAt) {
          console.log(`  a draft nobody touches is deleted on ${open.draftExpiresAt.slice(0, 10)}`);
        }
      } else if (open.status === 'in_review') {
        console.log(`${at} is in review${open.submittedAt ? ` since ${open.submittedAt.slice(0, 10)}` : ''} · ${open.reviewUrl}`);
      } else {
        console.log(`${at} is being uploaded.`);
      }
    } else if (rejected) {
      console.log(`${status.name}@${rejected.version} was rejected${rejected.reviewNote ? `: ${rejected.reviewNote}` : '.'}`);
      console.log('  Fix it, then `fluidcad publish` again (the same version number is free).');
    }
    if (status.latest) {
      const when = status.latest.publishedAt ? ` on ${status.latest.publishedAt.slice(0, 10)}` : '';
      console.log(`${open || rejected ? '  latest published' : `${status.name}: latest published`} ${status.latest.version}${when} · ${status.latest.integrity}`);
    } else if (!open && !rejected) {
      console.log(`${status.name} has no version on ${config.origin} yet. \`fluidcad publish\` uploads one.`);
    }
    if (pkg.status !== 'active') {
      console.log(`  the package is ${pkg.status} by the hub's admins`);
    }
  }

  static count(n, noun, plural = `${noun}s`) {
    return `${n} ${n === 1 ? noun : plural}`;
  }

  static size(bytes) {
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} kB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /** The engine narrates every scene it starts; the command's own lines are the output. */
  static async quietly(fn) {
    const { log, info, debug } = console;
    console.log = () => {};
    console.info = () => {};
    console.debug = () => {};
    try {
      return await fn();
    } finally {
      console.log = log;
      console.info = info;
      console.debug = debug;
    }
  }
}

export function registerPublishCommand(program) {
  program
    .command('publish')
    .description("Publish this workspace's package to the FluidCAD hub (the first version finishes in your browser)")
    .option('-w, --workspace <path>', 'Workspace directory (defaults to cwd)')
    .option('--notes <text>', 'Release notes (at most 280 characters); else the CHANGELOG section for the version')
    .option('--dry-run', 'Let the hub check everything without storing anything')
    .option('--status', 'Show where the package stands on the hub')
    .option('--withdraw', 'Withdraw the draft or the version in review')
    .option('--hub <url>', 'Hub URL (default: $FLUIDCAD_HUB_URL or https://hub.fluidcad.io)')
    .option('-y, --yes', 'Go ahead without asking')
    .action((opts) => {
      runPublish(opts)
        .then(() => process.exit(0))
        .catch((err) => {
          console.error(err?.message ?? err);
          process.exit(1);
        });
    });
}

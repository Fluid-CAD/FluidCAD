import { resolve } from 'path';
import { createInterface } from 'readline/promises';
import { isInteractive } from '../lib/prompt.js';

/**
 * `fluidcad package init`: make the workspace a package by writing the
 * `package` block of its fluidcad.json. The rules live in the server's
 * `PackageAuthoring`; this is the terminal around it.
 */
async function runPackageInit(opts) {
  // Imported lazily, like `pack`: the feature-module walk pulls in the
  // packer's dependencies, which the rest of the CLI doesn't need.
  const { PackageAuthoring, PackageAuthoringError } = await import('../../server/dist/packages/package-authoring.js');
  const { PackageName } = await import('../../server/dist/packages/package-name.js');

  const workspace = resolve(opts.workspace ?? process.cwd());
  const name = opts.name ?? (await askName(PackageName));

  try {
    const { info, configPath } = await PackageAuthoring.init(workspace, name);
    console.log(`Wrote the "package" block to ${configPath}:`);
    console.log(indent(JSON.stringify(info, null, 2)));
    if (info.exports.length === 0) {
      console.log('No feature modules found: add the *.feature.js, *.part.js or *.assembly.js modules to share to "exports".');
    } else {
      console.log('"exports" lists every feature module. Add *.part.js or *.assembly.js modules to share parts, or remove what stays private.');
    }
  } catch (err) {
    if (err instanceof PackageAuthoringError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

/** Ask for the name when `--name` wasn't given; without a terminal to ask on, say which flag to pass. */
async function askName(PackageName) {
  if (!isInteractive()) {
    console.error('Pass the package name with --name @scope/name.');
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('Package name (@scope/name): ')).trim();
    if (!PackageName.isValid(answer)) {
      console.error(`${JSON.stringify(answer)} is not a package name: ${PackageName.RULE}.`);
      process.exit(1);
    }
    return answer;
  } finally {
    rl.close();
  }
}

function indent(text) {
  return text.split('\n').map((line) => `  ${line}`).join('\n');
}

export function registerPackageCommand(program) {
  const pkg = program
    .command('package')
    .description('Make this workspace a package others can install');

  pkg
    .command('init')
    .description('Write the "package" block of fluidcad.json: the name, version 0.1.0, and every feature module as an export')
    .option('-w, --workspace <path>', 'Workspace directory (defaults to cwd)')
    .option('-n, --name <@scope/name>', 'Package name (asked for when omitted)')
    .action((opts) => {
      runPackageInit(opts).catch((err) => {
        console.error(err?.message ?? err);
        process.exit(1);
      });
    });
}

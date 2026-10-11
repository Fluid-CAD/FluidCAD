import { resolve } from 'path';
import { createInterface } from 'readline/promises';
import { HubCli } from '../lib/hub.js';
import { isInteractive } from '../lib/prompt.js';

/**
 * `fluidcad package init`: make the workspace a package by writing the
 * `package` block of its fluidcad.json. The rules live in the server's
 * `PackageAuthoring`; this is the terminal around it.
 *
 * The name is the package's one name, `@<handle>/<name>` (HD30). A name
 * without the scope (`--name feature-tests`, or a bare answer to the
 * prompt) takes the handle this machine is signed in to the hub as
 * (`HubCli.signedInHandle`), and the command says so; signed out, it is
 * refused with the sentence saying to add the scope.
 */
async function runPackageInit(opts) {
  // Imported lazily, like `pack`: the feature-module walk pulls in the
  // packer's dependencies, which the rest of the CLI doesn't need.
  const { PackageAuthoring, PackageAuthoringError } = await import('../../server/dist/packages/package-authoring.js');
  const { PackageLayout } = await import('../../server/dist/packages/package-manifest.js');
  const { PackageName } = await import('../../server/dist/packages/package-name.js');

  const workspace = resolve(opts.workspace ?? process.cwd());
  const asked = opts.name ?? null;
  if (asked === null && !isInteractive()) {
    console.error('Pass the package name with --name, such as --name @acme/feature-tests.');
    process.exit(1);
  }

  try {
    // The handle is only needed for a name without its scope, or to ask for one.
    const signedIn = asked === null || !PackageName.isValid(asked) ? await HubCli.signedInHandle(opts) : null;
    const typed = asked ?? (await askName(signedIn?.handle ?? null));
    const name = PackageAuthoring.scopedName(typed, signedIn?.handle ?? null);
    const { info, configPath, exports } = await PackageAuthoring.init(workspace, name);
    if (name !== typed) {
      console.log(`Named it ${name}: your handle on ${signedIn.origin}.`);
    }
    console.log(`Wrote the "package" block to ${configPath}:`);
    console.log(indent(JSON.stringify(info, null, 2)));
    printLayout(PackageLayout, exports);
  } catch (err) {
    if (err instanceof PackageAuthoringError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

/**
 * Ask for the name when `--name` wasn't given. Signed in, the prompt shows
 * the handle (`Package name: @acme/`): a bare answer takes it, and an
 * `@x/y` answer is taken as typed. Signed out, it asks for the whole name.
 */
async function askName(handle) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const question = handle ? `Package name: @${handle}/` : 'Package name (@<your-handle>/<name>): ';
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * What `fluidcad pack` will export: the folders decide it. Says how many
 * modules each folder holds, or where to put them when none does.
 */
function printLayout(PackageLayout, exports) {
  if (exports.length === 0) {
    console.log(
      'Put the package\'s feature modules in features/, its parts in parts/ and its assemblies in assemblies/: ' +
        'pack exports what those folders hold.',
    );
    return;
  }
  const counts = PackageLayout.FOLDERS.map((folder) => {
    const n = exports.filter((rel) => PackageLayout.folderOf(rel) === folder).length;
    return `${folder}/ ${n === 0 ? 'none' : `${n} module${n === 1 ? '' : 's'}`}`;
  });
  console.log(`Pack exports what features/, parts/ and assemblies/ hold. Today: ${counts.join(', ')}.`);
}

function indent(text) {
  return text.split('\n').map((line) => `  ${line}`).join('\n');
}

export function registerPackageCommand(program) {
  const pkg = program
    .command('package')
    .description('Make this workspace a package you can publish on the hub');

  pkg
    .command('init')
    .description('Write the "package" block of fluidcad.json: the name and version 0.1.0 (the features/, parts/ and assemblies/ folders decide the exports)')
    .option('-w, --workspace <path>', 'Workspace directory (defaults to cwd)')
    .option('-n, --name <@handle/name>', 'Package name, @<your hub handle>/<name>; signed in, a name without the scope takes your handle (asked for when omitted)')
    .option('--hub <url>', 'The hub whose handle scopes a name without one (default: FLUIDCAD_HUB_URL, else https://hub.fluidcad.io)')
    .action((opts) => {
      runPackageInit(opts).catch((err) => {
        console.error(err?.message ?? err);
        process.exit(1);
      });
    });
}

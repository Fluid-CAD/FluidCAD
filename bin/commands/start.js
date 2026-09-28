import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function runStart(opts) {
  const port = Number(opts.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port "${opts.port}".`);
  }
  // Loaded here rather than at the top, so every other command starts as
  // quickly as it did before the start screen existed.
  const { runLauncher } = await import('../../launcher/dist/server/cli.js');
  await runLauncher({
    packageRoot,
    port,
    open: opts.open,
    projectsRoot: opts.projects === undefined ? undefined : resolve(opts.projects),
  });
}

export function registerStartCommand(program) {
  program
    // `npx fluidcad` on its own runs this.
    .command('start', { isDefault: true })
    .description('Open the FluidCAD start screen in the browser: recent projects, new projects, and the engine each one runs on (the default command)')
    .option('-p, --port <port>', 'port for the start screen (the first free port at or above it is used)', '3100')
    .option('--no-open', 'do not open a browser, only print the start screen\'s link')
    .option(
      '--projects <dir>',
      'keep every project in this folder: the start screen lists its projects, New Project asks for a name only, and nothing outside it can be opened',
    )
    .action((opts) => {
      runStart(opts).catch((err) => {
        console.error(err?.message ?? err);
        process.exit(1);
      });
    });
}

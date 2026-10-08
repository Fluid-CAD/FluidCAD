import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** `FLUIDCAD_NO_AUTH=1` (or true, yes, on) stands in for `--no-auth`, for containers. */
function envFlag(name) {
  return ['1', 'true', 'yes', 'on'].includes((process.env[name] ?? '').trim().toLowerCase());
}

/** `--allowed-host` may be given more than once; `FLUIDCAD_ALLOWED_HOSTS` adds a comma-separated list. */
function allowedHostsFrom(opts) {
  const fromEnv = (process.env.FLUIDCAD_ALLOWED_HOSTS ?? '').split(',');
  return [...(opts.allowedHost ?? []), ...fromEnv].map((name) => name.trim()).filter((name) => name !== '');
}

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
    host: opts.host,
    publicUrl: opts.publicUrl ?? (process.env.FLUIDCAD_PUBLIC_URL?.trim() || undefined),
    // Commander names `--no-auth` `auth`, true unless the flag is given.
    noAuth: opts.auth === false || envFlag('FLUIDCAD_NO_AUTH'),
    allowedHosts: allowedHostsFrom(opts),
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
    .option(
      '--host <address>',
      'the address to listen on; 0.0.0.0 lets other machines reach the start screen and, through it, every project it opens',
      '127.0.0.1',
    )
    .option(
      '--public-url <url>',
      'the origin browsers reach FluidCAD at behind a reverse proxy, such as https://cad.example.com; https makes the session cookie Secure (or FLUIDCAD_PUBLIC_URL)',
    )
    .option(
      '--no-auth',
      'no sign-in link: anyone who reaches the start screen can use it (FLUIDCAD_NO_AUTH=1); only for a trusted network',
    )
    .option(
      '--allowed-host <name>',
      'a host name browsers reach FluidCAD by, such as cad-server or 192.0.2.20; any other is refused (repeatable, or FLUIDCAD_ALLOWED_HOSTS=a,b); required with --no-auth and --host',
      (name, names) => [...names, name],
      [],
    )
    .action((opts) => {
      runStart(opts).catch((err) => {
        console.error(err?.message ?? err);
        process.exit(1);
      });
    });
}

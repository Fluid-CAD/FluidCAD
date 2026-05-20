import { fork } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import open from 'open';
import { createFileWatcher, findFluidFiles } from '../watcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(__dirname, '..', '..', 'server', 'dist', 'index.js');

function runServe(opts) {
  const workspacePath = resolve(opts.workspace);
  const port = String(opts.port);

  const server = fork(serverEntry, [], {
    env: {
      ...process.env,
      FLUIDCAD_SERVER_PORT: port,
      FLUIDCAD_WORKSPACE_PATH: workspacePath,
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  server.stdout.on('data', (data) => { process.stdout.write(data); });
  server.stderr.on('data', (data) => { process.stderr.write(data); });

  let watcher;

  server.on('message', (msg) => {
    if (msg.type === 'ready') {
      console.log(`FluidCAD server ready at ${msg.url}`);
      if (opts.open) {
        open(msg.url).catch((err) => {
          console.error(`Failed to open browser: ${err.message}`);
        });
      }
    }
    if (msg.type === 'init-complete') {
      if (msg.success) {
        console.log('FluidCAD initialized successfully.');
        watcher = createFileWatcher(workspacePath, server);

        const files = findFluidFiles(workspacePath);
        if (files.length > 0) {
          server.send({ type: 'process-file', filePath: files[0] });
        }
      } else {
        console.error(`FluidCAD initialization failed: ${msg.error}`);
        process.exit(1);
      }
    }
  });

  server.on('exit', (code) => {
    if (watcher) { watcher.close(); }
    process.exit(code || 0);
  });

  process.on('SIGINT', () => {
    if (watcher) { watcher.close(); }
    server.kill('SIGINT');
  });

  process.on('SIGTERM', () => {
    if (watcher) { watcher.close(); }
    server.kill('SIGTERM');
  });
}

export function registerServeCommand(program) {
  program
    .command('serve')
    .description('Start the FluidCAD server and watch .fluid.js files')
    .option('-w, --workspace <path>', 'workspace directory', process.cwd())
    .option('-p, --port <port>', 'server port', '3100')
    .option('--open', 'open the UI in the default browser when ready', false)
    .action(runServe);
}

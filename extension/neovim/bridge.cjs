#!/usr/bin/env node

const { fork } = require('child_process');
const path = require('path');
const readline = require('readline');

const net = require('net');

const workspacePath = process.argv[2];
if (!workspacePath) {
  process.stderr.write('Usage: node bridge.js <workspace-path>\n');
  process.exit(1);
}

let serverEntry;
try {
  serverEntry = require.resolve('fluidcad/server');
} catch {
  serverEntry = path.resolve(__dirname, '..', '..', 'server', 'src', 'index.ts');
}

function findFreePort(start) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(start, '127.0.0.1', () => {
      srv.close(() => resolve(start));
    });
    srv.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(findFreePort(start + 1));
      } else {
        reject(err);
      }
    });
  });
}

const isTs = serverEntry.endsWith('.ts');
const execArgv = isTs
  ? ['--experimental-transform-types', '--no-warnings', '--enable-source-maps']
  : ['--enable-source-maps'];

findFreePort(3100).then((port) => {

const server = fork(serverEntry, [], {
  env: {
    ...process.env,
    FLUIDCAD_SERVER_PORT: String(port),
    FLUIDCAD_WORKSPACE_PATH: path.resolve(workspacePath),
  },
  execArgv,
  stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
});

// Server stdout/stderr → bridge stderr (won't interfere with JSON protocol)
server.stdout.on('data', (data) => {
  process.stderr.write('[server] ' + data.toString());
});
server.stderr.on('data', (data) => {
  process.stderr.write('[server:err] ' + data.toString());
});

// IPC messages from server → JSON lines on stdout
server.on('message', (msg) => {
  process.stdout.write(JSON.stringify(msg) + '\n');
});

server.on('error', (err) => {
  process.stdout.write(JSON.stringify({ type: 'error', message: err.message }) + '\n');
});

server.on('exit', (code) => {
  process.stdout.write(JSON.stringify({ type: 'exit', code }) + '\n');
  process.exit(code || 0);
});

// JSON lines from stdin → IPC messages to server
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    server.send(msg);
  } catch (err) {
    process.stderr.write('Invalid JSON on stdin: ' + line + '\n');
  }
});

rl.on('close', () => {
  server.kill();
  process.exit(0);
});

}).catch((err) => {
  process.stderr.write('Failed to find free port: ' + err.message + '\n');
  process.exit(1);
});

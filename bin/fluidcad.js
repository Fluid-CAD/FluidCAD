#!/usr/bin/env node

import { fork } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { values } = parseArgs({
  options: {
    port: { type: 'string', short: 'p', default: '3100' },
    workspace: { type: 'string', short: 'w', default: process.cwd() },
  },
  allowPositionals: true,
});

const serverEntry = resolve(__dirname, '..', 'server', 'dist', 'index.js');

const server = fork(serverEntry, [], {
  env: {
    ...process.env,
    FLUIDCAD_SERVER_PORT: values.port,
    FLUIDCAD_WORKSPACE_PATH: resolve(values.workspace),
  },
  stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
});

server.stdout.on('data', (data) => {
  process.stdout.write(data);
});

server.stderr.on('data', (data) => {
  process.stderr.write(data);
});

server.on('message', (msg) => {
  if (msg.type === 'ready') {
    console.log(`FluidCAD server ready at ${msg.url}`);
  }
  if (msg.type === 'init-complete') {
    if (msg.success) {
      console.log('FluidCAD initialized successfully.');
    } else {
      console.error(`FluidCAD initialization failed: ${msg.error}`);
      process.exit(1);
    }
  }
});

server.on('exit', (code) => {
  process.exit(code || 0);
});

process.on('SIGINT', () => {
  server.kill('SIGINT');
});

process.on('SIGTERM', () => {
  server.kill('SIGTERM');
});

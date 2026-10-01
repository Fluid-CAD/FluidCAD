import fs from 'fs';
import path from 'path';

/**
 * A stand-in `fluidcad` package for the launcher's tests: what a launcher
 * needs from a real one, and nothing heavier.
 *
 * - `server/dist/index.js` speaks the engine's startup handshake over IPC and
 *   answers the few routes a launcher calls. It writes its pid to
 *   `<workspace>/.engine-pid`, and reports the dirty buffers listed in
 *   `<workspace>/.dirty.json`. `FAKE_ENGINE_FAIL=1` makes it fail to start.
 * - `bin/fluidcad.js init` writes the scaffold a real `init` writes, pinned to
 *   this package's version.
 * - `ui/dist-start/` is a start page with the theme literal, and an asset.
 */

const ENGINE = `
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const port = Number(process.env.FLUIDCAD_SERVER_PORT);
const workspace = process.env.FLUIDCAD_WORKSPACE_PATH;
fs.writeFileSync(path.join(workspace, '.engine-pid'), String(process.pid));
fs.writeFileSync(path.join(workspace, '.engine-host'), process.env.FLUIDCAD_SERVER_HOST || '');
const server = http.createServer((request, response) => {
  const send = (body) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(body));
  };
  const route = request.url.split('?')[0];
  // What the proxy forwards, echoed: the page, and a call that says how it arrived.
  if (route === '/') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    return response.end('<!DOCTYPE html><html><body>engine page for ' + path.basename(workspace) + '</body></html>');
  }
  if (route === '/api/echo') {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => send({ method: request.method, url: request.url, host: request.headers.host, cookie: request.headers.cookie ?? null, body }));
    return;
  }
  if (route === '/api/editor/dirty-files') {
    let dirty = [];
    try { dirty = JSON.parse(fs.readFileSync(path.join(workspace, '.dirty.json'), 'utf8')); } catch {}
    return send(dirty);
  }
  if (route === '/api/workspace/editor-state') return send({ activeTab: null });
  if (route === '/api/files/tree') return send({ files: [] });
  if (route === '/api/scene/shapes') return send({ shapes: [] });
  if (route === '/api/files/open') return send({ ok: true });
  response.statusCode = 404;
  response.end();
});
// A WebSocket that echoes every text frame, enough to see the proxy carry one both ways.
server.on('upgrade', (request, socket) => {
  const key = request.headers['sec-websocket-key'];
  if (request.url !== '/' || !key) {
    socket.write('HTTP/1.1 404 Not Found\\r\\nConnection: close\\r\\n\\r\\n');
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');
  socket.on('data', (data) => {
    // A masked text frame from the client, short enough for the 7-bit length.
    const length = data[1] & 0x7f;
    const mask = data.subarray(2, 6);
    const payload = Buffer.from(data.subarray(6, 6 + length).map((byte, i) => byte ^ mask[i % 4]));
    const reply = Buffer.from('echo:' + payload.toString() + ' host=' + request.headers.host);
    socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]));
  });
});
server.listen(port, '127.0.0.1', () => {
  process.send({ type: 'ready', url: 'http://localhost:' + port });
  if (process.env.FAKE_ENGINE_FAIL === '1') {
    process.send({ type: 'init-complete', success: false, error: 'The fake engine was told to fail.' });
  } else {
    process.send({ type: 'init-complete', success: true });
  }
});
process.on('SIGTERM', () => process.exit(0));
process.on('disconnect', () => process.exit(0));
`;

const CLI = `
const fs = require('fs');
const path = require('path');
if (process.argv[2] === 'init') {
  const version = require(path.join(__dirname, '..', 'package.json')).version;
  fs.writeFileSync('init.js', "import { init } from 'fluidcad'\\nexport default await init()\\n");
  fs.writeFileSync('part1.part.js', '');
  fs.writeFileSync('fluidcad.json', JSON.stringify({ engine: version }) + '\\n');
}
`;

export const FAKE_START_PAGE =
  '<!DOCTYPE html><html lang="en" class="h-full" data-theme="fluidcad-dark"><head><title>FluidCAD</title></head>' +
  '<body><div id="fluidcad-start"></div><script type="module" src="/assets/start.js"></script></body></html>';

/** Write a fake `fluidcad` package of `version` at `packageRoot`. */
export function writeFakePackage(packageRoot: string, version: string): void {
  const write = (relative: string, content: string) => {
    const file = path.join(packageRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write('package.json', JSON.stringify({ name: 'fluidcad', version }));
  write('server/dist/index.js', ENGINE);
  write('bin/fluidcad.js', CLI);
  write('ui/dist-start/start.html', FAKE_START_PAGE);
  write('ui/dist-start/assets/start.js', 'export {};\n');
  write('ui/dist-start/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
}

/** The pid the fake engine for `workspace` wrote, once it is up. */
export function fakeEnginePid(workspace: string): number {
  return Number(fs.readFileSync(path.join(workspace, '.engine-pid'), 'utf8'));
}

/** Make the fake engine for `workspace` report these files as unsaved. */
export function setDirtyFiles(workspace: string, files: string[]): void {
  fs.writeFileSync(
    path.join(workspace, '.dirty.json'),
    JSON.stringify(files.map((file) => ({ path: path.join(workspace, file), lastModifiedMs: 1 }))),
  );
}

/** Resolves once `pid` has exited, or rejects after `timeoutMs`. */
export async function processGone(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`process ${pid} is still running`);
}

/** Polls `check` until it returns true, or fails after `timeoutMs`. */
export async function eventually(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for a condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

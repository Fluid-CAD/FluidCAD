import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const website = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const viewerRoot = resolve(website, process.env.FLUIDCAD_VIEWER_DIR || '../../FluidCAD-Viewer');
const viewerUrl = new URL(process.env.FLUIDCAD_VIEWER_URL || 'http://localhost:8788');
const env = {...process.env, FLUIDCAD_VIEWER_URL: viewerUrl.origin};
const children = new Set();
let stopping = false;

function signal(child, name) {
  try {
    if (process.platform === 'win32') child.kill(name);
    else process.kill(-child.pid, name);
  } catch (error) {
    if (error.code !== 'ESRCH') console.error(error.message);
  }
}

function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) signal(child, 'SIGTERM');
  const timer = setTimeout(() => {
    for (const child of children) signal(child, 'SIGKILL');
  }, 3000);
  timer.unref();
}

process.on('SIGINT', () => stop(130));
process.on('SIGTERM', () => stop(143));

function launch(script, args, cwd, childEnv = env, persistent = true) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd, env: childEnv, stdio: 'inherit', detached: process.platform !== 'win32',
  });
  children.add(child);
  child.done = new Promise((resolveDone, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      children.delete(child);
      if (persistent && !stopping) stop(code ?? 1);
      resolveDone(code);
    });
  });
  return child;
}

async function viewerReady() {
  try {
    const response = await fetch(viewerUrl, {signal: AbortSignal.timeout(1000)});
    return response.ok && (await response.text()).includes('fluidcad-viewer');
  } catch {
    return false;
  }
}

try {
  if (['localhost', '127.0.0.1', '[::1]'].includes(viewerUrl.hostname)) {
    if (await viewerReady()) {
      console.log(`[docs] Reusing viewer at ${viewerUrl.origin}`);
    } else {
      const serve = resolve(viewerRoot, 'app/serve.mjs');
      if (!existsSync(serve)) {
        throw new Error(`Viewer checkout missing at ${viewerRoot}. Set FLUIDCAD_VIEWER_DIR to its location.`);
      }
      if (!existsSync(resolve(viewerRoot, 'app/dist/index.html')) ||
          !existsSync(resolve(viewerRoot, 'app/dist/engine'))) {
        console.log('[docs] Building the local viewer…');
        for (const script of ['app/build.mjs', 'engine-builder/build-engine.mjs']) {
          const build = launch(resolve(viewerRoot, script), script.includes('build-engine') ? ['--local'] : [], viewerRoot, env, false);
          const code = await build.done;
          if (stopping) break;
          if (code !== 0) throw new Error('Viewer build failed. Install its dependencies with npm install in the viewer checkout.');
        }
      }
      if (!stopping) {
        const viewer = launch(serve, [], viewerRoot, {...env, PORT: viewerUrl.port || '80'});
        // Attach the rejection handler immediately while polling readiness.
        viewer.done.catch(error => { console.error(error.message); stop(1); });
        let ready = false;
        for (let attempt = 0; attempt < 100 && !stopping; attempt++) {
          if (await viewerReady()) { ready = true; break; }
          await delay(100);
        }
        if (!stopping && !ready) throw new Error(`Viewer did not become ready at ${viewerUrl.origin}.`);
      }
    }
  }
  if (!stopping) {
    const docusaurus = require.resolve('@docusaurus/core/bin/docusaurus.mjs');
    await launch(docusaurus, ['start', ...process.argv.slice(2)], website).done;
  }
} catch (error) {
  console.error(`[docs] ${error.message}`);
  stop(1);
}

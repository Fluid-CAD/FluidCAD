import { fork } from 'child_process';
import fs from 'fs';
import path from 'path';
import { defaultEngine } from '../engine/resolver.ts';
import { isFluidScriptFile } from '../file-kind.ts';
import type { FolderState } from '../start/contract.ts';

/**
 * New projects. A new project is `fluidcad init` run inside an empty folder —
 * the same scaffold `npx fluidcad init` produces on the command line
 * (`init.js`, `box.part.js`, `jsconfig.json`, and a `fluidcad.json` pin) —
 * and the folder may not exist yet: it is created first.
 *
 * `init` comes from the launcher's own engine: it is the engine an unpinned
 * project would resolve to anyway, so the pin `init` writes is the one the
 * resolver would have written on first open. It runs the way engines run, as
 * this process's own binary in Node mode, so the desktop app needs no system
 * Node for it.
 */

/** OS litter that does not make a folder non-empty. */
const IGNORED_ENTRIES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

const INIT_TIMEOUT_MS = 30_000;

/** Entries that count, or null when the folder can't be listed. */
function folderContents(folder: string): string[] | null {
  try {
    return fs.readdirSync(folder).filter((name) => !IGNORED_ENTRIES.has(name));
  } catch {
    return null;
  }
}

/** A folder's entries make a project when it has an `init.js` or a model file at its top. */
export function holdsProject(entries: string[]): boolean {
  return entries.some((name) => name === 'init.js' || isFluidScriptFile(name));
}

/** What `folder` is, for opening or creating a project there. */
export function inspectFolder(folder: string): Exclude<FolderState, 'invalid-name'> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(folder);
  } catch (err: any) {
    return err?.code === 'ENOENT' ? 'missing' : 'unreadable';
  }
  if (!stat.isDirectory()) {
    return 'not-a-folder';
  }
  const contents = folderContents(folder);
  if (contents === null) {
    return 'unreadable';
  }
  if (holdsProject(contents)) {
    return 'project';
  }
  return contents.length === 0 ? 'empty' : 'not-empty';
}

/**
 * A name that can be a new folder on every platform FluidCAD runs on: no
 * separators, no reserved characters or names, and not `.` or `..` — so the
 * project lands exactly in the folder the user was looking at.
 */
export function isValidFolderName(name: string): boolean {
  if (name.trim() !== name || name === '' || name === '.' || name === '..' || name.length > 255) {
    return false;
  }
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name)) {
    return false;
  }
  return !/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name);
}

export class ScaffoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScaffoldError';
  }
}

/**
 * Set a project up in `folder`: create the folder if it does not exist, then
 * run `fluidcad init` in it. A folder that already holds a project is left as
 * it is — asking twice (a retry after the engine failed to start, a reloaded
 * tab) must not fail on the project the first call made. Any other non-empty
 * folder is refused: `init` would scatter its files among someone else's.
 */
export async function scaffoldProject(folder: string): Promise<void> {
  let state = inspectFolder(folder);
  if (state === 'project') {
    return;
  }
  if (state === 'missing') {
    try {
      fs.mkdirSync(folder);
    } catch (err: any) {
      throw new ScaffoldError(`The folder ${folder} could not be created: ${err?.message ?? String(err)}`);
    }
    state = inspectFolder(folder);
  }
  switch (state) {
    case 'empty':
      break;
    case 'not-empty':
      throw new ScaffoldError(`${folder} is not empty. A new project needs an empty folder.`);
    case 'not-a-folder':
      throw new ScaffoldError(`${folder} is a file, not a folder.`);
    default:
      throw new ScaffoldError(`${folder} could not be read.`);
  }

  const engine = defaultEngine();
  if (!engine) {
    throw new ScaffoldError(
      'No FluidCAD engine is installed to set the project up with. Reinstall FluidCAD, or open an existing project first so an engine gets downloaded.',
    );
  }
  await runInit(path.join(engine.packageRoot, 'bin', 'fluidcad.js'), folder);
}

/** `fluidcad init` in `folder`, through this process's own binary running as Node. */
function runInit(cli: string, folder: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(cli)) {
      reject(new ScaffoldError(`The engine has no CLI at ${cli}.`));
      return;
    }
    const child = fork(cli, ['init'], {
      cwd: folder,
      execPath: process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr?.on('data', (data) => {
      stderr += String(data);
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new ScaffoldError(`\`fluidcad init\` did not finish within ${INIT_TIMEOUT_MS / 1000}s.`));
    }, INIT_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
      } else {
        reject(new ScaffoldError(stderr.trim() || `\`fluidcad init\` exited with code ${code}.`));
      }
    });
  });
}

import { fork } from 'child_process';
import { BrowserWindow, dialog } from 'electron';
import fs from 'fs';
import path from 'path';
import { defaultEngine } from './engine/resolver';
import { isFluidScriptFile } from './file-kind';

/**
 * "New project" from the start screen: the user picks an empty folder and the
 * shell runs `fluidcad init` inside it — the same scaffold `npx fluidcad init`
 * produces on the command line (`init.js`, `box.part.js`, `jsconfig.json`,
 * and a `fluidcad.json` pin).
 *
 * The CLI comes from the engine that ships with the app: it is the engine an
 * unpinned project would resolve to anyway, so the pin `init` writes is the
 * one the resolver would have written on first open. It runs the way the
 * engine itself runs — this binary as Node — so no system Node is needed.
 */

/** OS litter that does not make a folder non-empty. */
const IGNORED_ENTRIES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

const INIT_TIMEOUT_MS = 30_000;

export type NewProjectOutcome =
  /** Scaffolded; open it. */
  | { kind: 'created'; path: string }
  /** The chosen folder already holds a project and the user chose to open it. */
  | { kind: 'existing'; path: string };

export async function createNewProject(parent: BrowserWindow | null): Promise<NewProjectOutcome | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'New FluidCAD project',
    message: 'Choose an empty folder. FluidCAD will set the project up inside it.',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Create project',
  };
  const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  if (picked.canceled || !picked.filePaths[0]) {
    return null;
  }
  const folder = path.resolve(picked.filePaths[0]);

  const contents = folderContents(folder);
  if (contents === null) {
    await report(parent, 'This folder could not be read.', folder);
    return null;
  }

  if (contents.some((name) => name === 'init.js' || isFluidScriptFile(name))) {
    // Not empty, but a project — the likely intent is to open it.
    const answer = await messageBox(parent, {
      type: 'question',
      message: 'This folder already holds a FluidCAD project.',
      detail: `${folder}\n\nOpen it instead?`,
      buttons: ['Open project', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    });
    return answer.response === 0 ? { kind: 'existing', path: folder } : null;
  }

  if (contents.length > 0) {
    await report(
      parent,
      'This folder is not empty.',
      `${folder}\n\nA new project needs an empty folder — pick another one, or create one from the dialog.`,
    );
    return null;
  }

  const engine = defaultEngine();
  if (!engine) {
    await report(
      parent,
      'No FluidCAD engine is installed.',
      'A new project is scaffolded by the engine that ships with the app. Reinstall the app, or open an existing project first so an engine gets downloaded.',
    );
    return null;
  }

  try {
    await runInit(path.join(engine.packageRoot, 'bin', 'fluidcad.js'), folder);
  } catch (err: any) {
    await report(parent, 'The project could not be created.', err?.message ?? String(err));
    return null;
  }
  return { kind: 'created', path: folder };
}

/** Entries that count, or null when the folder can't be listed. */
function folderContents(folder: string): string[] | null {
  try {
    return fs.readdirSync(folder).filter((name) => !IGNORED_ENTRIES.has(name));
  } catch {
    return null;
  }
}

function messageBox(
  parent: BrowserWindow | null,
  options: Electron.MessageBoxOptions,
): Promise<Electron.MessageBoxReturnValue> {
  return parent && !parent.isDestroyed()
    ? dialog.showMessageBox(parent, options)
    : dialog.showMessageBox(options);
}

function report(parent: BrowserWindow | null, message: string, detail: string): Promise<unknown> {
  return messageBox(parent, { type: 'error', message, detail });
}

/** `fluidcad init` in `folder`, through the app binary running as Node. */
function runInit(cli: string, folder: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(cli)) {
      reject(new Error(`The engine has no CLI at ${cli}.`));
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
      reject(new Error(`\`fluidcad init\` did not finish within ${INIT_TIMEOUT_MS / 1000}s.`));
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
        reject(new Error(stderr.trim() || `\`fluidcad init\` exited with code ${code}.`));
      }
    });
  });
}

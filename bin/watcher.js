import chokidar from 'chokidar';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * The suffixes the server recognises as FluidCAD scripts (mirror of
 * `server/src/file-kind.ts`): part-design files, assembly drivers, and the
 * legacy `.fluid.js` alias for a part.
 */
const FLUID_SCRIPT_SUFFIXES = ['.part.js', '.assembly.js', '.fluid.js'];

/**
 * @param {string} filePath
 * @returns {boolean} whether the server would render this file as a model
 */
export function isFluidScriptFile(filePath) {
  return FLUID_SCRIPT_SUFFIXES.some((suffix) => filePath.endsWith(suffix));
}

/**
 * Creates a file watcher that monitors FluidCAD script files in the workspace
 * and sends live-update IPC messages to the server process on changes.
 *
 * @param {string} workspacePath - Absolute path to the workspace directory
 * @param {import('child_process').ChildProcess} server - The forked server process
 * @returns {import('chokidar').FSWatcher} The watcher instance (call .close() to stop)
 */
export function createFileWatcher(workspacePath, server) {
  const debounceTimers = new Map();

  const watcher = chokidar.watch(workspacePath, {
    ignored: /(^|[/\\])(node_modules|\.git)/,
    ignoreInitial: true,
  });

  function sendUpdate(filePath) {
    try {
      const code = readFileSync(filePath, 'utf-8');
      server.send({
        type: 'live-update',
        fileName: filePath,
        code,
      });
      console.log(`File changed: ${filePath}`);
    } catch (err) {
      console.error(`Failed to read ${filePath}:`, err.message);
    }
  }

  function onFileChange(filePath) {
    if (!isFluidScriptFile(filePath)) {
      return;
    }

    if (debounceTimers.has(filePath)) {
      clearTimeout(debounceTimers.get(filePath));
    }

    debounceTimers.set(filePath, setTimeout(() => {
      debounceTimers.delete(filePath);
      sendUpdate(filePath);
    }, 300));
  }

  watcher.on('change', onFileChange);
  watcher.on('add', onFileChange);

  console.log(`Watching for FluidCAD script changes in ${workspacePath}`);

  return watcher;
}

/**
 * Finds FluidCAD script files (`.part.js`, `.assembly.js`, `.fluid.js`) in
 * the top level of the workspace directory, ignoring node_modules and .git.
 *
 * @param {string} workspacePath - Absolute path to the workspace directory
 * @returns {string[]} Absolute paths to discovered script files
 */
export function findFluidFiles(workspacePath) {
  try {
    return readdirSync(workspacePath)
      .filter((f) => isFluidScriptFile(f))
      .map((f) => join(workspacePath, f));
  } catch {
    return [];
  }
}

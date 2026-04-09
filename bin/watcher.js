import chokidar from 'chokidar';
import { readFileSync } from 'fs';

/**
 * Creates a file watcher that monitors .fluid.js files in the workspace
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
    if (!filePath.endsWith('.fluid.js')) {
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

  console.log(`Watching for .fluid.js changes in ${workspacePath}`);

  return watcher;
}

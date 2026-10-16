import { stripVTControlCharacters } from 'util';
import { createLogger, type Logger } from 'vite';

/**
 * Vite's logger minus the per-file size table a build prints: the editor
 * build alone lists a dozen assets. Each build still announces itself, ends
 * with its "built in" line, and shows every warning and error.
 */
export function buildLogger(): Logger {
  const logger = createLogger();
  const info = logger.info;
  logger.info = (msg, options) => {
    if (!isAssetTable(msg)) {
      info(msg, options);
    }
  };
  return logger;
}

/** The reporter's file list: every line a path followed by its size in kB. */
function isAssetTable(msg: string): boolean {
  const lines = stripVTControlCharacters(msg)
    .split('\n')
    .filter((line) => line.trim() !== '');
  return lines.length > 0 && lines.every((line) => /\s[\d,]+\.\d+ kB\b/.test(line));
}

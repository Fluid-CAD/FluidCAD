import { createInterface } from 'readline/promises';

/**
 * Minimal interactive prompts for the CLI, built on Node's built-in
 * `readline` — no dependency (the CLI only ships `commander`). Used by
 * `publish` to ask before an upload or a withdrawal.
 */

/**
 * Whether we can run an interactive prompt — both stdin and stdout must be a
 * TTY. CI and piped input are not, so callers fall back to flags/defaults there.
 */
export function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * A y/N question, answered with a line: true only for `y` or `yes`, so a bare
 * Enter declines. Assumes `isInteractive()`.
 */
export async function confirm(message) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${message} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

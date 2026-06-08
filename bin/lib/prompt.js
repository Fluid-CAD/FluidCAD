import { emitKeypressEvents } from 'readline';

/**
 * Minimal interactive prompts for the CLI, built on Node's built-in `readline`
 * keypress events — no dependency (the CLI only ships `commander`). Used by
 * `publish` to choose between a new model and a new version.
 */

/**
 * Whether we can run an interactive prompt — both stdin and stdout must be a
 * TTY. CI and piped input are not, so callers fall back to flags/defaults there.
 */
export function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_LINE = '\x1b[2K';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/**
 * Arrow-key (or j/k) single-select. Renders a menu with one highlighted row,
 * moves the highlight on ↑/↓/k/j, confirms on Enter, and aborts on Ctrl-C.
 * Resolves to the chosen entry's `value`. Assumes `isInteractive()` — it puts
 * stdin in raw mode, so don't call it without a TTY.
 *
 * `choices`: `[{ label, value }]`.
 */
export function select(message, choices) {
  return new Promise((resolveChoice) => {
    const input = process.stdin;
    const output = process.stdout;
    let active = 0;

    // Truncate labels so a long one never wraps — a wrapped row would occupy two
    // terminal lines and throw off the cursor-up redraw math below.
    const width = Math.max(8, (output.columns || 80) - 2);
    const fit = (s) => (s.length > width ? s.slice(0, width - 1) + '…' : s);

    output.write(`${message}\n`);
    output.write(`${DIM}  ↑/↓ or j/k to move · Enter to confirm${RESET}\n`);
    output.write(HIDE_CURSOR);

    const draw = (initial) => {
      if (!initial) output.write(`\x1b[${choices.length}A`); // back up to the first row
      choices.forEach((c, i) => {
        const on = i === active;
        const row = `${on ? '❯' : ' '} ${fit(c.label)}`;
        output.write(`${CLEAR_LINE}${on ? `${CYAN}${row}${RESET}` : row}\n`);
      });
    };
    draw(true);

    emitKeypressEvents(input);
    const wasRaw = Boolean(input.isRaw);
    input.setRawMode(true);
    input.resume();

    const restore = () => {
      input.removeListener('keypress', onKey);
      input.setRawMode(wasRaw);
      input.pause();
      output.write(SHOW_CURSOR);
    };

    const onKey = (_str, key) => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') {
        restore();
        output.write('\n');
        process.exit(130); // 128 + SIGINT, the shell convention for Ctrl-C
      }
      switch (key.name) {
        case 'up':
        case 'k':
          active = (active - 1 + choices.length) % choices.length;
          draw(false);
          break;
        case 'down':
        case 'j':
          active = (active + 1) % choices.length;
          draw(false);
          break;
        case 'return':
        case 'enter':
          restore();
          resolveChoice(choices[active].value);
          break;
      }
    };

    input.on('keypress', onKey);
  });
}

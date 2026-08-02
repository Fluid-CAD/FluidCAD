/**
 * The copy dialog's Skip field: the text a user types ⇄ the index tuples
 * `copy()`'s `skip` option takes.
 *
 * One entry per instance left out, separated by commas (or plain spaces). A
 * single-direction copy — and every circular one — names an instance by its
 * index alone: `1, 3`. A grid names a cell as a bracketed pair, the array form
 * the statement itself writes: `[1, 0], [2, 1]`. A bare index inside a grid
 * names a whole row: the kernel matches a coordinate only as far as it is
 * stated (copy-linear.ts:82), so `1` leaves out every cell sitting at index 1
 * along direction 1.
 *
 * Indices count from the original, which is 0. Expressions are deliberately not
 * accepted — a skip list is a handful of literal positions, and the numbers it
 * names have to line up with counts the dialog can check.
 */

/** The ceiling on one statement's skip list — a typo must not write a novel. */
export const MAX_SKIP_ENTRIES = 256;

/**
 * What the field's "?" icon opens (see `ui/help-popover.ts`): the syntax
 * {@link parseSkipEntries} accepts, worked through every form it takes, down to
 * the option the statement ends up carrying. It lives here so the examples and
 * the parser that has to honor them are edited together.
 */
export const SKIP_HELP_HTML = `
  <div class="font-medium mb-1.5">Skipping instances</div>
  <p class="text-base-content/70 mb-2">
    Instances are numbered from <code class="font-mono">0</code> along each
    direction, and entries are separated by commas. Every index must be below
    that direction's Total Count; the original instance always stays.
  </p>

  <!-- One grid for every example, so the two sections share a code column. -->
  <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-baseline">
    <div class="col-span-2 text-[10px] uppercase tracking-wide text-base-content/45">
      One direction, or circular
    </div>
    <code class="font-mono text-base-content/90 whitespace-nowrap">3</code>
    <span class="text-base-content/70">leaves out instance 3</span>
    <code class="font-mono text-base-content/90 whitespace-nowrap">1, 3</code>
    <span class="text-base-content/70">leaves out 1 and 3 — a count of 5 keeps 0, 2 and 4</span>

    <div class="col-span-2 mt-1.5 text-[10px] uppercase tracking-wide text-base-content/45">
      Two directions (a grid)
    </div>
    <code class="font-mono text-base-content/90 whitespace-nowrap">[1, 0]</code>
    <span class="text-base-content/70">one cell: 1 along direction 1, 0 along direction 2</span>
    <code class="font-mono text-base-content/90 whitespace-nowrap">[1, 0], [2, 1]</code>
    <span class="text-base-content/70">two cells</span>
    <code class="font-mono text-base-content/90 whitespace-nowrap">2</code>
    <span class="text-base-content/70">every cell at 2 along direction 1 — that whole row</span>
    <code class="font-mono text-base-content/90 whitespace-nowrap">[1, 0], 2</code>
    <span class="text-base-content/70">a cell and a row together</span>
  </div>

  <div class="mt-2.5 pt-2 border-t border-base-content/10 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-baseline">
    <div class="col-span-2 text-[10px] uppercase tracking-wide text-base-content/45">Writes</div>
    <code class="font-mono text-base-content/90 whitespace-nowrap">skip: [[1], [3]]</code>
    <span class="text-base-content/70">linear</span>
    <code class="font-mono text-base-content/90 whitespace-nowrap">skip: [1, 3]</code>
    <span class="text-base-content/70">circular</span>
  </div>
`;

/**
 * Read the field's text as index tuples, or say what is wrong with it in the
 * words the panel shows. `arity` is how many directions the copy walks (1 for
 * circular): no entry may name more indices than there are directions.
 * Duplicates collapse — the same cell skipped twice is the same cell.
 */
export function parseSkipEntries(text: string, arity: number): number[][] | { error: string } {
  const trimmed = text.trim();
  if (trimmed === '') {
    return [];
  }
  const example = arity > 1 ? '[1, 0], [2, 1]' : '1, 3';
  const entries: number[][] = [];
  const seen = new Set<string>();
  for (const token of splitEntries(trimmed)) {
    if (token === '') {
      // A trailing comma, a double separator — nothing was named, so nothing
      // is skipped. Punctuation is not worth an error message.
      continue;
    }
    const parts = token.startsWith('[') && token.endsWith(']')
      ? token.slice(1, -1).split(',')
      : [token];
    const tuple: number[] = [];
    for (const part of parts) {
      const index = readIndex(part);
      if (index === null) {
        return { error: `Skip takes whole instance indices counting from 0 — e.g. ${example}.` };
      }
      tuple.push(index);
    }
    if (tuple.length > arity) {
      return {
        error: arity > 1
          ? `A skipped cell names at most ${arity} indices — e.g. ${example}.`
          : `Skip takes one index per instance — e.g. ${example}.`,
      };
    }
    const key = tuple.join(',');
    if (!seen.has(key)) {
      seen.add(key);
      entries.push(tuple);
    }
  }
  if (entries.length > MAX_SKIP_ENTRIES) {
    return { error: `Skip takes at most ${MAX_SKIP_ENTRIES} instances.` };
  }
  return entries;
}

/**
 * The tuples as the field spells them — a lone index bare, a cell bracketed.
 * Round-trips {@link parseSkipEntries}, so an edit dialog opens on the
 * statement's own skip list written the way the user would have typed it.
 */
export function formatSkipEntries(entries: number[][]): string {
  return entries
    .map(tuple => tuple.length === 1 ? String(tuple[0]) : `[${tuple.join(', ')}]`)
    .join(', ');
}

/**
 * The first entry naming an instance the pattern does not have, phrased for the
 * panel — or null when every index fits. `counts` is one instance count per
 * direction, `null` where the count is an expression this dialog can't resolve
 * (nothing is checked against it).
 */
export function skipRangeError(entries: number[][], counts: (number | null)[]): string | null {
  for (const tuple of entries) {
    for (let d = 0; d < tuple.length; d++) {
      const count = counts[d] ?? null;
      if (count === null || tuple[d] < count) {
        continue;
      }
      const which = counts.length > 1 ? ` for direction ${d + 1}` : '';
      return `Skip index ${tuple[d]} is past the count of ${count}${which} — indices run 0 to ${count - 1}.`;
    }
  }
  return null;
}

/**
 * The field's text as its entries: commas and spaces separate at the top level,
 * and a bracketed cell keeps its own commas whole — a closed bracket ends its
 * entry on the spot, so `[1, 0][2, 1]` reads as the two cells it looks like.
 */
function splitEntries(text: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '[') {
      depth++;
    } else if (char === ']') {
      depth--;
      if (depth === 0) {
        tokens.push(`${current.trim()}]`);
        current = '';
        continue;
      }
    }
    if (depth === 0 && (char === ',' || char === ';' || /\s/.test(char))) {
      tokens.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  tokens.push(current.trim());
  return tokens;
}

/** One index: a plain non-negative whole number, or null for anything else. */
function readIndex(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

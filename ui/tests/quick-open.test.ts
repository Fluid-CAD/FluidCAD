// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

// The `+` picker's row order: a bare name that is neither an existing part
// nor an existing assembly is something new, so its Create rows lead the
// list (and Enter creates); one that already is a part or an assembly keeps
// the matching files on top.

const listWorkspaceFiles = vi.fn();
vi.mock('../src/editor/editor-api', () => ({
  listWorkspaceFiles: (...args: unknown[]) => listWorkspaceFiles(...args),
}));

import { QuickOpen } from '../src/editor/quick-open';

function entry(path: string, kind: 'model' | 'module' = 'model') {
  return { path, absPath: `/ws/${path}`, kind };
}

async function openWith(paths: Array<ReturnType<typeof entry>>, query: string) {
  listWorkspaceFiles.mockResolvedValue({ files: paths, folders: [] });
  const handlers = { onOpen: vi.fn(), onCreate: vi.fn(), onCreateFolder: vi.fn(async () => {}) };
  const picker = new QuickOpen(handlers);
  const anchor = document.createElement('button');
  document.body.appendChild(anchor);
  await picker.open(anchor);
  const input = document.querySelector('input') as HTMLInputElement;
  input.value = query;
  input.dispatchEvent(new Event('input'));
  const rows = [...document.querySelectorAll('button')]
    .filter((row) => row !== anchor)
    .map((row) => (row.textContent ?? '').trim());
  const enter = () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  const type = (value: string) => {
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };
  return { handlers, rows, enter, type, picker };
}

/** The list's rows as they stand now (a redraw replaces them). */
function rowButtons(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-row-index]')];
}

/** The pointer moving to (x, y) over `row`. */
function pointerMove(row: HTMLElement, x: number, y: number): void {
  row.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y }));
}

function highlightedIndex(): number {
  return rowButtons().findIndex((row) => row.classList.contains('bg-base-content/[0.08]'));
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('QuickOpen create rows', () => {
  it('lead the list when the name is neither a part nor an assembly', async () => {
    const { rows, enter, handlers } = await openWith(
      [entry('desk-box.assembly.js'), entry('desk-box.part.js'), entry('desk.params.js', 'module')],
      'desk',
    );
    expect(rows[0]).toContain('Create part "desk"');
    expect(rows.slice(0, 3).every((row) => row.startsWith('Create'))).toBe(true);
    expect(rows.slice(3)).toEqual([
      'desk-box.assembly.jsdesk-box.assembly.js',
      'desk-box.part.jsdesk-box.part.js',
      'desk.params.jsdesk.params.js',
    ]);
    enter();
    expect(handlers.onCreate).toHaveBeenCalledWith('desk.part.js');
  });

  it('follow the matches when the name is an existing assembly', async () => {
    const { rows, enter, handlers } = await openWith(
      [entry('desk-box.part.js'), entry('desk.assembly.js')],
      'desk',
    );
    expect(rows[0].startsWith('Create')).toBe(false);
    expect(rows.at(-1)).toContain('Create feature "desk"');
    enter();
    expect(handlers.onOpen).toHaveBeenCalled();
    expect(handlers.onCreate).not.toHaveBeenCalled();
  });

  it('follow the matches when the name is an existing part', async () => {
    const { rows } = await openWith([entry('desk.part.js'), entry('desk-box.part.js')], 'desk');
    expect(rows[0].startsWith('Create')).toBe(false);
    expect(rows.at(-1)).toContain('Create feature "desk"');
  });
});

describe('QuickOpen pointer highlight', () => {
  const files = [entry('desk-box.assembly.js'), entry('desk-box.part.js')];

  it('moves to the row under the pointer, and Enter acts on it', async () => {
    const { enter, handlers } = await openWith(files, 'desk');
    expect(highlightedIndex()).toBe(0);
    pointerMove(rowButtons()[4], 20, 200);
    expect(highlightedIndex()).toBe(4);
    enter();
    expect(handlers.onOpen).toHaveBeenCalledWith(expect.objectContaining({ path: 'desk-box.assembly.js' }));
    expect(handlers.onCreate).not.toHaveBeenCalled();
  });

  it('stays on the top row when the list redraws under a resting pointer', async () => {
    const { enter, type, handlers } = await openWith(files, 'desk');
    pointerMove(rowButtons()[4], 20, 200);
    type('desks');
    expect(highlightedIndex()).toBe(0);
    // The browser re-reports the resting pointer over whatever row now sits under it.
    pointerMove(rowButtons()[2], 20, 200);
    expect(highlightedIndex()).toBe(0);
    enter();
    expect(handlers.onCreate).toHaveBeenCalledWith('desks.part.js');
  });
});

describe('QuickOpen list height', () => {
  /** jsdom lays nothing out: stand in the list's content height. */
  function withContentHeight(height: number) {
    return vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(height);
  }

  function listMaxHeight(): string {
    const list = document.querySelector('input')!.nextElementSibling as HTMLElement;
    return list.style.maxHeight;
  }

  it('grows to fit rows that run only a sliver past the cap, so no scrollbar shows', async () => {
    const spy = withContentHeight(281);
    await openWith([entry('desk-box.part.js')], 'desk');
    expect(listMaxHeight()).toBe('');
    spy.mockRestore();
  });

  it('caps and scrolls once a row is hidden', async () => {
    const spy = withContentHeight(400);
    await openWith([entry('desk-box.part.js')], 'desk');
    expect(listMaxHeight()).toBe('280px');
    spy.mockRestore();
  });
});

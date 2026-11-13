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
  return { handlers, rows, enter, picker };
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

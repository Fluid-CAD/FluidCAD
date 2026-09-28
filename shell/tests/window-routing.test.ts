import { describe, expect, it } from 'vitest';
import { menuEnablement } from '../src/menu';
import { afterProject, routeOpen, type WindowSnapshot } from '../src/window/registry';

const home = (id: number): WindowSnapshot => ({ id, projectPath: null });
const holding = (id: number, projectPath: string): WindowSnapshot => ({ id, projectPath });

describe('routeOpen', () => {
  it('focuses the window that already holds the project', () => {
    const windows = [home(1), holding(2, '/p/bracket'), holding(3, '/p/lantern')];
    expect(routeOpen(windows, '/p/bracket')).toEqual({ action: 'focus', windowId: 2 });
    expect(routeOpen(windows, '/p/lantern')).toEqual({ action: 'focus', windowId: 3 });
  });

  it('opens every other project in a window of its own, leaving the start screens where they are', () => {
    expect(routeOpen([home(1)], '/p/a')).toEqual({ action: 'new-window' });
    expect(routeOpen([home(1), home(2)], '/p/a')).toEqual({ action: 'new-window' });
    expect(routeOpen([holding(1, '/p/x')], '/p/a')).toEqual({ action: 'new-window' });
    expect(routeOpen([], '/p/a')).toEqual({ action: 'new-window' });
  });
});

describe('afterProject', () => {
  it('closes a window whose project is gone, unless it is the last one', () => {
    expect(afterProject(3)).toBe('close-window');
    expect(afterProject(2)).toBe('close-window');
    expect(afterProject(1)).toBe('show-start-screen');
  });
});

describe('menuEnablement', () => {
  it('enables project commands only while a project is up', () => {
    expect(menuEnablement('project')).toEqual({ projectCommands: true, windowCommands: true });
    for (const phase of ['home', 'opening', 'failed'] as const) {
      expect(menuEnablement(phase)).toEqual({ projectCommands: false, windowCommands: true });
    }
  });

  it('disables window commands with no window in front', () => {
    expect(menuEnablement(null)).toEqual({ projectCommands: false, windowCommands: false });
  });
});

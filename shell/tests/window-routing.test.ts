import { describe, expect, it } from 'vitest';
import { menuEnablement } from '../src/menu';
import { routeOpen, type WindowSnapshot } from '../src/window/registry';

const home = (id: number, focused = false): WindowSnapshot => ({ id, phase: 'home', projectPath: null, focused });
const showing = (id: number, projectPath: string, focused = false): WindowSnapshot => ({ id, phase: 'project', projectPath, focused });

describe('routeOpen', () => {
  it('focuses the window that already holds the project, from anywhere', () => {
    const windows = [home(1, true), showing(2, '/p/bracket')];
    for (const source of ['os', 'menu'] as const) {
      expect(routeOpen(windows, { source, path: '/p/bracket' })).toEqual({ action: 'focus', windowId: 2 });
    }
    expect(routeOpen(windows, { source: 'start-screen', windowId: 1, path: '/p/bracket' })).toEqual({ action: 'focus', windowId: 2 });
    const opening: WindowSnapshot = { id: 3, phase: 'opening', projectPath: '/p/lantern', focused: false };
    expect(routeOpen([opening], { source: 'os', path: '/p/lantern' })).toEqual({ action: 'focus', windowId: 3 });
  });

  it("opens a start screen's request in that window", () => {
    expect(routeOpen([home(1), home(2, true)], { source: 'start-screen', windowId: 1, path: '/p/a' })).toEqual({ action: 'open-in', windowId: 1 });
    const failed: WindowSnapshot = { id: 4, phase: 'failed', projectPath: '/p/b', focused: true };
    expect(routeOpen([failed], { source: 'start-screen', windowId: 4, path: '/p/a' })).toEqual({ action: 'open-in', windowId: 4 });
  });

  it('opens from the menu in the focused window when it is idle, otherwise in a new one', () => {
    expect(routeOpen([home(1, true)], { source: 'menu', path: '/p/a' })).toEqual({ action: 'open-in', windowId: 1 });
    expect(routeOpen([{ id: 1, phase: 'failed', projectPath: '/p/x', focused: true }], { source: 'menu', path: '/p/a' })).toEqual({
      action: 'open-in',
      windowId: 1,
    });
    expect(routeOpen([showing(1, '/p/x', true), home(2)], { source: 'menu', path: '/p/a' })).toEqual({ action: 'new-window' });
    expect(routeOpen([{ id: 1, phase: 'opening', projectPath: '/p/x', focused: true }], { source: 'menu', path: '/p/a' })).toEqual({
      action: 'new-window',
    });
  });

  it('sends an OS open to an idle start screen, the focused one first, else a new window', () => {
    expect(routeOpen([showing(1, '/p/x', true), home(2), home(3)], { source: 'os', path: '/p/a' })).toEqual({ action: 'open-in', windowId: 2 });
    expect(routeOpen([home(2), home(3, true)], { source: 'os', path: '/p/a' })).toEqual({ action: 'open-in', windowId: 3 });
    expect(routeOpen([showing(1, '/p/x')], { source: 'os', path: '/p/a' })).toEqual({ action: 'new-window' });
    expect(routeOpen([], { source: 'os', path: '/p/a' })).toEqual({ action: 'new-window' });
  });

  it('never sends an OS open into a failed window', () => {
    const failed: WindowSnapshot = { id: 1, phase: 'failed', projectPath: '/p/x', focused: true };
    expect(routeOpen([failed], { source: 'os', path: '/p/a' })).toEqual({ action: 'new-window' });
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

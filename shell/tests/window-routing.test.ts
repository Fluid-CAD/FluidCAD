import { describe, expect, it } from 'vitest';
import { menuEnablement } from '../src/menu';
import { routeOpen, type WindowSnapshot } from '../src/window/registry';

const home = (id: number, focused = false): WindowSnapshot => ({ id, phase: 'home', projectPath: null, focused });
const showing = (id: number, projectPath: string, focused = false): WindowSnapshot => ({ id, phase: 'project', projectPath, focused });
const opening = (id: number, projectPath: string, focused = false): WindowSnapshot => ({ id, phase: 'opening', projectPath, focused });
const failed = (id: number, projectPath: string, focused = false): WindowSnapshot => ({ id, phase: 'failed', projectPath, focused });

describe('routeOpen', () => {
  it('focuses the window that already holds the project, from anywhere', () => {
    const windows = [home(1, true), showing(2, '/p/bracket'), opening(3, '/p/lantern'), failed(4, '/p/hinge')];
    for (const path of ['/p/bracket', '/p/lantern', '/p/hinge']) {
      const holder = windows.find((window) => window.projectPath === path)!.id;
      for (const source of ['os', 'menu'] as const) {
        expect(routeOpen(windows, { source, path })).toEqual({ action: 'focus', windowId: holder });
      }
      expect(routeOpen(windows, { source: 'start-screen', windowId: 1, path })).toEqual({ action: 'focus', windowId: holder });
    }
  });

  it("opens a start screen's request in that window, which becomes the project", () => {
    expect(routeOpen([home(1), home(2, true)], { source: 'start-screen', windowId: 1, path: '/p/a' })).toEqual({ action: 'open-in', windowId: 1 });
    expect(routeOpen([showing(1, '/p/x', true), home(2)], { source: 'start-screen', windowId: 2, path: '/p/a' })).toEqual({
      action: 'open-in',
      windowId: 2,
    });
    // After a failure the overlay's start screen is still the window's own.
    expect(routeOpen([failed(4, '/p/b', true)], { source: 'start-screen', windowId: 4, path: '/p/a' })).toEqual({ action: 'open-in', windowId: 4 });
  });

  it('never replaces an open in progress, even for its own start screen', () => {
    expect(routeOpen([opening(1, '/p/x', true)], { source: 'start-screen', windowId: 1, path: '/p/a' })).toEqual({ action: 'new-window' });
  });

  it('gives a new window to a request whose start screen has closed meanwhile', () => {
    expect(routeOpen([home(2)], { source: 'start-screen', windowId: 1, path: '/p/a' })).toEqual({ action: 'new-window' });
  });

  it('opens from the menu in the focused window when it is idle, otherwise in a new one', () => {
    expect(routeOpen([home(1, true)], { source: 'menu', path: '/p/a' })).toEqual({ action: 'open-in', windowId: 1 });
    expect(routeOpen([failed(1, '/p/x', true)], { source: 'menu', path: '/p/a' })).toEqual({ action: 'open-in', windowId: 1 });
    expect(routeOpen([showing(1, '/p/x', true), home(2)], { source: 'menu', path: '/p/a' })).toEqual({ action: 'new-window' });
    expect(routeOpen([opening(1, '/p/x', true)], { source: 'menu', path: '/p/a' })).toEqual({ action: 'new-window' });
  });

  it('sends a menu open with no window in front to an idle start screen, else a new window', () => {
    expect(routeOpen([showing(1, '/p/x'), home(2)], { source: 'menu', path: '/p/a' })).toEqual({ action: 'open-in', windowId: 2 });
    expect(routeOpen([showing(1, '/p/x')], { source: 'menu', path: '/p/a' })).toEqual({ action: 'new-window' });
    expect(routeOpen([], { source: 'menu', path: '/p/a' })).toEqual({ action: 'new-window' });
  });

  it('sends an OS open to an idle start screen, the focused one first, else a new window', () => {
    expect(routeOpen([showing(1, '/p/x', true), home(2), home(3)], { source: 'os', path: '/p/a' })).toEqual({ action: 'open-in', windowId: 2 });
    expect(routeOpen([home(2), home(3, true)], { source: 'os', path: '/p/a' })).toEqual({ action: 'open-in', windowId: 3 });
    expect(routeOpen([showing(1, '/p/x')], { source: 'os', path: '/p/a' })).toEqual({ action: 'new-window' });
    expect(routeOpen([], { source: 'os', path: '/p/a' })).toEqual({ action: 'new-window' });
  });

  it('never sends an OS open into a failed window', () => {
    expect(routeOpen([failed(1, '/p/x', true)], { source: 'os', path: '/p/a' })).toEqual({ action: 'new-window' });
  });
});

describe('menuEnablement', () => {
  it('enables project commands only while a project is up', () => {
    expect(menuEnablement('project').projectCommands).toBe(true);
    for (const phase of ['home', 'opening', 'failed'] as const) {
      expect(menuEnablement(phase).projectCommands).toBe(false);
    }
  });

  it('offers the start screen to a window that is not on it', () => {
    for (const phase of ['project', 'opening', 'failed'] as const) {
      expect(menuEnablement(phase).startScreen).toBe(true);
    }
    expect(menuEnablement('home').startScreen).toBe(false);
  });

  it('enables the window commands in every phase', () => {
    for (const phase of ['home', 'opening', 'failed', 'project'] as const) {
      expect(menuEnablement(phase).windowCommands).toBe(true);
    }
  });

  it('disables everything with no window in front', () => {
    expect(menuEnablement(null)).toEqual({ projectCommands: false, startScreen: false, windowCommands: false });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { ProjectTabs, projectOfTab, projectTabName, projectTabUrl } from '../../src/start/project-tabs';

/**
 * `npx fluidcad` opens each project in a tab named after it, so opening it
 * again finds that tab: forward if the project runs, sent back to the start
 * page if its engine is gone.
 */

const ORIGIN = 'http://localhost:3100';

function fakeTab(href: string | null) {
  return {
    closed: false,
    focus: vi.fn(),
    close: vi.fn(function (this: { closed: boolean }) {
      this.closed = true;
    }),
    location: {
      get href(): string {
        if (href === null) {
          throw new DOMException('Blocked a frame with origin', 'SecurityError');
        }
        return href;
      },
      replace: vi.fn(),
    },
  };
}

describe('tab URLs and names', () => {
  it("carry the project's path, and whether to set it up first", () => {
    expect(projectTabUrl('/home/you/cad/bracket')).toBe('/?project=%2Fhome%2Fyou%2Fcad%2Fbracket');
    expect(projectTabUrl('C:\\cad\\gear box', { create: true })).toBe('/?project=C%3A%5Ccad%5Cgear+box&create=1');
    expect(projectOfTab('?project=%2Fhome%2Fyou%2Fcad%2Fbracket')).toEqual({ path: '/home/you/cad/bracket', create: false });
    expect(projectOfTab('?project=C%3A%5Ccad%5Cgear+box&create=1')).toEqual({ path: 'C:\\cad\\gear box', create: true });
    expect(projectOfTab('')).toBeNull();
  });

  it('names a tab the same way every time, and every project differently', () => {
    expect(projectTabName('/home/you/cad/bracket')).toBe(projectTabName('/home/you/cad/bracket'));
    expect(projectTabName('/home/you/cad/bracket')).not.toBe(projectTabName('/home/you/cad/lantern'));
    expect(projectTabName('/a')).toMatch(/^fluidcad-project-[0-9a-f]{8}$/);
  });
});

describe('ProjectTabs', () => {
  it('opens a project that is not running in its named tab, reusing a stale one', () => {
    const tab = fakeTab(null);
    const open = vi.fn(() => tab as unknown as Window);
    const tabs = new ProjectTabs({ open, location: { origin: ORIGIN } });
    expect(tabs.show('/cad/bracket', { running: false, create: true })).toBe(true);
    expect(open).toHaveBeenCalledWith(`${ORIGIN}/?project=%2Fcad%2Fbracket&create=1`, projectTabName('/cad/bracket'));
  });

  it("brings a running project's tab forward without reloading it", () => {
    const tab = fakeTab(null);
    const open = vi.fn(() => tab as unknown as Window);
    const tabs = new ProjectTabs({ open, location: { origin: ORIGIN } });
    tabs.show('/cad/bracket', { running: true });
    expect(open).toHaveBeenCalledWith('', projectTabName('/cad/bracket'));
    expect(tab.focus).toHaveBeenCalled();
    expect(tab.location.replace).not.toHaveBeenCalled();
  });

  it('sends a blank tab (no tab had the name) to the start page for the running project', () => {
    const tab = fakeTab('about:blank');
    const tabs = new ProjectTabs({ open: () => tab as unknown as Window, location: { origin: ORIGIN } });
    tabs.show('/cad/bracket', { running: true });
    expect(tab.location.replace).toHaveBeenCalledWith(`${ORIGIN}/?project=%2Fcad%2Fbracket`);
  });

  it('says so when the browser blocks the tab', () => {
    const tabs = new ProjectTabs({ open: () => null, location: { origin: ORIGIN } });
    expect(tabs.show('/cad/bracket', { running: false })).toBe(false);
    expect(tabs.show('/cad/bracket', { running: true })).toBe(false);
  });

  it('closes, or sends back for a reopen, only a tab it opened that is still there', () => {
    const tab = fakeTab(null);
    const tabs = new ProjectTabs({ open: () => tab as unknown as Window, location: { origin: ORIGIN } });
    tabs.reopen('/cad/bracket');
    tabs.close('/cad/bracket');
    expect(tab.location.replace).not.toHaveBeenCalled();
    expect(tab.close).not.toHaveBeenCalled();

    tabs.show('/cad/bracket', { running: false });
    tabs.reopen('/cad/bracket');
    expect(tab.location.replace).toHaveBeenCalledWith(`${ORIGIN}/?project=%2Fcad%2Fbracket`);
    tabs.close('/cad/bracket');
    expect(tab.close).toHaveBeenCalledTimes(1);
    tabs.close('/cad/bracket');
    expect(tab.close).toHaveBeenCalledTimes(1);
  });
});

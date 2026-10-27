// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { SceneLook, onThemeChange, themeColors } from '../src/scene/theme-colors';

/**
 * A capture "always in the light look" on a dark page (H9b): the scene's
 * colours switch to the light theme's for the length of the shot and come
 * back after, while the page itself never changes theme.
 */
describe('SceneLook.during', () => {
  const style = document.createElement('style');
  const disposers: (() => void)[] = [];

  afterEach(() => {
    for (const dispose of disposers.splice(0)) {
      dispose();
    }
    style.remove();
    // The observer reads the fallbacks again: the defaults the other tests in this document see.
    document.documentElement.removeAttribute('data-theme');
  });

  function themes(): void {
    style.textContent = `
      [data-theme=fluidcad-dark] { --scene-face-color: #969696; --scene-edge-color: #000000; --color-base-100: #1e1e1e; }
      [data-theme=fluidcad-light] { --scene-face-color: #b8b8b8; --scene-edge-color: #555555; --color-base-100: #ffffff; }
    `;
    document.head.append(style);
    document.documentElement.setAttribute('data-theme', 'fluidcad-dark');
  }

  it("takes the light theme's scene colours for the call, then the page's again", () => {
    themes();
    expect(themeColors.faceColor.getHexString()).toBe('969696');
    expect(themeColors.backgroundColor.getHexString()).toBe('1e1e1e');

    const seen = SceneLook.during('light', () => ({
      face: themeColors.faceColor.getHexString(),
      edge: themeColors.edgeColor.getHexString(),
      background: themeColors.backgroundColor.getHexString(),
      pageTheme: document.documentElement.getAttribute('data-theme'),
    }));

    expect(seen).toEqual({ face: 'b8b8b8', edge: '555555', background: 'ffffff', pageTheme: 'fluidcad-dark' });
    expect(themeColors.faceColor.getHexString()).toBe('969696');
    expect(themeColors.backgroundColor.getHexString()).toBe('1e1e1e');
    // The probe it read the light theme from is gone.
    expect(document.querySelectorAll('[data-theme=fluidcad-light]')).toHaveLength(0);
  });

  it('lets every scene listener rebuild in the look, and again after', () => {
    themes();
    const faces: string[] = [];
    disposers.push(onThemeChange(() => faces.push(themeColors.faceColor.getHexString())));
    SceneLook.during('light', () => faces.push('shot'));
    expect(faces).toEqual(['b8b8b8', 'shot', '969696']);
  });

  it('puts the colours back when the shot throws', () => {
    themes();
    expect(() => SceneLook.during('light', () => {
      throw new Error('no WebGL');
    })).toThrow('no WebGL');
    expect(themeColors.faceColor.getHexString()).toBe('969696');
  });
});

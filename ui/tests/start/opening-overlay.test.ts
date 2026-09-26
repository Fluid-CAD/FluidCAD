// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpeningOverlay } from '../../src/start/opening-overlay';

const target = { path: '/home/you/cad/bracket', name: 'bracket' };

function mount() {
  const handlers = { cancel: vi.fn(), retry: vi.fn() };
  const overlay = new OpeningOverlay(handlers);
  document.body.appendChild(overlay.element);
  return { overlay, handlers };
}

function button(overlay: OpeningOverlay, label: string): HTMLButtonElement {
  return [...overlay.element.querySelectorAll('button')].find((b) => b.textContent === label)!;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('OpeningOverlay.describe', () => {
  it('says what each step is doing', () => {
    expect(OpeningOverlay.describe(target, { step: 'resolving' })).toEqual({
      line: 'Finding the engine for this project…',
      detail: target.path,
      fraction: null,
    });
    expect(
      OpeningOverlay.describe(target, { step: 'downloading', version: '0.0.42', receivedBytes: 15_728_640, totalBytes: 31_457_280 }),
    ).toEqual({ line: 'Downloading engine 0.0.42…', detail: '15.0 MB of 30.0 MB (50%)', fraction: 0.5 });
    expect(OpeningOverlay.describe(target, { step: 'downloading', version: '0.0.42', receivedBytes: 0, totalBytes: null }).detail).toBe(
      'This project pins a version that is not installed yet.',
    );
    expect(OpeningOverlay.describe(target, { step: 'starting', version: '0.0.41', source: 'project' }).detail).toBe(
      "Using this project's own install.",
    );
    expect(OpeningOverlay.describe(target, { step: 'starting', version: '0.0.45', source: 'builtin' }).detail).toBe('');
  });
});

describe('OpeningOverlay', () => {
  it('stays hidden on the start screen itself', () => {
    const { overlay } = mount();
    overlay.render({ phase: 'home' });
    expect(overlay.visible).toBe(false);
    expect(overlay.element.classList.contains('hidden')).toBe(true);
  });

  it('shows progress with a Cancel while opening', () => {
    const { overlay, handlers } = mount();
    overlay.render({ phase: 'opening', project: target, status: { step: 'downloading', version: '0.0.42', receivedBytes: 1, totalBytes: 4 } });
    expect(overlay.visible).toBe(true);
    expect(overlay.element.textContent).toContain('Opening bracket…');
    expect(overlay.element.querySelector('progress')!.value).toBe(0.25);
    expect(document.activeElement).toBe(button(overlay, 'Cancel'));
    button(overlay, 'Cancel').click();
    expect(handlers.cancel).toHaveBeenCalled();
  });

  it('keeps an indeterminate bar while the size is unknown', () => {
    const { overlay } = mount();
    overlay.render({ phase: 'opening', project: target, status: { step: 'resolving' } });
    expect(overlay.element.querySelector('progress')!.hasAttribute('value')).toBe(false);
  });

  it('shows the error with Try again and Back to projects after a failure', () => {
    const { overlay, handlers } = mount();
    overlay.render({ phase: 'failed', project: target, message: 'The engine exited with code 1.' });
    expect(overlay.element.textContent).toContain('bracket could not be opened');
    expect(overlay.element.querySelector('[data-message]')!.textContent).toBe('The engine exited with code 1.');
    expect(document.activeElement).toBe(button(overlay, 'Try again'));
    button(overlay, 'Try again').click();
    button(overlay, 'Back to projects').click();
    expect(handlers.retry).toHaveBeenCalled();
    expect(handlers.cancel).toHaveBeenCalled();
  });
});

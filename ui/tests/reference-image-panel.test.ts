// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReferenceImagePanel } from '../src/interactive/tools/reference-image-panel';
import { sceneUnit } from '../src/units/scene-unit';

// The Reference image dialog's form state: the aspect lock deriving one size
// from the other through the picture's pixels, which sizes the written
// record carries, the opacity slider, validation, and the Remove button.

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const panel = new ReferenceImagePanel(container);
  const root = container.querySelector<HTMLElement>('#fluidcad-reference-image-panel')!;
  const field = (role: string) => root.querySelector<HTMLInputElement>(`[data-role="${role}"]`)!;
  const type = (role: string, value: string) => {
    field(role).value = value;
    field(role).dispatchEvent(new Event('input', { bubbles: true }));
  };
  const toggleLock = (on: boolean) => {
    field('lock').checked = on;
    field('lock').dispatchEvent(new Event('change', { bubbles: true }));
  };
  return { panel, root, field, type, toggleLock };
}

afterEach(() => {
  document.body.innerHTML = '';
  sceneUnit.set('mm');
});

describe('ReferenceImagePanel', () => {
  it('needs a picture before Apply and values()', () => {
    const { panel, field } = mount();
    expect(field('apply').disabled).toBe(true);
    expect(panel.values()).toEqual({ error: 'Choose an image first.' });
    panel.setFile('side.png', { width: 400, height: 200 });
    expect(field('apply').disabled).toBe(false);
    expect(field('file-label').textContent).toBe('side.png · 400×200 px');
  });

  it('derives the other size through the pixel aspect while locked, and writes only the typed one', () => {
    const { panel, field, type } = mount();
    panel.setFile('side.png', { width: 400, height: 200 });
    // The mm default width (100) got a height on setFile.
    expect(field('height').value).toBe('50');
    type('width', '120');
    expect(field('height').value).toBe('60');
    expect(panel.values()).toEqual({ values: { src: '', width: 120, at: [0, 0], angle: 0, opacity: 0.5 } });
    type('height', '30');
    expect(field('width').value).toBe('60');
    expect(panel.values()).toEqual({ values: { src: '', height: 30, at: [0, 0], angle: 0, opacity: 0.5 } });
  });

  it('writes both sizes once the lock is off, and re-derives when it comes back on', () => {
    const { panel, field, type, toggleLock } = mount();
    panel.setFile('side.png', { width: 400, height: 200 });
    toggleLock(false);
    type('width', '120');
    type('height', '10');
    expect(field('width').value).toBe('120');
    expect(panel.values()).toEqual({ values: { src: '', width: 120, height: 10, at: [0, 0], angle: 0, opacity: 0.5 } });
    toggleLock(true);
    // The last typed side (height) stands; width follows it.
    expect(field('width').value).toBe('20');
    expect(panel.values()).toEqual({ values: { src: '', height: 10, at: [0, 0], angle: 0, opacity: 0.5 } });
  });

  it('seeds from a written record: its sizes, centre, angle, opacity, and Remove shows', () => {
    const { panel, field } = mount();
    expect(field('remove').classList.contains('hidden')).toBe(true);
    panel.setValues({ src: 'images/scan.jpg', height: 30, at: [10, -5], angle: 15, opacity: 0.25 }, { width: 300, height: 100 });
    expect(field('remove').classList.contains('hidden')).toBe(false);
    expect(field('file-label').textContent).toBe('scan.jpg · 300×100 px');
    expect(field('height').value).toBe('30');
    expect(field('width').value).toBe('90');
    expect(field('lock').checked).toBe(true);
    expect(field('x').value).toBe('10');
    expect(field('y').value).toBe('-5');
    expect(field('angle').value).toBe('15');
    expect(field('opacity').value).toBe('25');
    expect(field('opacity-label').textContent).toBe('25%');
    expect(panel.values()).toEqual({ values: { src: 'images/scan.jpg', height: 30, at: [10, -5], angle: 15, opacity: 0.25 } });

    // An explicit pair unlocks the aspect.
    panel.setValues({ src: 'a.png', width: 80, height: 10, at: [0, 0], angle: 0, opacity: 1 }, null);
    expect(field('lock').checked).toBe(false);
    expect(panel.values()).toEqual({ values: { src: 'a.png', width: 80, height: 10, at: [0, 0], angle: 0, opacity: 1 } });
  });

  it('fills a seeded one-sided size once the pixel size arrives', () => {
    const { panel, field } = mount();
    panel.setValues({ src: 'a.png', width: 80, at: [0, 0], angle: 0, opacity: 0.5 }, null);
    panel.setPixelSize({ width: 200, height: 100 });
    expect(field('height').value).toBe('40');
    expect(field('file-label').textContent).toBe('a.png · 200×100 px');
  });

  it('maps the slider to 0…1, places the centre from a click, and fires onChange per edit', () => {
    const { panel, field, type } = mount();
    const changes = vi.fn();
    panel.onChange = changes;
    panel.setFile('a.png', { width: 1, height: 1 });
    type('opacity', '70');
    expect(field('opacity-label').textContent).toBe('70%');
    panel.setCenter(12.3456, -7);
    type('angle', '-30');
    const read = panel.values();
    expect('values' in read && read.values.opacity).toBe(0.7);
    expect('values' in read && read.values.at).toEqual([12.346, -7]);
    expect('values' in read && read.values.angle).toBe(-30);
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it('refuses a non-positive size and non-numeric fields, naming the unit', () => {
    const { panel, type } = mount();
    panel.setFile('a.png', { width: 400, height: 200 });
    type('width', '0');
    expect(panel.values()).toEqual({ error: 'Width must be a positive length in mm.' });
    type('width', '10');
    type('x', '');
    expect(panel.values()).toEqual({ error: 'Centre X and Y must be lengths in mm.' });
    type('x', '1');
    type('angle', 'abc');
    expect(panel.values()).toEqual({ error: 'Angle must be a number of degrees.' });
  });

  it('routes the footer buttons and the file picker', () => {
    const { panel, field } = mount();
    const onApply = vi.fn();
    const onExit = vi.fn();
    const onRemove = vi.fn();
    const onFile = vi.fn();
    panel.onApply = onApply;
    panel.onExit = onExit;
    panel.onRemove = onRemove;
    panel.onFile = onFile;
    field('exit').click();
    field('remove').click();
    panel.setFile('a.png', { width: 1, height: 1 });
    field('apply').click();
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledTimes(1);

    const input = field('file');
    const file = new File([new Uint8Array([1, 2, 3])], 'pic.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onFile).toHaveBeenCalledWith(file);
  });
});

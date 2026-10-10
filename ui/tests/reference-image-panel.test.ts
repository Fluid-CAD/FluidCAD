// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReferenceImagePanel } from '../src/interactive/tools/reference-image-panel';
import { sceneUnit } from '../src/units/scene-unit';

// The Reference image dialog holds only what the viewport cannot do: the
// file, the opacity, the calibration gesture's state, Apply /
// Cancel, and a read-out of the size the handles set.

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const panel = new ReferenceImagePanel(container);
  const root = container.querySelector<HTMLElement>('#fluidcad-reference-image-panel')!;
  const field = (role: string) => root.querySelector<HTMLInputElement>(`[data-role="${role}"]`)!;
  return { panel, root, field };
}

afterEach(() => {
  document.body.innerHTML = '';
  sceneUnit.set('mm');
});

describe('ReferenceImagePanel', () => {
  it('has no size, centre or angle fields: those are viewport gestures', () => {
    const { root } = mount();
    for (const role of ['width', 'height', 'x', 'y', 'angle', 'lock']) {
      expect(root.querySelector(`[data-role="${role}"]`)).toBeNull();
    }
  });

  it('needs a picture before Apply and Calibrate', () => {
    const { panel, field } = mount();
    expect(field('apply').disabled).toBe(true);
    expect(field('calibrate').disabled).toBe(true);
    panel.setFile('side.png', { width: 400, height: 200 });
    expect(field('apply').disabled).toBe(false);
    expect(field('calibrate').disabled).toBe(false);
    expect(field('file-label').textContent).toBe('side.png · 400×200 px');
    panel.setBusy(true);
    expect(field('apply').disabled).toBe(true);
  });

  it('reads out the size, centre and angle in the document unit', () => {
    const { panel, field } = mount();
    panel.setReadout({ width: 90, height: 45 }, [5, -2.5], 0);
    expect(field('readout').textContent).toBe('90.00 × 45.00 mm at 5.00, -2.50');
    panel.setReadout({ width: 90, height: 45 }, [0, 0], 12.34);
    expect(field('readout').textContent).toBe('90.00 × 45.00 mm at 0.00, 0.00 · 12.3°');
  });

  it('maps the slider to 0…1 both ways and fires onOpacity', () => {
    const { panel, field } = mount();
    const onOpacity = vi.fn();
    panel.onOpacity = onOpacity;
    panel.setOpacity(0.25);
    expect(field('opacity').value).toBe('25');
    expect(field('opacity-label').textContent).toBe('25%');
    field('opacity').value = '70';
    field('opacity').dispatchEvent(new Event('input', { bubbles: true }));
    expect(onOpacity).toHaveBeenCalledWith(0.7);
    expect(panel.opacity).toBe(0.7);
  });

  it('shows the calibration hint per state and turns the button into its cancel', () => {
    const { panel, field } = mount();
    panel.setFile('a.png', null);
    expect(field('hint').classList.contains('hidden')).toBe(true);
    panel.setCalibrateState('first');
    expect(field('calibrate').textContent).toBe('Cancel calibration');
    expect(field('hint').textContent).toBe('Click the first point on the picture.');
    panel.setCalibrateState('second');
    expect(field('hint').textContent).toBe('Click the second point.');
    panel.setCalibrateState('distance');
    expect(field('hint').textContent).toMatch(/real distance/);
    panel.setCalibrateState('idle');
    expect(field('calibrate').textContent).toBe('Calibrate…');
    expect(field('hint').classList.contains('hidden')).toBe(true);
  });

  it('routes the buttons and the file picker', () => {
    const { panel, field } = mount();
    const onApply = vi.fn();
    const onExit = vi.fn();
    const onCalibrate = vi.fn();
    const onFile = vi.fn();
    panel.onApply = onApply;
    panel.onExit = onExit;
    panel.onCalibrate = onCalibrate;
    panel.onFile = onFile;
    expect(field('remove')).toBeNull();
    field('exit').click();
    panel.setFile('a.png', { width: 1, height: 1 });
    field('apply').click();
    field('calibrate').click();
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onCalibrate).toHaveBeenCalledTimes(1);

    const input = field('file');
    const file = new File([new Uint8Array([1, 2, 3])], 'pic.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onFile).toHaveBeenCalledWith(file);
  });
});

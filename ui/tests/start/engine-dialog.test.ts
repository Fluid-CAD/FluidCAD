// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineDialog } from '../../src/start/engine-dialog';
import type { EngineOptions, StartProject, UpgradeDiff, UpgradePreview } from '../../src/start/host';

const lagging: StartProject = {
  path: '/home/you/cad/lantern',
  name: 'lantern',
  engine: '0.0.42',
  engineSource: 'pin',
  latest: false,
  upgradeTo: '0.0.45',
  lastOpenedAt: new Date().toISOString(),
  open: false,
  thumbnail: null,
};

function options(current: string | null): EngineOptions {
  return {
    current,
    currentSource: 'pin',
    latest: '0.0.45',
    choices: [
      { version: '0.0.45', builtin: true, installed: true },
      { version: '0.0.44', builtin: false, installed: true },
    ],
  };
}

const diff: UpgradeDiff = {
  from: '0.0.42',
  to: '0.0.45',
  identical: false,
  skipped: ['c.part.js'],
  models: [
    { file: 'a.part.js', status: 'changed', notes: ['Volume moved'] },
    { file: 'b.part.js', status: 'identical', notes: [] },
  ],
};

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function mount(current: string | null = '0.0.42') {
  const host = {
    engineOptions: vi.fn(async () => options(current)),
    previewUpgrade: vi.fn(async (): Promise<UpgradePreview> => ({ diff })),
    applyPin: vi.fn(async () => ({ ok: true })),
  };
  const applied = vi.fn();
  const dialog = new EngineDialog(host, { applied });
  document.body.appendChild(dialog.element);
  const q = <T extends HTMLElement>(ref: string) => dialog.element.querySelector<T>(`[data-ref="${ref}"]`)!;
  const radio = (value: string) =>
    [...dialog.element.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((r) => r.value === value)!;
  return { dialog, host, applied, q, radio };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('EngineDialog', () => {
  it('preselects the latest engine when the pin lags it, and focuses it', async () => {
    const { dialog, q, radio } = mount('0.0.42');
    await dialog.open(lagging);
    expect(dialog.isOpen()).toBe(true);
    expect(radio('0.0.45').checked).toBe(true);
    expect(document.activeElement).toBe(radio('0.0.45'));
    expect(q('apply').textContent).toBe('Switch to 0.0.45');
    expect(q('lede').textContent).toBe('lantern · currently 0.0.42 (fluidcad.json)');
  });

  it('preselects the current engine when it is already the latest, with nothing to switch to', async () => {
    const { dialog, q, radio } = mount('0.0.45');
    await dialog.open({ ...lagging, engine: '0.0.45', upgradeTo: null });
    expect(radio('0.0.45').checked).toBe(true);
    expect(q<HTMLButtonElement>('apply').disabled).toBe(true);
    expect(q<HTMLButtonElement>('compare').disabled).toBe(true);
  });

  it('accepts a typed version only in the release shape', async () => {
    const { dialog, q } = mount('0.0.42');
    await dialog.open(lagging);
    const other = dialog.element.querySelector<HTMLInputElement>('input[type="text"]')!;
    other.dispatchEvent(new Event('focus'));
    for (const [typed, valid] of [['0.0', false], ['0.0.42', false], ['v0.0.40', false], ['0.0.40', true], ['0.1.0-beta.1', true]] as const) {
      other.value = typed;
      other.dispatchEvent(new Event('input'));
      expect(q<HTMLButtonElement>('apply').disabled).toBe(!valid);
    }
    expect(q('apply').textContent).toBe('Switch to 0.1.0-beta.1');
  });

  it('shows progress while comparing, then the diff, and blocks Escape meanwhile', async () => {
    const { dialog, host, q } = mount('0.0.42');
    const pending = deferred<UpgradePreview>();
    host.previewUpgrade.mockReturnValueOnce(pending.promise);
    await dialog.open(lagging);
    q('compare').click();
    expect(q<HTMLButtonElement>('cancel').disabled).toBe(true);
    dialog.progress({ workspacePath: lagging.path, message: 'Building with engine 0.0.45…' });
    expect(q('result').textContent).toBe('Building with engine 0.0.45…');
    dialog.progress({ workspacePath: '/elsewhere', message: 'not ours' });
    expect(q('result').textContent).toBe('Building with engine 0.0.45…');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    dialog.element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(dialog.isOpen()).toBe(true);

    pending.resolve({ diff });
    await flush();
    const rows = [...dialog.element.querySelectorAll<HTMLElement>('[data-status]')];
    expect(rows.map((row) => row.dataset.status)).toEqual(['changed', 'identical']);
    expect(q('result').textContent).toContain('Engine 0.0.45 changes this project.');
    expect(q('result').textContent).toContain('1 more model(s) were not compared: c.part.js');
    expect(q<HTMLButtonElement>('cancel').disabled).toBe(false);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(dialog.isOpen()).toBe(false);
  });

  it('says so when the comparison fails', async () => {
    const { dialog, host, q } = mount('0.0.42');
    host.previewUpgrade.mockResolvedValueOnce({ error: 'Engine 0.0.45 could not be downloaded.' });
    await dialog.open(lagging);
    q('compare').click();
    await flush();
    expect(q('result').querySelector('[data-tone="error"]')!.textContent).toBe('Engine 0.0.45 could not be downloaded.');
  });

  it('switches, closes and tells the page to refresh', async () => {
    const { dialog, host, applied, q } = mount('0.0.42');
    await dialog.open(lagging);
    q('apply').click();
    await flush();
    expect(host.applyPin).toHaveBeenCalledWith(lagging.path, '0.0.45');
    expect(dialog.isOpen()).toBe(false);
    expect(applied).toHaveBeenCalled();
  });

  it('stays open with the error when the switch fails', async () => {
    const { dialog, host, applied, q } = mount('0.0.42');
    host.applyPin.mockResolvedValueOnce({ ok: false, error: 'The pin could not be written.' });
    await dialog.open(lagging);
    q('apply').click();
    await flush();
    expect(dialog.isOpen()).toBe(true);
    expect(applied).not.toHaveBeenCalled();
    expect(q('result').textContent).toBe('The pin could not be written.');
  });
});

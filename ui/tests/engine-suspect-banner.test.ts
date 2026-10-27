// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineSuspectBanner, type EngineSuspectReport } from '../src/ui/engine-suspect-banner';

// The banner a suspect engine raises once its OpenCascade kernel trapped:
// what happened, and the restart this host offers — the desktop shell's, the
// engine's own (`fluidcad serve` starts a fresh one), or a sentence saying
// how to restart by hand.

afterEach(() => {
  document.body.innerHTML = '';
});

const REPORT: EngineSuspectReport = {
  message: 'Twist crashed the OpenCascade kernel (memory access out of bounds). Twist uses raw OpenCascade (fluidcad/sdk/occt), the likeliest cause.',
  featureName: 'Twist',
  usesOcct: true,
  traps: 1,
  restart: 'engine',
  hint: null,
};

function mount(restarter: Partial<ConstructorParameters<typeof EngineSuspectBanner>[1]> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const engine = vi.fn(async () => ({ ok: true as const }));
  const banner = new EngineSuspectBanner(container, { desktop: null, engine, ...restarter });
  const el = container.querySelector<HTMLElement>('#fluidcad-engine-suspect-banner')!;
  const message = () => el.querySelector('[data-ref="message"]')!.textContent;
  const hint = () => el.querySelector<HTMLElement>('[data-ref="hint"]')!;
  const button = el.querySelector<HTMLButtonElement>('[data-ref="restart"]')!;
  return { banner, el, message, hint, button, engine };
}

describe('the suspect engine banner', () => {
  it('stays hidden until the engine reports itself suspect, then says what trapped', () => {
    const { banner, el, message } = mount();
    expect(banner.isVisible).toBe(false);
    banner.show(REPORT);
    expect(banner.isVisible).toBe(true);
    expect(el.getAttribute('role')).toBe('alert');
    expect(message()).toBe(REPORT.message);
    banner.show({ ...REPORT, traps: 3 });
    expect(message()).toBe(`${REPORT.message} (3 crashes so far.)`);
  });

  it('restarts an engine that restarts itself, and goes on a fresh connection', async () => {
    const { banner, button, engine } = mount();
    banner.show(REPORT);
    expect(button.classList.contains('hidden')).toBe(false);
    button.click();
    expect(engine).toHaveBeenCalledOnce();
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Restarting…');
    // A second click while restarting asks nothing more.
    button.click();
    await vi.waitFor(() => expect(engine).toHaveBeenCalledOnce());
    banner.hide();
    expect(banner.isVisible).toBe(false);
    expect(button.disabled).toBe(false);
  });

  it('says why when the engine refuses, and offers the restart again', async () => {
    const engine = vi.fn(async () => ({ ok: false as const, error: 'This engine can\'t restart itself.' }));
    const { banner, button, hint } = mount({ engine });
    banner.show(REPORT);
    button.click();
    await vi.waitFor(() => expect(hint().textContent).toBe('This engine can\'t restart itself.'));
    expect(hint().classList.contains('hidden')).toBe(false);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Restart engine');
  });

  it("uses the desktop shell's own restart there, whatever the engine says", async () => {
    const desktop = vi.fn(async () => {});
    const { banner, button, engine } = mount({ desktop });
    banner.show({ ...REPORT, restart: null, hint: 'Restart the engine: close the project and open it again.' });
    expect(button.classList.contains('hidden')).toBe(false);
    button.click();
    expect(desktop).toHaveBeenCalledOnce();
    expect(engine).not.toHaveBeenCalled();
  });

  it('says how to restart by hand where nothing can restart the engine from the page', () => {
    const { banner, button, hint } = mount();
    banner.show({ ...REPORT, restart: null, hint: 'Restart the engine: run :FluidCadStop, then :FluidCadStart, in Neovim.' });
    expect(button.classList.contains('hidden')).toBe(true);
    expect(hint().textContent).toBe('Restart the engine: run :FluidCadStop, then :FluidCadStart, in Neovim.');
    expect(hint().classList.contains('hidden')).toBe(false);
  });
});

// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { Navbar } from '../src/ui/navbar/navbar';

// Workbench filtering: 'part' groups hide in assembly mode and vice versa;
// a mode-'all' group (the Connector tool) stays on the bar in BOTH — the
// a90ba6b6 mode filter had silently dropped it from assembly files.

beforeAll(() => {
  // jsdom has no ResizeObserver/rAF; the scroller only measures with them.
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (globalThis as any).requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0);
  (globalThis as any).cancelAnimationFrame ??= (id: number) => clearTimeout(id);
});

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const navbar = new Navbar(container);
  const hosts = {
    part: navbar.addGroup('modify'),
    assembly: navbar.addGroup('assembly-tools', { mode: 'assembly' }),
    all: navbar.addGroup('connector', { mode: 'all' }),
  };
  return { navbar, hosts };
}

const hidden = (host: HTMLElement) => host.classList.contains('hidden');

describe('navbar workbench modes', () => {
  it('shows part + all groups in part mode, assembly + all in assembly mode', () => {
    const { navbar, hosts } = mount();
    expect(hidden(hosts.part)).toBe(false);
    expect(hidden(hosts.assembly)).toBe(true);
    expect(hidden(hosts.all)).toBe(false);

    navbar.setMode('assembly');
    expect(hidden(hosts.part)).toBe(true);
    expect(hidden(hosts.assembly)).toBe(false);
    expect(hidden(hosts.all)).toBe(false);

    navbar.setMode('part');
    expect(hidden(hosts.part)).toBe(false);
    expect(hidden(hosts.assembly)).toBe(true);
    expect(hidden(hosts.all)).toBe(false);
  });

  it('keeps visibility votes working on an all-mode group across mode flips', () => {
    const { navbar, hosts } = mount();
    navbar.setGroupVisible('connector', false);
    expect(hidden(hosts.all)).toBe(true);
    navbar.setMode('assembly');
    expect(hidden(hosts.all)).toBe(true);
    navbar.setGroupVisible('connector', true);
    expect(hidden(hosts.all)).toBe(false);
  });

  it('an exclusive part-mode takeover does not suppress groups in assembly mode', () => {
    const { navbar, hosts } = mount();
    navbar.addGroup('sketch', { exclusive: true, visible: true });
    // Part mode: the exclusive group owns the bar.
    expect(hidden(hosts.part)).toBe(true);
    expect(hidden(hosts.all)).toBe(true);
    // Assembly mode: the part-mode exclusive is off-bar — assembly + all show.
    navbar.setMode('assembly');
    expect(hidden(hosts.assembly)).toBe(false);
    expect(hidden(hosts.all)).toBe(false);
  });
});

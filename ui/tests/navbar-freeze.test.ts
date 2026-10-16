// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { Navbar } from '../src/ui/navbar/navbar';

// A feature edit session freezes the bar: the layout captured at the last
// full render stays on screen (the session's rollback render hides most tools
// underneath), every group goes inert, and unfreezing lands on whatever the
// owners set meanwhile.

beforeAll(() => {
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
  const create = navbar.addGroup('create', { immune: true });
  const modify = navbar.addGroup('modify');
  const sketch = navbar.addGroup('sketch', { visible: false, exclusive: true });
  const button = (host: HTMLElement) => {
    const wrap = document.createElement('span');
    wrap.className = 'tooltip shrink-0';
    wrap.appendChild(document.createElement('button'));
    host.appendChild(wrap);
    return wrap;
  };
  return { navbar, create, modify, sketch, extrude: button(create), fillet: button(modify), line: button(sketch) };
}

const hiddenClass = (el: HTMLElement) => el.classList.contains('hidden');
const inlineDisplay = (el: HTMLElement) => el.style.getPropertyValue('display');

describe('navbar freeze', () => {
  it('keeps the captured layout while the owners hide their tools, then releases to their state', () => {
    const { navbar, modify, fillet } = mount();
    navbar.captureLayout();

    // The edit's rollback render: the modify group and its button hide.
    navbar.setGroupVisible('modify', false);
    fillet.classList.add('hidden');
    expect(hiddenClass(modify)).toBe(true);

    navbar.freeze();
    expect(navbar.isFrozen).toBe(true);
    expect(inlineDisplay(modify)).not.toBe('none');
    expect(inlineDisplay(modify)).not.toBe('');
    expect(inlineDisplay(fillet)).not.toBe('none');
    expect(inlineDisplay(fillet)).not.toBe('');
    expect(modify.hasAttribute('inert')).toBe(true);

    // Still rolled back when the session ends: the owners' state shows again.
    navbar.unfreeze();
    expect(navbar.isFrozen).toBe(false);
    expect(inlineDisplay(modify)).toBe('');
    expect(inlineDisplay(fillet)).toBe('');
    expect(hiddenClass(modify)).toBe(true);
    expect(modify.hasAttribute('inert')).toBe(false);
  });

  it('hides tools that were hidden at capture even when an owner shows them mid-freeze', () => {
    const { navbar, modify, fillet } = mount();
    navbar.setGroupVisible('modify', false);
    navbar.captureLayout();

    navbar.freeze();
    navbar.setGroupVisible('modify', true);
    expect(inlineDisplay(modify)).toBe('none');
    expect(inlineDisplay(fillet)).not.toBe('none');

    navbar.unfreeze();
    expect(hiddenClass(modify)).toBe(false);
  });

  it('does not capture while the sketch toolbar owns the bar, nor while frozen', () => {
    const { navbar, modify } = mount();
    navbar.captureLayout();

    navbar.setGroupVisible('sketch', true);
    navbar.setGroupVisible('modify', false);
    navbar.captureLayout(); // skipped: exclusive group up
    navbar.setGroupVisible('sketch', false);

    navbar.freeze();
    expect(inlineDisplay(modify)).not.toBe('none');
    navbar.captureLayout(); // skipped: frozen
    navbar.unfreeze();
    navbar.setGroupVisible('modify', false);
    navbar.freeze();
    expect(inlineDisplay(modify)).not.toBe('none');
  });

  it('freezes without a capture by only going inert', () => {
    const { navbar, modify, create } = mount();
    navbar.freeze();
    expect(modify.hasAttribute('inert')).toBe(true);
    expect(create.hasAttribute('inert')).toBe(true);
    expect(inlineDisplay(modify)).toBe('');
    navbar.unfreeze();
    expect(modify.hasAttribute('inert')).toBe(false);
  });
});

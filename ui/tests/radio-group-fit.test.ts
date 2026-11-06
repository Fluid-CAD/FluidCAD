// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RadioGroup } from '../src/ui/controls';

/** A stand-in ResizeObserver the test drives: `resize(el, width)` reports a new width. */
class FakeObserver {
  static all: FakeObserver[] = [];
  readonly targets: Element[] = [];
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeObserver.all.push(this);
  }
  observe(target: Element): void {
    this.targets.push(target);
  }
  unobserve(): void {}
  disconnect(): void {
    this.targets.length = 0;
  }
  static resize(target: Element, width: number): void {
    for (const observer of FakeObserver.all.filter(o => o.targets.includes(target))) {
      observer.callback([{ target, contentRect: { width } as DOMRectReadOnly } as ResizeObserverEntry], observer as unknown as ResizeObserver);
    }
  }
}

/** Lays `el` out as `width` wide, its content as wide as `content()` says. */
function measure(el: HTMLElement, width: () => number, content: () => number): void {
  Object.defineProperty(el, 'clientWidth', { configurable: true, get: width });
  Object.defineProperty(el, 'scrollWidth', { configurable: true, get: content });
}

const ITEMS = [
  { value: 'full', label: 'Full tooth' },
  { value: 'half', label: 'Half tooth' },
  { value: 'flat', label: 'Flat' },
];

describe('a radio group fitting its width', () => {
  beforeEach(() => {
    FakeObserver.all = [];
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeObserver;
  });
  afterEach(() => {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  });

  it('keeps each segment as wide as its label, and wraps the labels only where even the whole width is too narrow', () => {
    const group = new RadioGroup({ items: ITEMS, value: 'full', display: 'buttons' });
    const body = group.element.firstElementChild as HTMLElement;
    const labels = () => [...body.querySelectorAll<HTMLElement>('[data-role="choice-label"]')];
    const buttons = () => [...body.querySelectorAll<HTMLElement>('button')];
    expect(labels().map(l => l.className)).toEqual(['whitespace-nowrap', 'whitespace-nowrap', 'whitespace-nowrap']);
    expect(buttons().every(b => b.classList.contains('min-w-min'))).toBe(true);

    let width = 240;
    // The labels on one line take 200 px; wrapped, they fit any width.
    measure(body, () => width, () => group.element.hasAttribute('data-wrapped') ? width : Math.max(width, 200));
    FakeObserver.resize(group.element, width);
    expect(group.element.hasAttribute('data-wrapped')).toBe(false);

    width = 150;
    FakeObserver.resize(group.element, width);
    expect(group.element.hasAttribute('data-wrapped')).toBe(true);
    expect(labels().every(l => l.className.includes('whitespace-normal'))).toBe(true);
    expect(buttons().every(b => b.classList.contains('min-w-0') && b.classList.contains('h-auto') && !b.classList.contains('min-w-min'))).toBe(true);
    // Choosing keeps the wrapped look.
    buttons()[1].click();
    expect(buttons()[1].classList.contains('h-auto')).toBe(true);
    expect(buttons()[1].getAttribute('aria-checked')).toBe('true');

    width = 260;
    FakeObserver.resize(group.element, width);
    expect(group.element.hasAttribute('data-wrapped')).toBe(false);
    expect(labels().map(l => l.className)).toEqual(['whitespace-nowrap', 'whitespace-nowrap', 'whitespace-nowrap']);

    // A hidden group (width 0) measures nothing; shown again it fits again.
    FakeObserver.resize(group.element, 0);
    width = 150;
    FakeObserver.resize(group.element, width);
    expect(group.element.hasAttribute('data-wrapped')).toBe(true);
    group.destroy();
  });

  it('lays cards in the columns asked for, tracks never narrower than a card, and drops columns while they would stick out', () => {
    const items = ITEMS.map(item => ({ ...item, image: `./${item.value}.png` }));
    const group = new RadioGroup({ items, value: 'full', display: 'cards', columns: 3 });
    const body = group.element.firstElementChild as HTMLElement;
    expect(body.style.gridTemplateColumns).toBe('repeat(3, minmax(min-content, 1fr))');
    expect(group.element.dataset.columns).toBe('3');
    expect([...body.querySelectorAll('[data-role="choice-label"]')].every(l => l.className.includes('whitespace-nowrap'))).toBe(true);

    let width = 300;
    // Each column needs 80 px.
    const columns = () => Number(/repeat\((\d+)/.exec(body.style.gridTemplateColumns)![1]);
    measure(body, () => width, () => Math.max(width, columns() * 80));
    FakeObserver.resize(group.element, width);
    expect(columns()).toBe(3);
    width = 170;
    FakeObserver.resize(group.element, width);
    expect(columns()).toBe(2);
    width = 60;
    FakeObserver.resize(group.element, width);
    expect(columns()).toBe(1);
    width = 400;
    FakeObserver.resize(group.element, width);
    expect(columns()).toBe(3);
    group.destroy();
  });

  it('lays out as before where the page has no ResizeObserver', () => {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    const group = new RadioGroup({ items: ITEMS, value: 'flat', display: 'buttons' });
    expect(group.element.hasAttribute('data-wrapped')).toBe(false);
    expect(group.value).toBe('flat');
    group.destroy();
  });
});

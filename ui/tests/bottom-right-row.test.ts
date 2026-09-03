// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bottomRightRow, BOTTOM_RIGHT_ORDER, BOTTOM_RIGHT_ROW_REF } from '../src/ui/bottom-right-row';
import { GridScaleBar } from '../src/ui/grid-scale-bar';
import { MeasureStatusBar } from '../src/ui/measure/measure-status-bar';
import { SelectionInfoOverlay } from '../src/ui/selection-info-overlay';

describe('bottomRightRow', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('creates the row once and hands the same element back', () => {
    const row = bottomRightRow(container);
    expect(row.dataset.ref).toBe(BOTTOM_RIGHT_ROW_REF);
    expect(bottomRightRow(container)).toBe(row);
    expect(container.querySelectorAll(`[data-ref="${BOTTOM_RIGHT_ROW_REF}"]`)).toHaveLength(1);
  });

  it('seats the grid chip beside the unit chip whatever the construction order', () => {
    // Viewer-side chip first (as in the real host), then the measure bar,
    // then the overlay: the row's order classes fix the layout regardless.
    new GridScaleBar(container, () => {});
    new MeasureStatusBar(container, () => {}, null);
    new SelectionInfoOverlay(container, {} as any);

    const row = bottomRightRow(container);
    const grid = row.querySelector<HTMLElement>('[data-ref="grid-scale"]')!;
    const unit = row.querySelector<HTMLElement>('[data-ref="document-unit"]')!;
    expect(grid.parentElement).toBe(row);
    expect(unit.parentElement).toBe(row);
    expect(grid.classList.contains(BOTTOM_RIGHT_ORDER.gridScale)).toBe(true);
    expect(unit.classList.contains(BOTTOM_RIGHT_ORDER.unit)).toBe(true);
    expect(container.querySelectorAll(`[data-ref="${BOTTOM_RIGHT_ROW_REF}"]`)).toHaveLength(1);

    // Every member carries a distinct slot, unit chip last.
    const orders = [...row.children].map((el) => {
      const cls = [...el.classList].find((c) => c.startsWith('order-'))!;
      return Number(cls.slice('order-'.length));
    });
    expect(new Set(orders).size).toBe(row.children.length);
    expect(Math.max(...orders)).toBe(Number(BOTTOM_RIGHT_ORDER.unit.slice('order-'.length)));
  });
});

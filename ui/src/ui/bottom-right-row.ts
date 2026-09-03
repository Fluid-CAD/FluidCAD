/**
 * The viewer's bottom-right status row: one flex row anchored at the corner
 * that the unit chip, the grid-spacing chip, the measure pill and the
 * selection-info overlay all live in, so they never overlap whatever subset
 * of them is showing. Each member sets a Tailwind `order-*` class, so the
 * left-to-right layout is fixed no matter which host constructs what first.
 *
 * Members are bottom-aligned: chips are one row tall, the selection-info
 * overlay grows upward from the same baseline.
 */
export const BOTTOM_RIGHT_ROW_REF = 'bottom-right-row';

/** Slot order in the row, left to right. */
export const BOTTOM_RIGHT_ORDER = {
  selectionInfo: 'order-1',
  measure: 'order-2',
  gridScale: 'order-3',
  unit: 'order-4',
} as const;

/** Find the row in `container`, creating it on first use. */
export function bottomRightRow(container: HTMLElement): HTMLDivElement {
  const existing = container.querySelector<HTMLDivElement>(`:scope > [data-ref="${BOTTOM_RIGHT_ROW_REF}"]`);
  if (existing) {
    return existing;
  }
  const row = document.createElement('div');
  // The measure panel opens above this row (bottom-[64px] right-[76px]).
  row.className = 'absolute bottom-6 right-[76px] z-[150] flex items-end gap-2';
  row.dataset.ref = BOTTOM_RIGHT_ROW_REF;
  container.appendChild(row);
  return row;
}

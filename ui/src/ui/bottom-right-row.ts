/**
 * The viewer's bottom-right status row: one flex row anchored at the corner
 * that the coordinate pill, the unit chip, the grid-spacing chip, the measure
 * pill and the selection-info overlay all live in, so they never overlap
 * whatever subset of them is showing. Each member sets a Tailwind `order-*` class, so the
 * left-to-right layout is fixed no matter which host constructs what first.
 *
 * Members are bottom-aligned: chips are one row tall, the selection-info
 * overlay grows upward from the same baseline.
 */
export const BOTTOM_RIGHT_ROW_REF = 'bottom-right-row';

/** Slot order in the row, left to right. */
export const BOTTOM_RIGHT_ORDER = {
  pointInput: 'order-1',
  selectionInfo: 'order-2',
  measure: 'order-3',
  gridScale: 'order-4',
  unit: 'order-5',
} as const;

/**
 * Where a host's "no status chips" answer is kept. It lives on the container
 * rather than on the row because the two are built in either order: a host
 * turns the row off while composing its UI, and the first chip to want a row
 * may not exist until a scene has rendered.
 */
const HIDDEN_FLAG = 'fluidcadStatusRowHidden';

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
  // Born hidden when the host has already said so, so a chip that arrives
  // later cannot reopen a row that was turned off.
  row.classList.toggle('hidden', container.dataset[HIDDEN_FLAG] === 'true');
  container.appendChild(row);
  return row;
}

/**
 * Show or hide the corner row as a whole — every chip in it, and every chip
 * that joins it afterwards. One switch rather than one per member: they are
 * all readouts on a scene someone is working in, so a host that shows the
 * scene as a picture wants the same answer for all of them, including the
 * ones added after it was written.
 */
export function setBottomRightRowVisible(container: HTMLElement, visible: boolean): void {
  container.dataset[HIDDEN_FLAG] = visible ? 'false' : 'true';
  const row = container.querySelector<HTMLDivElement>(`:scope > [data-ref="${BOTTOM_RIGHT_ROW_REF}"]`);
  row?.classList.toggle('hidden', !visible);
}

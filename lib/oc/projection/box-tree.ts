/**
 * A spatial index over boxes in the plane, for drawings: which items are
 * over a point, which along a segment. Pure TypeScript.
 *
 * A static bounding-box tree: the items are halved along the longer side of
 * their spread until a handful are left, and every node keeps the box of
 * what is under it. A drawing mixes sizes and shapes freely — a 2 m rail
 * beside an M3 screw, the long thin triangles of a cylinder's wall beside
 * the specks of a fillet's — and a grid serves some of them badly whatever
 * its cell; a tree follows the items. Each item is in one leaf, so a query
 * meets it at most once.
 */
export class BoxTree {
  /** Per node: `minX, minY, maxX, maxY`. */
  private readonly bounds: Float64Array;
  /** Per node: the first item of a leaf, or the left child of a branch (the right one follows it). */
  private readonly first: Int32Array;
  /** Per node: how many items a leaf holds; 0 for a branch. */
  private readonly size: Int32Array;
  private readonly order: Int32Array;
  private readonly stack = new Int32Array(128);
  private static readonly LEAF = 6;

  /** `boxes` holds `minX, minY, maxX, maxY` per item. */
  constructor(private readonly boxes: ArrayLike<number>, count: number) {
    this.order = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      this.order[i] = i;
    }
    const capacity = Math.max(1, 2 * Math.ceil(count / 2) + 1);
    this.bounds = new Float64Array(capacity * 4);
    this.first = new Int32Array(capacity);
    this.size = new Int32Array(capacity);
    const centers = new Float64Array(count * 2);
    for (let i = 0; i < count; i++) {
      centers[2 * i] = (boxes[4 * i] + boxes[4 * i + 2]) / 2;
      centers[2 * i + 1] = (boxes[4 * i + 1] + boxes[4 * i + 3]) / 2;
    }
    let nodes = 1;
    // Each pending node: its index and the stretch of `order` under it.
    const pending: number[] = [0, 0, count];
    while (pending.length > 0) {
      const to = pending.pop()!;
      const from = pending.pop()!;
      const node = pending.pop()!;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let spreadMinX = Infinity;
      let spreadMinY = Infinity;
      let spreadMaxX = -Infinity;
      let spreadMaxY = -Infinity;
      for (let k = from; k < to; k++) {
        const i = this.order[k];
        minX = Math.min(minX, boxes[4 * i]);
        minY = Math.min(minY, boxes[4 * i + 1]);
        maxX = Math.max(maxX, boxes[4 * i + 2]);
        maxY = Math.max(maxY, boxes[4 * i + 3]);
        spreadMinX = Math.min(spreadMinX, centers[2 * i]);
        spreadMaxX = Math.max(spreadMaxX, centers[2 * i]);
        spreadMinY = Math.min(spreadMinY, centers[2 * i + 1]);
        spreadMaxY = Math.max(spreadMaxY, centers[2 * i + 1]);
      }
      this.bounds[4 * node] = minX;
      this.bounds[4 * node + 1] = minY;
      this.bounds[4 * node + 2] = maxX;
      this.bounds[4 * node + 3] = maxY;
      const axis = spreadMaxX - spreadMinX >= spreadMaxY - spreadMinY ? 0 : 1;
      const spread = axis === 0 ? spreadMaxX - spreadMinX : spreadMaxY - spreadMinY;
      if (to - from <= BoxTree.LEAF || !(spread > 0)) {
        this.first[node] = from;
        this.size[node] = to - from;
        continue;
      }
      const middle = (from + to) >> 1;
      this.select(centers, axis, from, to - 1, middle);
      this.first[node] = nodes;
      this.size[node] = 0;
      pending.push(nodes, from, middle, nodes + 1, middle, to);
      nodes += 2;
    }
  }

  /** Orders `order[from..to]` so the item at `k` is the one a full sort would put there (Hoare's selection). */
  private select(centers: Float64Array, axis: number, from: number, to: number, k: number): void {
    const order = this.order;
    while (from < to) {
      const pivot = centers[2 * order[(from + to) >> 1] + axis];
      let i = from;
      let j = to;
      while (i <= j) {
        while (centers[2 * order[i] + axis] < pivot) {
          i++;
        }
        while (centers[2 * order[j] + axis] > pivot) {
          j--;
        }
        if (i <= j) {
          const swap = order[i];
          order[i] = order[j];
          order[j] = swap;
          i++;
          j--;
        }
      }
      if (k <= j) {
        to = j;
      } else if (k >= i) {
        from = i;
      } else {
        return;
      }
    }
  }

  /** Every item whose box holds the point; each once. */
  atPoint(x: number, y: number, visit: (item: number) => void): void {
    const { bounds, first, size, order, stack, boxes } = this;
    let top = 0;
    stack[top++] = 0;
    while (top > 0) {
      const node = stack[--top];
      const b = 4 * node;
      if (x < bounds[b] || y < bounds[b + 1] || x > bounds[b + 2] || y > bounds[b + 3]) {
        continue;
      }
      const count = size[node];
      if (count === 0) {
        stack[top++] = first[node];
        stack[top++] = first[node] + 1;
        continue;
      }
      for (let k = first[node]; k < first[node] + count; k++) {
        const item = order[k];
        const i = 4 * item;
        if (x >= boxes[i] && y >= boxes[i + 1] && x <= boxes[i + 2] && y <= boxes[i + 3]) {
          visit(item);
        }
      }
    }
  }

  /** Every item whose box, grown by `margin`, the segment meets; each once. */
  alongSegment(x0: number, y0: number, x1: number, y1: number, margin: number, visit: (item: number) => void): void {
    const { bounds, first, size, order, stack, boxes } = this;
    let top = 0;
    stack[top++] = 0;
    while (top > 0) {
      const node = stack[--top];
      const b = 4 * node;
      if (!BoxTree.meets(x0, y0, x1, y1, bounds[b] - margin, bounds[b + 1] - margin, bounds[b + 2] + margin, bounds[b + 3] + margin)) {
        continue;
      }
      const count = size[node];
      if (count === 0) {
        stack[top++] = first[node];
        stack[top++] = first[node] + 1;
        continue;
      }
      for (let k = first[node]; k < first[node] + count; k++) {
        const item = order[k];
        const i = 4 * item;
        if (BoxTree.meets(x0, y0, x1, y1, boxes[i] - margin, boxes[i + 1] - margin, boxes[i + 2] + margin, boxes[i + 3] + margin)) {
          visit(item);
        }
      }
    }
  }

  /** Whether the segment has a point in the box (the slab test). */
  private static meets(x0: number, y0: number, x1: number, y1: number, minX: number, minY: number, maxX: number, maxY: number): boolean {
    let enter = 0;
    let leave = 1;
    const dx = x1 - x0;
    if (dx === 0) {
      if (x0 < minX || x0 > maxX) {
        return false;
      }
    } else {
      const a = (minX - x0) / dx;
      const b = (maxX - x0) / dx;
      enter = Math.max(enter, Math.min(a, b));
      leave = Math.min(leave, Math.max(a, b));
      if (enter > leave) {
        return false;
      }
    }
    const dy = y1 - y0;
    if (dy === 0) {
      return y0 >= minY && y0 <= maxY;
    }
    const a = (minY - y0) / dy;
    const b = (maxY - y0) / dy;
    enter = Math.max(enter, Math.min(a, b));
    leave = Math.min(leave, Math.max(a, b));
    return enter <= leave;
  }
}

import type { Curve2D, DrawingEntity, DrawingLayer, Vec2 } from "./drawing.js";
import { Curves, DRAWING_LAYERS } from "./drawing.js";
import { BSplineCurve2D } from "./bspline.js";
import { Conic } from "./conic.js";

const TWO_PI = 2 * Math.PI;

/** One curve of a chain, walked start → end or, `reversed`, end → start. */
export type DrawingChainItem = { curve: Curve2D; reversed: boolean };

/**
 * Curves of one layer joined end to end: an open run, or a `closed` loop
 * (walked counter-clockwise). A circle or any other curve that closes on
 * itself is a loop of one.
 */
export type DrawingChain = { layer: DrawingLayer; closed: boolean; items: DrawingChainItem[] };

/** A stretch of a carrier (a line's abscissa, a circle's angle), with what its two ends came from. */
type Span<T> = { lo: number; hi: number; loTag: T; hiTag: T };

type LineCluster = {
  origin: Vec2;
  dir: Vec2;
  members: { layer: DrawingLayer; span: Span<Vec2> }[];
};

type ArcLike = Extract<Curve2D, { kind: 'circle' | 'arc' }>;
type Ellipse = Extract<Curve2D, { kind: 'ellipse' }>;

/**
 * What turns the raw output of hidden-line removal into a drawing worth
 * writing. Hidden-line removal cuts every edge wherever its visibility
 * changes and reports an edge once per face that shows it, so the raw pieces
 * are fragmented, doubled, and — with hidden lines on — stacked: a dashed
 * line exactly under a solid one. A cutter would run each of those twice.
 *
 * The passes, in order: {@link canonicalize} each curve, {@link mergeOverlaps}
 * per carrier with the layers' priority, {@link chain} into runs and loops,
 * and a deterministic order — the same model always writes the same bytes.
 *
 * Everything takes `tolerance`, a length in the drawing's unit: how close two
 * points are to be one.
 */
export class DrawingCleanup {
  /** All passes: the entities ready for a writer, in chain order. */
  static run(entities: readonly DrawingEntity[], tolerance: number): DrawingEntity[] {
    const canonical: DrawingEntity[] = [];
    for (const entity of entities) {
      const curve = DrawingCleanup.canonicalize(entity.curve, tolerance);
      if (curve) {
        canonical.push({ layer: entity.layer, curve });
      }
    }
    const merged = DrawingCleanup.mergeOverlaps(canonical, tolerance);
    const ordered: DrawingEntity[] = [];
    for (const chain of DrawingCleanup.chain(merged, tolerance)) {
      for (const item of chain.items) {
        // A line walked backwards is written the way it is walked, so each
        // one ends where the next begins. (Arcs and ellipses have one
        // direction only; a reader follows them by their end points.)
        const curve = item.reversed && item.curve.kind === 'line'
          ? { kind: 'line' as const, a: item.curve.b, b: item.curve.a }
          : item.curve;
        ordered.push({ layer: chain.layer, curve });
      }
    }
    return ordered;
  }

  /**
   * The curve in its simplest true form — a full-sweep arc is a circle, an
   * ellipse with equal axes a circle or arc, a spline whose poles are all on
   * one line that line — or null when it has no length.
   */
  static canonicalize(curve: Curve2D, tolerance: number): Curve2D | null {
    switch (curve.kind) {
      case 'line':
        return Math.hypot(curve.b.x - curve.a.x, curve.b.y - curve.a.y) > tolerance ? curve : null;
      case 'circle':
        return curve.radius > tolerance ? curve : null;
      case 'arc': {
        const sweep = curve.end - curve.start;
        if (!(curve.radius > tolerance) || !(sweep * curve.radius > tolerance)) {
          return null;
        }
        if (sweep >= TWO_PI - tolerance / curve.radius) {
          return { kind: 'circle', center: curve.center, radius: curve.radius };
        }
        const start = Curves.normalizeAngle(curve.start);
        return { kind: 'arc', center: curve.center, radius: curve.radius, start, end: start + sweep };
      }
      case 'ellipse':
        // Back through the conic door: it sorts circle, arc, ellipse and
        // folded segment by the axes it finds.
        return Conic.fromConjugateDiameters(
          curve.center,
          curve.major,
          { x: -curve.major.y * curve.ratio, y: curve.major.x * curve.ratio },
          curve.start,
          curve.end,
          tolerance,
        );
      case 'bspline': {
        const invalid = BSplineCurve2D.invalidReason(curve);
        if (invalid) {
          throw new Error(`Invalid B-spline in drawing: ${invalid}`);
        }
        const extent = BSplineCurve2D.collinearExtent(curve, tolerance);
        if (extent === 'point') {
          return null;
        }
        return extent ? { kind: 'line', a: extent.a, b: extent.b } : curve;
      }
      case 'polyline': {
        const points: Vec2[] = [];
        for (const p of curve.points) {
          const last = points[points.length - 1];
          if (!last || Math.hypot(p.x - last.x, p.y - last.y) > tolerance) {
            points.push(p);
          }
        }
        let closed = curve.closed;
        if (points.length > 2 && Math.hypot(points[0].x - points[points.length - 1].x, points[0].y - points[points.length - 1].y) <= tolerance) {
          points.pop();
          closed = true;
        }
        if (points.length < 2) {
          return null;
        }
        if (points.length === 2) {
          return { kind: 'line', a: points[0], b: points[1] };
        }
        return { kind: 'polyline', points, closed };
      }
    }
  }

  /**
   * One curve wherever several lie on top of each other. Lines are grouped by
   * the infinite line they sit on, arcs by their circle, ellipse arcs by
   * their ellipse; on each carrier a layer's stretches are unioned (which
   * also rejoins the fragments of one edge) and then lose whatever a
   * higher-priority layer already draws there. Splines and polylines are
   * only deduplicated whole — the same curve reported twice, in either
   * direction.
   */
  static mergeOverlaps(entities: readonly DrawingEntity[], tolerance: number): DrawingEntity[] {
    const sorted = [...entities].sort(DrawingCleanup.compareEntities);
    const lines = sorted.filter((e) => e.curve.kind === 'line');
    const arcs = sorted.filter((e) => e.curve.kind === 'circle' || e.curve.kind === 'arc');
    const ellipses = sorted.filter((e) => e.curve.kind === 'ellipse');
    const freeform = sorted.filter((e) => e.curve.kind === 'bspline' || e.curve.kind === 'polyline');
    return [
      ...DrawingCleanup.mergeLines(lines, tolerance),
      ...DrawingCleanup.mergeArcs(arcs, tolerance),
      ...DrawingCleanup.mergeEllipses(ellipses, tolerance),
      ...DrawingCleanup.dedupeFreeform(freeform, tolerance),
    ].sort(DrawingCleanup.compareEntities);
  }

  /**
   * The entities joined into chains — per layer, by shared end points — and
   * the chains in their written order: by layer, then by where their bounds
   * start (bottom first, then left). The input's own order never shows.
   */
  static chain(entities: readonly DrawingEntity[], tolerance: number): DrawingChain[] {
    const chains: DrawingChain[] = [];
    for (const layer of DRAWING_LAYERS) {
      const curves = entities.filter((e) => e.layer === layer).sort(DrawingCleanup.compareEntities).map((e) => e.curve);
      const ofLayer = DrawingCleanup.chainLayer(layer, curves, tolerance);
      const keyed = ofLayer.map((chain) => ({ chain, key: DrawingCleanup.chainKey(chain) }));
      keyed.sort((p, q) => DrawingCleanup.compareNumbers(p.key, q.key));
      chains.push(...keyed.map((k) => k.chain));
    }
    return chains;
  }

  // ─── Lines ──────────────────────────────────────────────────────────────

  /** Angle bins the carrier search looks in; a segment long enough to have a trustworthy direction only meets its neighbours. */
  private static readonly LINE_BINS = 180;

  private static mergeLines(entities: DrawingEntity[], tolerance: number): DrawingEntity[] {
    type Line = Extract<Curve2D, { kind: 'line' }>;
    const length = (l: Line) => Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y);
    // Longest first: the longest segment on a carrier fixes its direction best.
    const byLength = entities
      .map((entity, index) => ({ entity, index, length: length(entity.curve as Line) }))
      .sort((p, q) => q.length - p.length || p.index - q.index);

    const clusters: LineCluster[] = [];
    const bins = new Map<number, LineCluster[]>();
    // Below this a segment's own direction is noise next to a bin's width.
    const trustedLength = (4 * tolerance) / (Math.PI / DrawingCleanup.LINE_BINS);
    const binOf = (dir: Vec2) => Math.min(
      DrawingCleanup.LINE_BINS - 1,
      Math.floor((Math.atan2(dir.y, dir.x) / Math.PI) * DrawingCleanup.LINE_BINS),
    );
    const offLine = (cluster: LineCluster, p: Vec2) =>
      Math.abs((p.x - cluster.origin.x) * cluster.dir.y - (p.y - cluster.origin.y) * cluster.dir.x);
    const abscissa = (cluster: LineCluster, p: Vec2) =>
      (p.x - cluster.origin.x) * cluster.dir.x + (p.y - cluster.origin.y) * cluster.dir.y;

    for (const { entity, length: len } of byLength) {
      const line = entity.curve as Line;
      // Direction with its angle in [0, π): one carrier, one direction.
      let dir = { x: (line.b.x - line.a.x) / len, y: (line.b.y - line.a.y) / len };
      if (dir.y < 0 || (dir.y === 0 && dir.x < 0)) {
        dir = { x: -dir.x, y: -dir.y };
      }
      const bin = binOf(dir);
      let candidates: LineCluster[];
      if (len >= trustedLength) {
        candidates = [];
        for (const k of [bin - 1, bin, bin + 1]) {
          candidates.push(...(bins.get((k + DrawingCleanup.LINE_BINS) % DrawingCleanup.LINE_BINS) ?? []));
        }
      } else {
        candidates = clusters;
      }
      let cluster = candidates.find((c) => offLine(c, line.a) <= tolerance && offLine(c, line.b) <= tolerance);
      if (!cluster) {
        cluster = { origin: line.a, dir, members: [] };
        clusters.push(cluster);
        const list = bins.get(bin);
        if (list) {
          list.push(cluster);
        } else {
          bins.set(bin, [cluster]);
        }
      }
      const sa = abscissa(cluster, line.a);
      const sb = abscissa(cluster, line.b);
      cluster.members.push({
        layer: entity.layer,
        span: sa <= sb
          ? { lo: sa, hi: sb, loTag: line.a, hiTag: line.b }
          : { lo: sb, hi: sa, loTag: line.b, hiTag: line.a },
      });
    }

    const result: DrawingEntity[] = [];
    for (const cluster of clusters) {
      for (const { layer, spans } of DrawingCleanup.layered(cluster.members, tolerance)) {
        for (const span of spans) {
          // The ends are members' own end points: merging moves no coordinate.
          result.push({ layer, curve: { kind: 'line', a: span.loTag, b: span.hiTag } });
        }
      }
    }
    return result;
  }

  // ─── Circles and arcs ───────────────────────────────────────────────────

  private static mergeArcs(entities: DrawingEntity[], tolerance: number): DrawingEntity[] {
    type Cluster = { center: Vec2; radius: number; members: { layer: DrawingLayer; span: Span<null> }[] };
    const grid = new PointGrid<Cluster>(tolerance);
    const clusters: Cluster[] = [];
    for (const entity of entities) {
      const curve = entity.curve as ArcLike;
      let cluster = grid.near(curve.center).find((c) =>
        Math.hypot(c.center.x - curve.center.x, c.center.y - curve.center.y) <= tolerance
        && Math.abs(c.radius - curve.radius) <= tolerance);
      if (!cluster) {
        cluster = { center: curve.center, radius: curve.radius, members: [] };
        clusters.push(cluster);
        grid.add(curve.center, cluster);
      }
      const [start, end] = curve.kind === 'circle' ? [0, TWO_PI] : [curve.start, curve.end];
      for (const span of DrawingCleanup.unwrap(start, end)) {
        cluster.members.push({ layer: entity.layer, span });
      }
    }

    const result: DrawingEntity[] = [];
    for (const cluster of clusters) {
      const angular = tolerance / cluster.radius;
      for (const { layer, spans } of DrawingCleanup.layered(cluster.members, angular)) {
        for (const span of DrawingCleanup.rewrap(spans, angular)) {
          if (span.hi - span.lo >= TWO_PI - angular) {
            result.push({ layer, curve: { kind: 'circle', center: cluster.center, radius: cluster.radius } });
          } else {
            const start = Curves.normalizeAngle(span.lo);
            result.push({
              layer,
              curve: { kind: 'arc', center: cluster.center, radius: cluster.radius, start, end: start + (span.hi - span.lo) },
            });
          }
        }
      }
    }
    return result;
  }

  // ─── Ellipses ───────────────────────────────────────────────────────────

  private static mergeEllipses(entities: DrawingEntity[], tolerance: number): DrawingEntity[] {
    type Cluster = { ellipse: Ellipse; members: { layer: DrawingLayer; span: Span<null> }[] };
    const grid = new PointGrid<Cluster>(tolerance);
    const clusters: Cluster[] = [];
    for (const entity of entities) {
      const curve = entity.curve as Ellipse;
      const minor = Math.hypot(curve.major.x, curve.major.y) * curve.ratio;
      // The same ellipse may carry its major axis either way round; the
      // parameter then runs half a turn apart.
      let shift = 0;
      let cluster: Cluster | undefined;
      for (const candidate of grid.near(curve.center)) {
        const rep = candidate.ellipse;
        if (Math.hypot(rep.center.x - curve.center.x, rep.center.y - curve.center.y) > tolerance) {
          continue;
        }
        if (Math.abs(Math.hypot(rep.major.x, rep.major.y) * rep.ratio - minor) > tolerance) {
          continue;
        }
        if (Math.hypot(rep.major.x - curve.major.x, rep.major.y - curve.major.y) <= tolerance) {
          cluster = candidate;
          break;
        }
        if (Math.hypot(rep.major.x + curve.major.x, rep.major.y + curve.major.y) <= tolerance) {
          cluster = candidate;
          shift = Math.PI;
          break;
        }
      }
      if (!cluster) {
        cluster = { ellipse: curve, members: [] };
        clusters.push(cluster);
        grid.add(curve.center, cluster);
      }
      const start = Curves.normalizeAngle(curve.start + shift);
      for (const span of DrawingCleanup.unwrap(start, start + (curve.end - curve.start))) {
        cluster.members.push({ layer: entity.layer, span });
      }
    }

    const result: DrawingEntity[] = [];
    for (const cluster of clusters) {
      const { center, major, ratio } = cluster.ellipse;
      const angular = tolerance / Math.hypot(major.x, major.y);
      for (const { layer, spans } of DrawingCleanup.layered(cluster.members, angular)) {
        for (const span of DrawingCleanup.rewrap(spans, angular)) {
          const full = span.hi - span.lo >= TWO_PI - angular;
          const start = full ? 0 : Curves.normalizeAngle(span.lo);
          const end = full ? TWO_PI : start + (span.hi - span.lo);
          result.push({ layer, curve: { kind: 'ellipse', center, major, ratio, start, end } });
        }
      }
    }
    return result;
  }

  // ─── Splines and polylines ──────────────────────────────────────────────

  /** Points a freeform curve is compared on; two curves agreeing on all of them, either way round, are one. */
  private static readonly SIGNATURE_SAMPLES = 16;

  private static dedupeFreeform(entities: DrawingEntity[], tolerance: number): DrawingEntity[] {
    const priority = (layer: DrawingLayer) => DRAWING_LAYERS.indexOf(layer);
    const kept: { entity: DrawingEntity; signature: Vec2[] }[] = [];
    const same = (p: Vec2[], q: Vec2[]) => {
      const n = p.length;
      const near = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y) <= tolerance;
      return p.every((point, i) => near(point, q[i])) || p.every((point, i) => near(point, q[n - 1 - i]));
    };
    // The highest-priority copy is met first and is the one that stays.
    for (const entity of [...entities].sort((p, q) => priority(p.layer) - priority(q.layer))) {
      const signature = Curves.sample(entity.curve, DrawingCleanup.SIGNATURE_SAMPLES);
      if (!kept.some((k) => k.signature.length === signature.length && same(k.signature, signature))) {
        kept.push({ entity, signature });
      }
    }
    return kept.map((k) => k.entity);
  }

  // ─── Spans ──────────────────────────────────────────────────────────────

  /**
   * A carrier's members resolved layer by layer, highest priority first:
   * each layer's spans unioned, minus what the layers above it cover.
   */
  private static layered<T>(
    members: { layer: DrawingLayer; span: Span<T> }[],
    tolerance: number,
  ): { layer: DrawingLayer; spans: Span<T>[] }[] {
    const result: { layer: DrawingLayer; spans: Span<T>[] }[] = [];
    let covered: Span<T>[] = [];
    for (const layer of DRAWING_LAYERS) {
      const own = members.filter((m) => m.layer === layer).map((m) => m.span);
      if (own.length === 0) {
        continue;
      }
      const union = DrawingCleanup.union(own, tolerance);
      const spans = DrawingCleanup.subtract(union, covered, tolerance, tolerance * DrawingCleanup.SLIVER_FACTOR);
      if (spans.length > 0) {
        result.push({ layer, spans });
      }
      covered = DrawingCleanup.union([...covered, ...union], tolerance);
    }
    return result;
  }

  /** The spans merged wherever they overlap or touch within `tolerance`, in ascending order. */
  private static union<T>(spans: Span<T>[], tolerance: number): Span<T>[] {
    const sorted = [...spans].sort((p, q) => p.lo - q.lo || p.hi - q.hi);
    const merged: Span<T>[] = [];
    for (const span of sorted) {
      const last = merged[merged.length - 1];
      if (last && span.lo <= last.hi + tolerance) {
        if (span.hi > last.hi) {
          last.hi = span.hi;
          last.hiTag = span.hiTag;
        }
      } else {
        merged.push({ ...span });
      }
    }
    return merged;
  }

  /**
   * A stretch a lower layer keeps beside a higher one must be this many
   * tolerances long. Shorter, it is not something behind the model but the
   * disagreement of two curves that stand for the same edge — an arc
   * recovered from a spline is only good to a micron — and would be written
   * as a dash a thousandth of a millimetre long.
   */
  private static readonly SLIVER_FACTOR = 100;

  /**
   * What is left of `spans` outside `covered`. Overlaps within `tolerance`
   * do not count; a remnant cut off by a cover is kept only when longer than
   * `sliver`.
   */
  private static subtract<T>(spans: Span<T>[], covered: Span<T>[], tolerance: number, sliver: number): Span<T>[] {
    let pieces = spans.map((s) => ({ ...s }));
    for (const cover of covered) {
      const next: Span<T>[] = [];
      for (const piece of pieces) {
        if (cover.hi <= piece.lo + tolerance || cover.lo >= piece.hi - tolerance) {
          next.push(piece);
          continue;
        }
        if (cover.lo - piece.lo > sliver) {
          next.push({ lo: piece.lo, hi: cover.lo, loTag: piece.loTag, hiTag: cover.loTag });
        }
        if (piece.hi - cover.hi > sliver) {
          next.push({ lo: cover.hi, hi: piece.hi, loTag: cover.hiTag, hiTag: piece.hiTag });
        }
      }
      pieces = next;
    }
    return pieces;
  }

  /** An angular run `[start, end]` (`start` in [0, 2π), up to one turn long) as spans inside [0, 2π]. */
  private static unwrap(start: number, end: number): Span<null>[] {
    if (end <= TWO_PI) {
      return [{ lo: start, hi: end, loTag: null, hiTag: null }];
    }
    return [
      { lo: start, hi: TWO_PI, loTag: null, hiTag: null },
      { lo: 0, hi: end - TWO_PI, loTag: null, hiTag: null },
    ];
  }

  /** Spans inside [0, 2π] with the one ending at 2π and the one starting at 0 made one run again. */
  private static rewrap(spans: Span<null>[], angular: number): Span<null>[] {
    if (spans.length < 2) {
      return spans;
    }
    const first = spans[0];
    const last = spans[spans.length - 1];
    if (first.lo <= angular && last.hi >= TWO_PI - angular) {
      return [...spans.slice(1, -1), { lo: last.lo, hi: first.hi + TWO_PI, loTag: null, hiTag: null }];
    }
    return spans;
  }

  // ─── Chains ─────────────────────────────────────────────────────────────

  private static chainLayer(layer: DrawingLayer, curves: Curve2D[], tolerance: number): DrawingChain[] {
    const chains: DrawingChain[] = [];
    const nodes: Vec2[] = [];
    const grid = new PointGrid<number>(tolerance);
    const nodeOf = (p: Vec2): number => {
      const found = grid.near(p).find((n) => Math.hypot(nodes[n].x - p.x, nodes[n].y - p.y) <= tolerance);
      if (found !== undefined) {
        return found;
      }
      nodes.push(p);
      grid.add(p, nodes.length - 1);
      return nodes.length - 1;
    };

    type Link = { curve: Curve2D; from: number; to: number };
    const links: Link[] = [];
    for (const curve of curves) {
      const ends = Curves.endpoints(curve);
      if (!ends || Curves.isClosed(curve, tolerance)) {
        chains.push({ layer, closed: true, items: [{ curve, reversed: false }] });
        continue;
      }
      const from = nodeOf(ends[0]);
      const to = nodeOf(ends[1]);
      if (from === to) {
        // Both ends in one spot without being a closed curve: a loop of its own.
        chains.push({ layer, closed: true, items: [{ curve, reversed: false }] });
        continue;
      }
      links.push({ curve, from, to });
    }

    const incident: number[][] = nodes.map(() => []);
    links.forEach((link, index) => {
      incident[link.from].push(index);
      incident[link.to].push(index);
    });
    const used = links.map(() => false);

    /** Walk from `node` along `first` until a node that is not a plain pass-through, or back to the start. */
    const walk = (node: number, first: number): { items: DrawingChainItem[]; end: number } => {
      const items: DrawingChainItem[] = [];
      let at = node;
      let link = first;
      for (;;) {
        used[link] = true;
        const reversed = links[link].to === at;
        items.push({ curve: links[link].curve, reversed });
        at = reversed ? links[link].from : links[link].to;
        if (at === node || incident[at].length !== 2) {
          return { items, end: at };
        }
        const next = incident[at].find((l) => !used[l]);
        if (next === undefined) {
          return { items, end: at };
        }
        link = next;
      }
    };

    // Runs first: every chain that starts at a free end or a junction.
    for (let node = 0; node < nodes.length; node++) {
      if (incident[node].length === 2) {
        continue;
      }
      for (const link of incident[node]) {
        if (used[link]) {
          continue;
        }
        const { items, end } = walk(node, link);
        chains.push(DrawingCleanup.orient(layer, items, end === node, nodes[node], nodes[end]));
      }
    }
    // What is left only passes through plain nodes: closed loops.
    for (let link = 0; link < links.length; link++) {
      if (used[link]) {
        continue;
      }
      const start = links[link].from;
      const { items } = walk(start, link);
      chains.push(DrawingCleanup.orient(layer, items, true, nodes[start], nodes[start]));
    }
    return chains;
  }

  /**
   * The chain in its one written form: an open run from its lower (then
   * left) end, a loop counter-clockwise from its lowest (then leftmost)
   * joint. Without this the same loop could be written from any corner, in
   * either direction.
   */
  private static orient(layer: DrawingLayer, items: DrawingChainItem[], closed: boolean, start: Vec2, end: Vec2): DrawingChain {
    const flip = (list: DrawingChainItem[]) => list.map((item) => ({ curve: item.curve, reversed: !item.reversed })).reverse();
    if (!closed) {
      const backwards = end.y < start.y || (end.y === start.y && end.x < start.x);
      return { layer, closed, items: backwards ? flip(items) : items };
    }
    // Signed area over the loop's sampled outline gives its sense.
    const outline: Vec2[] = [];
    for (const item of items) {
      const points = Curves.sample(item.curve, 8);
      outline.push(...(item.reversed ? points.reverse() : points));
    }
    let area = 0;
    for (let i = 0; i < outline.length; i++) {
      const p = outline[i];
      const q = outline[(i + 1) % outline.length];
      area += p.x * q.y - q.x * p.y;
    }
    let loop = area < 0 ? flip(items) : items;
    // Rotate to begin at the lowest joint.
    const startOf = (item: DrawingChainItem): Vec2 => {
      const ends = Curves.endpoints(item.curve)!;
      return item.reversed ? ends[1] : ends[0];
    };
    let best = 0;
    for (let i = 1; i < loop.length; i++) {
      const p = startOf(loop[i]);
      const q = startOf(loop[best]);
      if (p.y < q.y || (p.y === q.y && p.x < q.x)) {
        best = i;
      }
    }
    loop = [...loop.slice(best), ...loop.slice(0, best)];
    return { layer, closed, items: loop };
  }

  // ─── Order ──────────────────────────────────────────────────────────────

  /** What chains are sorted by: where their bounds start and end, then their size. */
  private static chainKey(chain: DrawingChain): number[] {
    const bounds = Curves.boundsOf(chain.items.map((item) => ({ layer: chain.layer, curve: item.curve })))!;
    return [bounds.min.y, bounds.min.x, bounds.max.y, bounds.max.x, chain.items.length];
  }

  private static readonly KIND_ORDER: Record<Curve2D['kind'], number> = {
    line: 0, circle: 1, arc: 2, ellipse: 3, bspline: 4, polyline: 5,
  };

  /** Every number that defines the curve, in a fixed order. */
  private static curveKey(curve: Curve2D): number[] {
    switch (curve.kind) {
      case 'line':
        return [curve.a.x, curve.a.y, curve.b.x, curve.b.y];
      case 'circle':
        return [curve.center.x, curve.center.y, curve.radius];
      case 'arc':
        return [curve.center.x, curve.center.y, curve.radius, curve.start, curve.end];
      case 'ellipse':
        return [curve.center.x, curve.center.y, curve.major.x, curve.major.y, curve.ratio, curve.start, curve.end];
      case 'bspline':
        return [curve.degree, ...curve.poles.flatMap((p) => [p.x, p.y]), ...curve.knots, ...(curve.weights ?? [])];
      case 'polyline':
        return [curve.closed ? 1 : 0, ...curve.points.flatMap((p) => [p.x, p.y])];
    }
  }

  private static compareNumbers(p: readonly number[], q: readonly number[]): number {
    const n = Math.min(p.length, q.length);
    for (let i = 0; i < n; i++) {
      if (p[i] !== q[i]) {
        return p[i] - q[i];
      }
    }
    return p.length - q.length;
  }

  /** A total order on entities that depends on nothing but their own values. */
  private static compareEntities(p: DrawingEntity, q: DrawingEntity): number {
    const layer = DRAWING_LAYERS.indexOf(p.layer) - DRAWING_LAYERS.indexOf(q.layer);
    if (layer !== 0) {
      return layer;
    }
    const kind = DrawingCleanup.KIND_ORDER[p.curve.kind] - DrawingCleanup.KIND_ORDER[q.curve.kind];
    if (kind !== 0) {
      return kind;
    }
    return DrawingCleanup.compareNumbers(DrawingCleanup.curveKey(p.curve), DrawingCleanup.curveKey(q.curve));
  }
}

/**
 * Points bucketed on a grid a few tolerances wide, so "what lies within
 * tolerance of here" looks at nine cells instead of everything.
 */
class PointGrid<T> {
  private readonly cells = new Map<string, T[]>();
  private readonly cell: number;

  constructor(tolerance: number) {
    this.cell = tolerance * 4;
  }

  add(p: Vec2, value: T): void {
    const key = `${Math.floor(p.x / this.cell)},${Math.floor(p.y / this.cell)}`;
    const list = this.cells.get(key);
    if (list) {
      list.push(value);
    } else {
      this.cells.set(key, [value]);
    }
  }

  /** Everything stored in the cell of `p` and the eight around it. */
  near(p: Vec2): T[] {
    const ix = Math.floor(p.x / this.cell);
    const iy = Math.floor(p.y / this.cell);
    const found: T[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = this.cells.get(`${ix + dx},${iy + dy}`);
        if (list) {
          found.push(...list);
        }
      }
    }
    return found;
  }
}

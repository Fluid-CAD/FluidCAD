import { JSDOM } from "jsdom";

// A reader for the SVG the drawing export writes, for the tests: the
// document through a real XML parser (jsdom's, strict — malformed XML
// throws), path data by the SVG grammar, and each path segment sampled by
// the format's own rules (an arc from its two ends, radii, rotation and
// flags, as a renderer works it out). Independent of the writer on purpose:
// it knows the format, not how the writer thinks.

export type SvgPoint = { x: number; y: number };

export type SvgElement = { tag: string; attributes: Record<string, string> };

export type SvgGroup = { id: string; attributes: Record<string, string>; elements: SvgElement[] };

export type SvgFile = {
  attributes: Record<string, string>;
  title: string | null;
  viewBox: { x: number; y: number; width: number; height: number };
  groups: SvgGroup[];
  /** Every element under the root, groups included, in document order. */
  all: SvgElement[];
};

export type SvgSegment =
  | { command: 'L'; from: SvgPoint; to: SvgPoint }
  | { command: 'Q'; from: SvgPoint; control: SvgPoint; to: SvgPoint }
  | { command: 'C'; from: SvgPoint; control1: SvgPoint; control2: SvgPoint; to: SvgPoint }
  | { command: 'A'; from: SvgPoint; rx: number; ry: number; rotation: number; largeArc: boolean; sweep: boolean; to: SvgPoint }
  /** The closing side `Z` draws back to the path's start. */
  | { command: 'Z'; from: SvgPoint; to: SvgPoint };

export class SvgReader {
  /** Parses the document; throws when it is not well-formed XML or not an `<svg>`. */
  static parse(text: string): SvgFile {
    const dom = new JSDOM(text, { contentType: 'image/svg+xml' });
    const root = dom.window.document.documentElement;
    if (root.localName !== 'svg' || root.namespaceURI !== 'http://www.w3.org/2000/svg') {
      throw new Error(`Not an SVG document: <${root.nodeName}>`);
    }
    const attributesOf = (element: any): Record<string, string> => {
      const attributes: Record<string, string> = {};
      for (const attribute of Array.from(element.attributes) as any[]) {
        attributes[attribute.name] = attribute.value;
      }
      return attributes;
    };
    const describe = (element: any): SvgElement => ({ tag: element.localName, attributes: attributesOf(element) });
    const attributes = attributesOf(root);
    const box = (attributes.viewBox ?? '').trim().split(/\s+/).map(Number);
    if (box.length !== 4 || box.some((v) => !Number.isFinite(v))) {
      throw new Error(`Bad viewBox ${JSON.stringify(attributes.viewBox)}`);
    }
    const groups: SvgGroup[] = [];
    let title: string | null = null;
    for (const child of Array.from(root.children) as any[]) {
      if (child.localName === 'title') {
        title = child.textContent;
      } else if (child.localName === 'g') {
        groups.push({
          id: child.getAttribute('id') ?? '',
          attributes: attributesOf(child),
          elements: (Array.from(child.children) as any[]).map(describe),
        });
      }
    }
    return {
      attributes,
      title,
      viewBox: { x: box[0], y: box[1], width: box[2], height: box[3] },
      groups,
      all: (Array.from(root.querySelectorAll('*')) as any[]).map(describe),
    };
  }

  static group(file: SvgFile, id: string): SvgGroup {
    const group = file.groups.find((g) => g.id === id);
    if (!group) {
      throw new Error(`No <g id="${id}"> (have ${file.groups.map((g) => g.id).join(', ') || 'none'})`);
    }
    return group;
  }

  /**
   * The segments of a path's `d`, absolute. Understands the commands the
   * writer may use — `M L A Q C Z`, upper case — and throws on anything else
   * or on a malformed number, so a test never samples a path it misread.
   */
  static segments(d: string): SvgSegment[] {
    const tokens = d.trim().split(/[\s,]+/).filter((t) => t.length > 0);
    const segments: SvgSegment[] = [];
    let at = 0;
    const number = (): number => {
      const token = tokens[at++];
      if (token === undefined || !/^-?(\d+\.?\d*|\.\d+)$/.test(token)) {
        throw new Error(`Bad number ${JSON.stringify(token)} in path ${JSON.stringify(d)}`);
      }
      return Number(token);
    };
    const flag = (): boolean => {
      const token = tokens[at++];
      if (token !== '0' && token !== '1') {
        throw new Error(`Bad arc flag ${JSON.stringify(token)} in path ${JSON.stringify(d)}`);
      }
      return token === '1';
    };
    const point = (): SvgPoint => ({ x: number(), y: number() });
    let start: SvgPoint | null = null;
    let pen: SvgPoint | null = null;
    while (at < tokens.length) {
      const command = tokens[at++];
      if (command === 'M') {
        start = point();
        pen = start;
        continue;
      }
      if (!pen || !start) {
        throw new Error(`Path does not start with M: ${JSON.stringify(d)}`);
      }
      const from: SvgPoint = pen;
      switch (command) {
        case 'L':
          segments.push({ command, from, to: point() });
          break;
        case 'Q': {
          const control = point();
          segments.push({ command, from, control, to: point() });
          break;
        }
        case 'C': {
          const control1 = point();
          const control2 = point();
          segments.push({ command, from, control1, control2, to: point() });
          break;
        }
        case 'A': {
          const rx = number();
          const ry = number();
          const rotation = number();
          const largeArc = flag();
          const sweep = flag();
          segments.push({ command, from, rx, ry, rotation, largeArc, sweep, to: point() });
          break;
        }
        case 'Z':
          segments.push({ command, from, to: start });
          break;
        default:
          throw new Error(`Unexpected path command ${JSON.stringify(command)} in ${JSON.stringify(d)}`);
      }
      pen = segments[segments.length - 1].to;
    }
    return segments;
  }

  /** `count + 1` points along the segment, evenly spaced in its own parameter, both ends included. */
  static sample(segment: SvgSegment, count: number): SvgPoint[] {
    const points: SvgPoint[] = [];
    switch (segment.command) {
      case 'L':
      case 'Z':
        for (let i = 0; i <= count; i++) {
          const t = i / count;
          points.push({
            x: segment.from.x + (segment.to.x - segment.from.x) * t,
            y: segment.from.y + (segment.to.y - segment.from.y) * t,
          });
        }
        return points;
      case 'Q':
        for (let i = 0; i <= count; i++) {
          const t = i / count;
          const r = 1 - t;
          points.push({
            x: r * r * segment.from.x + 2 * r * t * segment.control.x + t * t * segment.to.x,
            y: r * r * segment.from.y + 2 * r * t * segment.control.y + t * t * segment.to.y,
          });
        }
        return points;
      case 'C':
        for (let i = 0; i <= count; i++) {
          const t = i / count;
          const r = 1 - t;
          const [k0, k1, k2, k3] = [r * r * r, 3 * r * r * t, 3 * r * t * t, t * t * t];
          points.push({
            x: k0 * segment.from.x + k1 * segment.control1.x + k2 * segment.control2.x + k3 * segment.to.x,
            y: k0 * segment.from.y + k1 * segment.control1.y + k2 * segment.control2.y + k3 * segment.to.y,
          });
        }
        return points;
      case 'A': {
        const arc = SvgReader.arcCenter(segment);
        const cos = Math.cos(arc.phi);
        const sin = Math.sin(arc.phi);
        for (let i = 0; i <= count; i++) {
          const theta = arc.theta + (arc.delta * i) / count;
          const x = arc.rx * Math.cos(theta);
          const y = arc.ry * Math.sin(theta);
          points.push({ x: arc.cx + cos * x - sin * y, y: arc.cy + sin * x + cos * y });
        }
        return points;
      }
    }
  }

  /**
   * An arc's centre parameterisation from its end points — the conversion of
   * the SVG specification (implementation notes, "endpoint to centre"),
   * radii scaled up when they are too small to span the two ends.
   */
  static arcCenter(arc: Extract<SvgSegment, { command: 'A' }>): {
    cx: number; cy: number; rx: number; ry: number; phi: number; theta: number; delta: number;
  } {
    const phi = (arc.rotation * Math.PI) / 180;
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    const dx = (arc.from.x - arc.to.x) / 2;
    const dy = (arc.from.y - arc.to.y) / 2;
    const x1 = cos * dx + sin * dy;
    const y1 = -sin * dx + cos * dy;
    let rx = Math.abs(arc.rx);
    let ry = Math.abs(arc.ry);
    const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if (lambda > 1) {
      rx *= Math.sqrt(lambda);
      ry *= Math.sqrt(lambda);
    }
    const numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    const denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    const factor = (arc.largeArc === arc.sweep ? -1 : 1) * Math.sqrt(Math.max(0, numerator / denominator));
    const cxp = (factor * rx * y1) / ry;
    const cyp = (-factor * ry * x1) / rx;
    const cx = cos * cxp - sin * cyp + (arc.from.x + arc.to.x) / 2;
    const cy = sin * cxp + cos * cyp + (arc.from.y + arc.to.y) / 2;
    const angle = (ux: number, uy: number, vx: number, vy: number): number =>
      Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const theta = angle(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
    let delta = angle((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
    if (!arc.sweep && delta > 0) {
      delta -= 2 * Math.PI;
    } else if (arc.sweep && delta < 0) {
      delta += 2 * Math.PI;
    }
    return { cx, cy, rx, ry, phi, theta, delta };
  }
}

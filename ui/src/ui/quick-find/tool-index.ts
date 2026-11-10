/**
 * Every tool the toolbars offer, as one list the Quick Find popover searches
 * (`QuickFindPopover`). A surface registers each of its tools when it builds
 * the button (the create/modify feature buttons, the Custom dropdown's
 * cells, the sketch tools, the constraint bar, the assembly tools, Finish
 * Sketch) and takes it out when the button goes. The entry answers live:
 * whether the tool is on the bar right now (the bench, a sketch up, a
 * dialog hiding it), whether its button is disabled, whether it is armed —
 * so the popover never holds a stale copy of the toolbar's state.
 */

export type QuickFindTool = {
  /**
   * A stable name: `<bench>:<tool>` (`part:extrude`, `sketch:line`,
   * `constraint:tangent`, `assembly:fastened`, `custom:<feature id>`). The
   * pins are kept by it, so it must not change between sessions.
   */
  readonly id: string;
  /** The button's caption. */
  readonly label: string;
  /** What the tool does: the button's tooltip. */
  readonly tip: string;
  /** Where the tool lives, as a result row says it when the tip adds nothing: Part, Sketch, Constraint, Assembly, Custom. */
  readonly bench: string;
  /** The button's PNG, or null when {@link iconSvg} draws it. */
  readonly iconSrc: string | null;
  /** Inline SVG for a tool without a PNG (Finish Sketch). */
  readonly iconSvg?: string;
  /** The letter chord that also fires it, where there is one. */
  readonly shortcut?: string;
  /** More words that find it: what other CAD tools call it. */
  readonly keywords?: readonly string[];
  /** On the bar right now: the bench shows it and nothing hides it. */
  isAvailable(): boolean;
  /** Shown but refusing a click (the Sketch button while a dialog is armed, a constraint the picks don't allow). */
  isDisabled?(): boolean;
  /** Why it is disabled, when the button says. */
  disabledReason?(): string | null;
  /** Armed: its dialog is open or the tool is the active one. */
  isActive?(): boolean;
  /** Exactly what a click on the button does. */
  run(): void;
};

/** A search hit: the tool and how well the words matched (higher first). */
export type ToolMatch = { tool: QuickFindTool; score: number };

/**
 * What other CAD applications call the tool, so a user arriving from one
 * finds it by the name they know. Keyed by tool id; the index adds them to
 * a tool's own keywords.
 */
export const TOOL_SYNONYMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'part:sketch': ['draw', 'profile', 'new sketch'],
  'part:extrude': ['pad', 'boss', 'pull', 'push'],
  'part:revolve': ['turn', 'lathe', 'spin'],
  'part:sweep': ['path', 'along'],
  'part:loft': ['blend', 'between'],
  'part:helix': ['spiral', 'thread', 'coil', 'spring'],
  'part:rib': ['web', 'stiffener'],
  'part:hole': ['drill', 'bore', 'counterbore', 'countersink', 'tap'],
  'part:shell': ['hollow', 'thickness', 'thin'],
  'part:wrap': ['emboss', 'project'],
  'part:plane': ['datum', 'work plane', 'offset plane'],
  'part:fillet': ['round', 'radius', 'blend'],
  'part:chamfer': ['bevel', 'break edge'],
  'part:offset': ['thicken', 'face offset'],
  'part:repeat': ['pattern', 'array', 'linear', 'circular', 'instances'],
  'part:copy': ['duplicate', 'clone'],
  'part:mirror': ['symmetry', 'flip', 'reflect'],
  'part:translate': ['move', 'shift', 'position'],
  'part:rotate': ['turn', 'angle', 'orient'],
  'part:split': ['cut', 'divide', 'slice'],
  'part:boolean': ['union', 'fuse', 'subtract', 'cut', 'intersect', 'combine', 'merge'],
  'part:color': ['appearance', 'paint', 'material', 'colour'],
  'part:connector': ['mate frame', 'attachment', 'joint origin'],
  'part:part': ['body', 'component', 'new part'],
  'part:finish-sketch': ['close sketch', 'exit sketch', 'done', 'leave sketch'],
  'sketch:line': ['segment', 'edge'],
  'sketch:polyline': ['wire', 'chain', 'lines'],
  'sketch:bezier': ['curve', 'handles'],
  'sketch:spline': ['curve', 'smooth', 'fit points'],
  'sketch:circle': ['round', 'disc'],
  'sketch:ellipse': ['oval'],
  'sketch:polygon': ['hexagon', 'pentagon', 'octagon', 'triangle'],
  'sketch:rect': ['rectangle', 'square', 'box', 'rounded rectangle'],
  'sketch:arc3': ['three point arc', 'arc'],
  'sketch:arc2': ['center arc', 'arc', 'centre'],
  'sketch:slot': ['keyway', 'rounded slot'],
  'sketch:text': ['letters', 'font', 'engrave', 'label'],
  'sketch:image': ['picture', 'photo', 'scan', 'trace', 'reference'],
  'sketch:fillet': ['round', 'corner', 'radius'],
  'sketch:offset': ['parallel', 'inset', 'outset'],
  'sketch:split': ['break', 'divide'],
  'sketch:trim': ['cut', 'remove', 'erase'],
  'sketch:project': ['reference', 'projection', 'use edge'],
  'sketch:intersect': ['section', 'intersection'],
  'sketch:copy': ['duplicate', 'clone', 'pattern'],
  'sketch:mirror': ['symmetry', 'flip', 'reflect'],
  'sketch:guide': ['construction', 'reference line', 'centerline'],
  'constraint:coincident': ['join', 'snap', 'touch points'],
  'constraint:horizontal': ['level', 'flat'],
  'constraint:vertical': ['upright', 'plumb'],
  'constraint:parallel': ['same direction'],
  'constraint:perpendicular': ['right angle', 'normal', 'orthogonal'],
  'constraint:tangent': ['touch', 'smooth'],
  'constraint:equal': ['same length', 'same size', 'same radius'],
  'constraint:concentric': ['same center', 'coaxial'],
  'constraint:collinear': ['same line', 'aligned'],
  'constraint:midpoint': ['middle', 'center of line'],
  'constraint:symmetric': ['mirror', 'symmetry', 'about'],
  'constraint:fix': ['lock', 'anchor', 'ground', 'pin'],
  'constraint:dimension': ['distance', 'length', 'measure', 'size', 'radius', 'diameter', 'smart dimension'],
  'constraint:angle': ['degrees', 'angular dimension'],
  'assembly:insert': ['place', 'add part', 'import part', 'instance'],
  'assembly:fastened': ['fixed', 'rigid', 'lock', 'weld'],
  'assembly:revolute': ['hinge', 'pin', 'rotate', 'revolute joint'],
  'assembly:slider': ['prismatic', 'slide', 'translate', 'linear'],
  'assembly:cylindrical': ['pin slide', 'rotate and slide'],
  'assembly:planar': ['plane', 'slide on face'],
  'assembly:tangent': ['touch', 'roll'],
  'assembly:gear': ['ratio', 'couple rotations'],
  'assembly:rack': ['rack and pinion', 'pinion', 'linear gear'],
  'assembly:replicate': ['copy mates', 'pattern instances', 'repeat part'],
  'assembly:connector': ['mate frame', 'assembly connector'],
});

/** Lower-case words, punctuation dropped, one space between them. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Whether `query`'s characters appear in `text` in order (`shl` in `shell`). */
function isSubsequence(query: string, text: string): boolean {
  let at = 0;
  for (const ch of text) {
    if (ch === query[at]) {
      at++;
      if (at === query.length) {
        return true;
      }
    }
  }
  return at === query.length;
}

/** How well one tool answers `query` (already normalized); 0 when it doesn't. */
export function scoreTool(tool: QuickFindTool, query: string): number {
  if (query === '') {
    return 0;
  }
  const label = normalize(tool.label);
  const words = [...(tool.keywords ?? []), ...(TOOL_SYNONYMS[tool.id] ?? [])].map(normalize);
  const tip = normalize(tool.tip);
  if (label === query) {
    return 100;
  }
  if (label.startsWith(query)) {
    return 90;
  }
  if (label.split(' ').some(word => word.startsWith(query))) {
    return 80;
  }
  if (label.includes(query)) {
    return 70;
  }
  if (words.some(word => word === query || word.startsWith(query))) {
    return 60;
  }
  if (words.some(word => word.split(' ').some(part => part.startsWith(query)))) {
    return 50;
  }
  if (tip.split(' ').some(word => word.startsWith(query))) {
    return 40;
  }
  // Several words: each must land somewhere in the tool's own words.
  const parts = query.split(' ');
  if (parts.length > 1) {
    const haystack = `${label} ${words.join(' ')} ${tip}`;
    if (parts.every(part => haystack.includes(part))) {
      return 35;
    }
    return 0;
  }
  // Letters in order inside the name (`shl` for Shell), from its first
  // letter on: short enough to type, long enough not to catch everything.
  if (query.length >= 3 && query[0] === label[0] && isSubsequence(query, label.replace(/ /g, ''))) {
    return 20;
  }
  return 0;
}

export class ToolIndex {
  private readonly tools = new Map<string, QuickFindTool>();
  private readonly listeners = new Set<() => void>();

  /**
   * List a tool; the returned function takes it out again. A second entry
   * under the same id replaces the first (a toolbar rebuilt after a catalog
   * change registers its buttons anew).
   */
  register(tool: QuickFindTool): () => void {
    this.tools.set(tool.id, tool);
    this.emit();
    return () => {
      if (this.tools.get(tool.id) === tool) {
        this.tools.delete(tool.id);
        this.emit();
      }
    };
  }

  get(id: string): QuickFindTool | null {
    return this.tools.get(id) ?? null;
  }

  /** Every registered tool, in registration order. */
  all(): QuickFindTool[] {
    return [...this.tools.values()];
  }

  /** The tools on the bar right now, in registration order. */
  available(): QuickFindTool[] {
    return this.all().filter(tool => tool.isAvailable());
  }

  /**
   * The available tools matching `query`, best first; same score, by label.
   * At most `limit` of them.
   */
  search(query: string, limit = 8): ToolMatch[] {
    const q = normalize(query);
    if (q === '') {
      return [];
    }
    const matches: ToolMatch[] = [];
    for (const tool of this.available()) {
      const score = scoreTool(tool, q);
      if (score > 0) {
        matches.push({ tool, score });
      }
    }
    matches.sort((a, b) => b.score - a.score || a.tool.label.localeCompare(b.tool.label) || a.tool.id.localeCompare(b.tool.id));
    return matches.slice(0, limit);
  }

  /** Hear every registration and removal (an open popover draws again). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/** The page's one index, which every toolbar registers into. */
export const toolIndex = new ToolIndex();

/**
 * Whether `el` is shown: connected, and neither it nor an ancestor is hidden
 * by the classes the bars use (`hidden`, `feature-sketch-hidden`) or an
 * inline `display: none` (a frozen navbar's overrides). Class-based on
 * purpose: the tests run without layout, and so does the first paint.
 */
export function isShownOnBar(el: Element): boolean {
  if (!el.isConnected) {
    return false;
  }
  for (let node: Element | null = el; node && node !== document.body; node = node.parentElement) {
    if (node.classList.contains('hidden') || node.classList.contains('feature-sketch-hidden')) {
      return false;
    }
    if (node instanceof HTMLElement && node.style.display === 'none') {
      return false;
    }
  }
  return true;
}

/** `Finish Sketch` → `finish-sketch`: a tool id's tail from its caption. */
export function toolSlug(label: string): string {
  return normalize(label).replace(/ /g, '-');
}

import { SceneObject, type BuildSceneObjectContext } from "../common/scene-object.js";
import { Plane } from "../math/plane.js";
import { Matrix4 } from "../math/matrix4.js";
import { PlaneObjectBase } from "../features/plane-renderable-base.js";
import { FeatureCall } from "./call-shape.js";

/**
 * One frame a feature class declares (`Feature.with(params, { frames })`):
 * a named coordinate frame its build sets — a gear's axis, a bracket's
 * mounting face — that a model reads back as a plane with
 * `feature.frame(name)`, and that a generated part (`definePart`) turns into
 * a connector of the same name.
 */
export type FeatureFrameSpec = {
  /** What the editor calls it; left out, the name made readable (`mountFace` → "Mount face"). */
  label?: string;
};

/** A feature class's frame declarations, by name. */
export type FeatureFrameSpecs = Record<string, FeatureFrameSpec>;

/** What `setFrames()` takes: each declared frame's plane, by name — origin, X direction and normal (Z). */
export type NamedFrames<F extends string> = { [K in F]?: Plane };

/** One declared frame, checked. */
type DeclaredFrame = { name: string; label: string };

/**
 * What a frame reference reads its plane from: a feature whose build set
 * it (see `Feature.builtFrame`).
 */
export type FrameSource = SceneObject & { builtFrame(name: string): Plane };

/**
 * A feature class's declared frames: the one place a declaration is checked,
 * and what the feature and `definePart` ask about them.
 *
 * A class declares its frames with `Feature.with(params, { frames })` — or,
 * the plain-subclass way, `static frames = { … }`. A frame's name is an
 * identifier (it becomes a connector's name: `insert(gearPart).connectors.axis`);
 * its declaration holds only an optional `label`. The build sets each frame
 * with `setFrames({ axis: plane })`; the built frames live in the feature's
 * state, moved with a repeat's copy like the solids.
 */
export class FeatureFrameSet {

  /** A frame's name: an identifier, as a connector's name is. */
  static readonly PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

  /** The longest frame name, in characters. */
  static readonly MAX_NAME_LENGTH = 48;

  /** The most frames one class declares. */
  static readonly MAX_FRAMES = 16;

  /** Where a built feature keeps its frames: one record of planes by name. */
  static readonly STATE_KEY = 'feature-frames';

  /** A set with no declarations: a class that declares no frames. */
  static readonly EMPTY = new FeatureFrameSet([]);

  private static readonly FIELDS = ['label'];

  /** Each class's checked set, by the class asked about — a subclass and the class declaring its frames alike. */
  private static readonly sets = new WeakMap<Function, FeatureFrameSet>();

  private constructor(private readonly frames: readonly DeclaredFrame[]) {}

  /**
   * The checked set of a feature class: the frames declared by the nearest
   * class in its chain that declares any — checked the first time it is
   * asked, so a bad declaration fails where the module loads
   * (`Feature.with()`, `registerBuilder`, `definePart`). `where` names the
   * declaring class in refusals; by default its id or name.
   */
  static of(featureClass: Function, where?: string): FeatureFrameSet {
    const known = FeatureFrameSet.sets.get(featureClass);
    if (known) {
      return known;
    }
    const owner = FeatureFrameSet.ownerOf(featureClass);
    let set = FeatureFrameSet.EMPTY;
    if (owner === featureClass) {
      set = FeatureFrameSet.declare(owner, where ?? FeatureFrameSet.whereOf(owner));
    } else if (owner) {
      set = FeatureFrameSet.of(owner);
    }
    FeatureFrameSet.sets.set(featureClass, set);
    return set;
  }

  /** The declared frames' names, in declaration order. */
  names(): string[] {
    return this.frames.map(frame => frame.name);
  }

  /** Whether `name` is a declared frame. */
  has(name: string): boolean {
    return this.frames.some(frame => frame.name === name);
  }

  /** What the editor calls a frame: its declared label, else its name made readable. */
  labelOf(name: string): string {
    return this.frames.find(frame => frame.name === name)?.label ?? FeatureFrameSet.humanize(name);
  }

  /**
   * Refuse a frame `frame(name)` asks for that the class doesn't declare,
   * leading with the feature's `type`.
   */
  checkName(name: unknown, type: string): void {
    if (typeof name !== 'string' || !this.has(name)) {
      throw new Error(`${type}: ${typeof name === 'string' ? `'${name}'` : FeatureFrameSet.describe(name)} is not a frame of the feature — ${this.listing()}`);
    }
  }

  /**
   * Refuse what `setFrames()` is handed that it would otherwise lose
   * silently: a name the class doesn't declare, a value that is not a
   * plane. A value left `undefined` sets nothing. `type` is the feature's
   * type, which every refusal leads with.
   */
  checkFilled(frames: unknown, type: string): void {
    const fail = (message: string): never => {
      throw new Error(`${type}: setFrames() ${message}`);
    };
    if (!FeatureCall.isPlainObject(frames)) {
      fail(`takes the frames by name, such as { axis: plane } — got ${FeatureFrameSet.describe(frames)}`);
    }
    for (const [name, value] of Object.entries(frames as Record<string, unknown>)) {
      if (value === undefined) {
        continue;
      }
      if (!this.has(name)) {
        fail(`'${name}' is not a frame of the feature — ${this.listing()}`);
      }
      if (!(value instanceof Plane)) {
        fail(`${name} must be a plane (a Plane: origin, X direction and normal), got ${FeatureFrameSet.describe(value)}`);
      }
    }
  }

  /** Every frame in `frames` moved by `matrix` — a repeat's copy moves its frames with its solids. */
  static moved(frames: Readonly<Record<string, Plane>>, matrix: Matrix4): Record<string, Plane> {
    return Object.fromEntries(Object.entries(frames).map(([name, plane]) => [name, plane.applyMatrix(matrix)]));
  }

  private listing(): string {
    const names = this.names();
    return names.length === 0
      ? 'it declares none; declare one with Feature.with(params, { frames: { axis: {} } })'
      : `its frames are ${names.join(', ')}`;
  }

  /** The nearest class in `featureClass`'s chain that declares `frames` of its own, or null. */
  private static ownerOf(featureClass: Function): Function | null {
    for (let cls: unknown = featureClass; typeof cls === 'function' && cls !== Function.prototype; cls = Object.getPrototypeOf(cls)) {
      if (Object.prototype.hasOwnProperty.call(cls, 'frames')) {
        return cls as Function;
      }
    }
    return null;
  }

  /** Check `owner`'s declarations. */
  private static declare(owner: Function, where: string): FeatureFrameSet {
    const fail = (message: string): never => {
      throw new Error(`${where}: ${message}`);
    };
    const specs = (owner as { frames?: unknown }).frames;
    if (!FeatureCall.isPlainObject(specs)) {
      fail(`'frames' must be an object of the feature's frames by name, such as { axis: {}, mount: { label: 'Mounting face' } } — got ${FeatureFrameSet.describe(specs)}`);
    }
    const names = Object.keys(specs as object);
    if (names.length > FeatureFrameSet.MAX_FRAMES) {
      fail(`declares ${names.length} frames — a feature declares at most ${FeatureFrameSet.MAX_FRAMES}`);
    }
    return new FeatureFrameSet(names.map(name => FeatureFrameSet.checked(name, (specs as Record<string, unknown>)[name], fail)));
  }

  /** One declaration, checked: its name, then its fields. */
  private static checked(name: string, spec: unknown, fail: (message: string) => never): DeclaredFrame {
    if (!FeatureFrameSet.PATTERN.test(name)) {
      fail(`the frame name '${name}' is not an identifier — a frame becomes a connector of its name, such as axis or mountFace`);
    }
    if (name.length > FeatureFrameSet.MAX_NAME_LENGTH) {
      fail(`the frame name '${name}' is longer than ${FeatureFrameSet.MAX_NAME_LENGTH} characters`);
    }
    if (!FeatureCall.isPlainObject(spec)) {
      fail(`frame '${name}' is declared with an object — {} or { label } — got ${FeatureFrameSet.describe(spec)}`);
    }
    const declared = spec as Record<string, unknown>;
    for (const field of Object.keys(declared)) {
      if (!FeatureFrameSet.FIELDS.includes(field)) {
        fail(`frame '${name}': unknown field '${field}' — a frame declares only its ${FeatureFrameSet.FIELDS.join(' and ')}`);
      }
    }
    const { label } = declared;
    if (label !== undefined && (typeof label !== 'string' || label.trim() === '')) {
      fail(`frame '${name}': 'label' must be text that says something, got ${FeatureFrameSet.describe(label)}`);
    }
    return { name, label: (label as string | undefined) ?? FeatureFrameSet.humanize(name) };
  }

  /** Who a refusal names: the feature by its id, else the class by its name. */
  private static whereOf(featureClass: Function): string {
    const id = (featureClass as { id?: unknown }).id;
    if (typeof id === 'string' && id !== '') {
      return `feature '${id}'`;
    }
    return featureClass.name || 'a feature class';
  }

  /** `mountFace` → `Mount face`. */
  private static humanize(name: string): string {
    const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_$-]+/g, ' ').trim().toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  /** What a refusal says a value is. */
  private static describe(value: unknown): string {
    if (value === undefined) {
      return 'nothing';
    }
    if (value === null) {
      return 'null';
    }
    if (typeof value === 'string') {
      return `'${value}'`;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (Array.isArray(value)) {
      return 'a list';
    }
    return typeof value === 'function' ? 'a function' : 'an object';
  }
}

/**
 * A frame a feature's build set, read as a plane: what `feature.frame(name)`
 * returns. It builds after the feature and holds the frame where the
 * feature's build left it, so it is a `connector()` source (`connector('axis',
 * g.frame('axis'))`) and a `plane()` input (`plane(g.frame('axis'), 5)`). It
 * draws nothing and lists no timeline row of its own: like `e.endFaces()`,
 * it stands for part of the feature.
 */
export class FeatureFrame extends PlaneObjectBase {

  constructor(
    private readonly source: FrameSource,
    /** The frame's declared name. */
    readonly frameName: string,
  ) {
    super();
    this.markInternal();
  }

  /** The feature whose frame this reads. */
  getSource(): FrameSource {
    return this.source;
  }

  build(_context?: BuildSceneObjectContext): void {
    // The feature's own build already placed it — a repeat's copy moves its
    // frames with its solids — so the frame is read as it stands.
    this.setState('plane', this.source.builtFrame(this.frameName));
  }

  override isLazy(): boolean {
    return true;
  }

  override getDependencies(): SceneObject[] {
    return [this.source];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    return new FeatureFrame((remap.get(this.source) as FrameSource | undefined) ?? this.source, this.frameName);
  }

  override compareTo(other: SceneObject): boolean {
    if (!(other instanceof FeatureFrame) || other.frameName !== this.frameName) {
      return false;
    }
    if (!super.compareTo(other)) {
      return false;
    }
    return this.source.compareTo(other.source);
  }

  override getUniqueType(): string {
    return 'feature-frame';
  }

  serialize() {
    return { frame: this.frameName };
  }
}

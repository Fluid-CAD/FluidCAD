import { Sketch } from "./sketch.js";
import { SceneObject } from "../../common/scene-object.js";
import { Edge } from "../../common/edge.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";
import { ExtrudableGeometryBase } from "./extrudable-base.js";
import { IText } from "../../core/interfaces.js";
import { FontRegistry } from "../../io/font-registry.js";
import { TextOutline, type TextAlign } from "../../oc/text-outline.js";

const WEIGHT_NAMES: Record<string, number> = {
  thin: 100, extralight: 200, ultralight: 200, light: 300, regular: 400,
  normal: 400, medium: 500, semibold: 600, demibold: 600, bold: 700,
  extrabold: 800, ultrabold: 800, black: 900, heavy: 900,
};

/**
 * 3D text as an extrudable outline profile. Glyph outlines are produced via
 * fontkit and converted to sketch edges; extruding the result gives raised or
 * cut lettering. Works standalone on a plane (`text("xy", "Hi")`) or inside a
 * `sketch()` (`text("Hi")`).
 */
export class Text extends ExtrudableGeometryBase implements IText {
  private _size = 10;
  private _font?: string;
  private _weight = 400;
  private _italic = false;
  private _align: TextAlign = "left";
  private _lineSpacing = 1;
  private _letterSpacing = 0;

  constructor(public text: string, targetPlane: PlaneObjectBase = null) {
    super(targetPlane);
  }

  build(): void {
    const plane = this.targetPlane
      ? this.targetPlane.getPlane()
      : (this.getParent() as Sketch).getPlane();
    const origin = this.targetPlane
      ? plane.worldToLocal(this.targetPlane.getPlaneCenter())
      : this.getCurrentPosition();

    const font = FontRegistry.resolve({ font: this._font, weight: this._weight, italic: this._italic });

    const edges: Edge[] = TextOutline.buildEdges(
      font,
      this.text,
      {
        size: this._size,
        align: this._align,
        lineSpacing: this._lineSpacing,
        letterSpacing: this._letterSpacing,
      },
      plane,
      origin,
    );

    this.addShapes(edges);

    if (this.targetPlane) {
      this.targetPlane.removeShapes(this);
    }
  }

  size(value: number): this {
    this._size = value;
    return this;
  }

  font(name: string): this {
    this._font = name;
    return this;
  }

  weight(value: number | string): this {
    this._weight = typeof value === "number" ? value : (WEIGHT_NAMES[value.toLowerCase()] ?? 400);
    return this;
  }

  bold(): this {
    this._weight = 700;
    return this;
  }

  italic(value: boolean = true): this {
    this._italic = value;
    return this;
  }

  align(value: TextAlign): this {
    this._align = value;
    return this;
  }

  lineSpacing(value: number): this {
    this._lineSpacing = value;
    return this;
  }

  letterSpacing(value: number): this {
    this._letterSpacing = value;
    return this;
  }

  getType(): string {
    return "text";
  }

  override getDependencies(): SceneObject[] {
    return this.targetPlane ? [this.targetPlane] : [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const targetPlane = this.targetPlane
      ? (remap.get(this.targetPlane) as PlaneObjectBase || this.targetPlane)
      : null;
    const copy = new Text(this.text, targetPlane);
    copy._size = this._size;
    copy._font = this._font;
    copy._weight = this._weight;
    copy._italic = this._italic;
    copy._align = this._align;
    copy._lineSpacing = this._lineSpacing;
    copy._letterSpacing = this._letterSpacing;
    return copy;
  }

  override compareTo(other: Text): boolean {
    if (!(other instanceof Text)) {
      return false;
    }
    if (!super.compareTo(other)) {
      return false;
    }
    if (this.targetPlane?.constructor !== other.targetPlane?.constructor) {
      return false;
    }
    if (this.targetPlane && other.targetPlane && !this.targetPlane.compareTo(other.targetPlane)) {
      return false;
    }
    return this.text === other.text
      && this._size === other._size
      && this._font === other._font
      && this._weight === other._weight
      && this._italic === other._italic
      && this._align === other._align
      && this._lineSpacing === other._lineSpacing
      && this._letterSpacing === other._letterSpacing;
  }

  serialize() {
    return {
      text: this.text,
      size: this._size,
      font: this._font,
      weight: this._weight,
      italic: this._italic,
      align: this._align,
      lineSpacing: this._lineSpacing,
      letterSpacing: this._letterSpacing,
    };
  }
}

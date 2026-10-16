import {
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  Scene,
  SRGBColorSpace,
  Texture,
  Vector3,
} from 'three';
import type { PlaneData, SketchImageData } from '../types';
import type { LoadedImage, PixelSize } from './reference-image-loader';

/**
 * Slotted under the sketch's own lines (renderOrder 1, drawn without a depth
 * test) and above the grid (0): the picture is drawn in the transparent pass,
 * so the sketch lines land over it in order, whatever its opacity.
 */
const RENDER_ORDER = 0.5;

/** Where a placed picture sits: its centre, its orientation and its size in document units. */
export type ImagePlacement = {
  position: Vector3;
  quaternion: Quaternion;
  width: number;
  height: number;
};

function toVec3(v: { x: number; y: number; z: number }): Vector3 {
  return new Vector3(v.x, v.y, v.z);
}

/**
 * The reference picture of the sketch being edited: one textured quad on
 * the sketch plane, faded by its opacity. Scene furniture, not model
 * content — it is added straight to the scene (never the compiled mesh,
 * so the sketch-mode ghost tint and the section clip leave it alone) and
 * flagged `isMetaShape` so camera fits ignore it.
 *
 * Depth: it draws in the transparent pass with no depth write and a
 * `0.5 / 0.5` polygon offset — the same slot the face overlays use between
 * edge lines (offset 0) and base faces (+1/+1). So it covers the face being
 * sketched on and the grid, and body edges and the sketch's lines stay
 * crisp on top, with nothing nudged in world units.
 */
export class SketchReferenceImage {
  /** The scene node: a group holding the quad, named for lookups. */
  readonly object: Group;
  private readonly mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private texture: Texture | null = null;
  private pixel: PixelSize | null = null;

  constructor(private readonly scene: Scene) {
    this.object = new Group();
    this.object.name = 'sketchReferenceImage';
    this.object.userData.isMetaShape = true;
    this.object.visible = false;
    const material = new MeshBasicMaterial({
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: 0.5,
      polygonOffsetUnits: 0.5,
      side: DoubleSide,
      // The picture's own colours, not the scene's tone mapping of them.
      toneMapped: false,
    });
    this.mesh = new Mesh(new PlaneGeometry(1, 1), material);
    this.mesh.renderOrder = RENDER_ORDER;
    this.mesh.userData.isMetaShape = true;
    this.object.add(this.mesh);
    this.scene.add(this.object);
  }

  /** The decoded picture's pixel size, once one is set. */
  get pixelSize(): PixelSize | null {
    return this.pixel;
  }

  get visible(): boolean {
    return this.object.visible;
  }

  /** Swap the picture (null clears it and hides the quad). The previous texture is freed. */
  setImage(image: LoadedImage | null): void {
    this.texture?.dispose();
    this.texture = null;
    this.pixel = null;
    if (!image) {
      this.mesh.material.map = null;
      this.mesh.material.needsUpdate = true;
      this.object.visible = false;
      return;
    }
    const texture = new Texture(image.source as any);
    texture.colorSpace = SRGBColorSpace;
    // Canvas-space images read top-down; the quad's UVs run bottom-up. WebGL
    // ignores the unpack flip for an ImageBitmap (the loader's usual
    // decode), so a bitmap is flipped by the texture's UV transform instead.
    if (typeof ImageBitmap !== 'undefined' && image.source instanceof ImageBitmap) {
      texture.flipY = false;
      texture.repeat.set(1, -1);
      texture.offset.set(0, 1);
    } else {
      texture.flipY = true;
    }
    texture.needsUpdate = true;
    this.texture = texture;
    this.pixel = { width: image.width, height: image.height };
    this.mesh.material.map = texture;
    this.mesh.material.needsUpdate = true;
  }

  /** Put the quad on `plane` as `spec` says, and show it. Needs a picture for a one-sided size. */
  place(plane: PlaneData, spec: SketchImageData): void {
    const placement = SketchReferenceImage.placement(plane, spec, this.pixel);
    this.object.position.copy(placement.position);
    this.object.quaternion.copy(placement.quaternion);
    this.object.scale.set(placement.width, placement.height, 1);
    this.mesh.material.opacity = spec.opacity;
    this.object.visible = this.texture !== null;
  }

  hide(): void {
    this.object.visible = false;
  }

  dispose(): void {
    this.scene.remove(this.object);
    this.texture?.dispose();
    this.texture = null;
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }

  /**
   * The quad's pose for `spec` on `plane`: centred at `at` in the plane's
   * frame, its x axis turned `angle` degrees from the plane's x direction
   * about the normal, sized by {@link resolveSize}.
   */
  static placement(plane: PlaneData, spec: SketchImageData, pixel: PixelSize | null): ImagePlacement {
    const origin = toVec3(plane.origin);
    const xDir = toVec3(plane.xDirection).normalize();
    const yDir = toVec3(plane.yDirection).normalize();
    const normal = toVec3(plane.normal).normalize();
    const position = origin.clone().addScaledVector(xDir, spec.at[0]).addScaledVector(yDir, spec.at[1]);

    const rad = (spec.angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const x = xDir.clone().multiplyScalar(cos).addScaledVector(yDir, sin);
    const y = yDir.clone().multiplyScalar(cos).addScaledVector(xDir, -sin);
    const quaternion = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, normal));

    const { width, height } = SketchReferenceImage.resolveSize(spec, pixel);
    return { position, quaternion, width, height };
  }

  /**
   * The size on the plane: both dimensions as written, or the missing one
   * from the picture's pixel aspect. Without a picture yet, a one-sided
   * spec is square — the quad is hidden until the bytes arrive anyway.
   */
  static resolveSize(spec: Pick<SketchImageData, 'width' | 'height'>, pixel: PixelSize | null): { width: number; height: number } {
    const aspect = pixel && pixel.width > 0 && pixel.height > 0 ? pixel.width / pixel.height : 1;
    if (spec.width !== undefined && spec.height !== undefined) {
      return { width: spec.width, height: spec.height };
    }
    if (spec.width !== undefined) {
      return { width: spec.width, height: spec.width / aspect };
    }
    if (spec.height !== undefined) {
      return { width: spec.height * aspect, height: spec.height };
    }
    return { width: 1, height: 1 / aspect };
  }
}

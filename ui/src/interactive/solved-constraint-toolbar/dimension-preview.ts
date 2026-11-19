// The dimension the constraint bar is in the middle of creating, drawn the
// way the sketch will draw it once it is written.
//
// The candidate goes through the SAME glyph pass and mesh builder as a
// committed statement (sketch-solver-client/glyphs.ts → solved-constraint
// meshes), so a dimension placed as it is drawn — its line through the
// cursor, its witness lines, its arrowheads, its value — is the picture the
// commit leaves behind. Nothing here is pickable: the meshes live in a scene
// group of their own, outside the sketch mesh and its hit targets.

import { Group } from 'three';
import { SceneContext } from '../../scene/scene-context';
import { themeColors } from '../../scene/theme-colors';
import { addFrameHook } from '../../meshes/frame-hooks';
import { buildSolvedConstraintMeshes } from '../../meshes/containers/solved-constraint-meshes';
import type { SolvedGlyphLayout } from '../../meshes/containers/solved-glyph-layout';
import { layoutConstraintGlyphs } from '../../sketch-solver-client';
import type { SolvedConstraintView, SolvedSketchModel } from '../../sketch-solver-client';

export type DimensionPreviewOptions = {
  /**
   * Draw the dimension's value. While its value input is open the input IS
   * the value, sitting where the text would — so the text stays out.
   */
  value: boolean;
  /** The value is riding the cursor: lit like a label being dragged. */
  inHand?: boolean;
};

export class DimensionPreview {
  private group: Group | null = null;
  private layout: SolvedGlyphLayout | null = null;
  private layoutHookOff: (() => void) | null = null;

  constructor(private ctx: SceneContext) {}

  get isShown(): boolean {
    return this.group !== null;
  }

  /** Draw `constraint` — placed where its `label` says, laid out
   * automatically without one — replacing whatever was shown. */
  show(model: SolvedSketchModel, constraint: SolvedConstraintView, options: DimensionPreviewOptions): void {
    this.dispose();
    const glyphs = layoutConstraintGlyphs({ ...model, constraints: [constraint] })
      .filter(glyph => options.value || glyph.type !== 'text');
    // The mesh builder hands its layout the sketch's entities to route
    // labels around. A placed value sits where it was put, whatever is
    // drawn there — so a dimension following the cursor spares the layout
    // the tessellation of the whole sketch on every move. An automatic one
    // is routed against the geometry, as the commit will route it.
    const visuals = buildSolvedConstraintMeshes(
      constraint.label ? { ...model, entities: new Map() } : model, glyphs,
    );
    if (options.inHand) {
      for (const target of visuals.hitTargets) {
        for (const material of target.materials) {
          material.color.set(themeColors.highlightColor);
        }
      }
    }
    const group = new Group();
    group.userData.isMetaShape = true;
    for (const child of visuals.groups) {
      group.add(child);
    }
    this.ctx.scene.add(group);
    this.group = group;
    this.layout = visuals.layout;
    // The value is a screen-space sprite: the layout parks it every frame.
    this.layoutHookOff ??= addFrameHook((renderer, camera) => this.layout?.update(renderer, camera));
    this.ctx.requestRender();
  }

  clear(): void {
    if (!this.group) {
      return;
    }
    this.dispose();
    this.layoutHookOff?.();
    this.layoutHookOff = null;
    this.ctx.requestRender();
  }

  private dispose(): void {
    this.layout?.dispose();
    this.layout = null;
    if (!this.group) {
      return;
    }
    this.ctx.scene.remove(this.group);
    this.group.traverse((child) => {
      // Textures are shared through the badge-texture cache; material
      // disposal deliberately leaves them alive.
      const mesh = child as unknown as { geometry?: { dispose?(): void }; material?: { dispose?(): void } };
      mesh.geometry?.dispose?.();
      mesh.material?.dispose?.();
    });
    this.group = null;
  }
}

import type { GhostSolid } from '../../api';
import { FeatureGhostOverlay } from '../../interactive/create-feature/feature-ghost';
import type { Viewer } from '../../viewer';
import { PartThumbnailRenderer } from '../insert-part/part-thumbnails';
import { ScratchBuilds, type ScratchBuildMeshes } from './scratch-builds';

/** A tile's picture, in pixels a side: twice the Insert dialog's, for a tile half a chat panel wide on a dense screen. */
const PICTURE_SIZE = 320;
/** How many builds' meshes are kept for a second look (the ghost after the picture). */
const KEPT_BUILDS = 4;
/** How long the picture renderer outlives its last picture: a card's tiles come seconds apart. */
const RENDERER_IDLE_MS = 5000;

/**
 * Two views of a scratch build for a card that shows one: its picture (a
 * PNG, drawn off screen by the Insert dialog's thumbnail renderer) and its
 * ghost — the build's solids drawn translucent over the model in the
 * viewport, through the layer the feature dialogs preview with
 * ({@link FeatureGhostOverlay}).
 *
 * Both read the build's meshes from the engine, which keeps them for a
 * while only: a build that is gone has no picture and no ghost (null,
 * false). One renderer serves every picture and is let go when no picture
 * has been asked for a moment, since browsers cap live GL contexts.
 */
export class ScratchBuildViews {
  private renderer: PartThumbnailRenderer | null = null;
  private rendererTimer: ReturnType<typeof setTimeout> | null = null;
  /** The meshes of the builds last looked at, oldest first. */
  private readonly kept = new Map<string, ScratchBuildMeshes>();
  private overlay: FeatureGhostOverlay | null = null;
  /** The build the viewport shows, or was last asked to. */
  private ghost: string | null = null;

  constructor(private readonly viewer: Viewer) {}

  /** A PNG data URL of build `buildId`; null when the engine no longer keeps it, or it shows nothing. */
  async picture(buildId: string): Promise<string | null> {
    const meshes = await this.meshes(buildId);
    if (!meshes) {
      return null;
    }
    this.renderer ??= new PartThumbnailRenderer({ size: PICTURE_SIZE });
    try {
      return ScratchBuilds.thumbnail(this.renderer, meshes);
    } catch (err) {
      console.warn('FluidCAD: a variant could not be drawn:', err);
      return null;
    } finally {
      this.releaseRendererLater();
    }
  }

  /**
   * Draw build `buildId` over the model on screen, in place of any other
   * shown this way. False when it cannot be: the engine no longer keeps it,
   * it has no solid, or it is an assembly (its instances are posed by a
   * solve the ghost layer does not run).
   */
  async showGhost(buildId: string): Promise<boolean> {
    this.ghost = buildId;
    const meshes = await this.meshes(buildId);
    if (this.ghost !== buildId) {
      // Another build, or none, was asked for while this one loaded.
      return meshes !== null;
    }
    const solids = meshes && !meshes.assembly ? ScratchBuildViews.solidsOf(meshes) : [];
    if (solids.length === 0) {
      this.hideGhost();
      return false;
    }
    this.overlay ??= new FeatureGhostOverlay(this.viewer);
    this.overlay.set(solids, 'add');
    return true;
  }

  hideGhost(): void {
    this.ghost = null;
    this.overlay?.clear();
  }

  dispose(): void {
    this.hideGhost();
    this.overlay?.dispose();
    this.overlay = null;
    if (this.rendererTimer !== null) {
      clearTimeout(this.rendererTimer);
      this.rendererTimer = null;
    }
    this.renderer?.dispose();
    this.renderer = null;
    this.kept.clear();
  }

  /** The solids a build renders: every solid shape of a row that is on screen (the engine's own rule for counting them). */
  static solidsOf(meshes: ScratchBuildMeshes): GhostSolid[] {
    const solids: GhostSolid[] = [];
    for (const row of meshes.objects) {
      if (row.visible === false) {
        continue;
      }
      for (const shape of row.sceneShapes ?? []) {
        if (shape.shapeType === 'solid' && !shape.isMetaShape && shape.meshes.length > 0) {
          solids.push({ meshes: shape.meshes });
        }
      }
    }
    return solids;
  }

  private async meshes(buildId: string): Promise<ScratchBuildMeshes | null> {
    const kept = this.kept.get(buildId);
    if (kept) {
      return kept;
    }
    const meshes = await ScratchBuilds.meshes(buildId);
    if (meshes) {
      this.kept.set(buildId, meshes);
      for (const oldest of this.kept.keys()) {
        if (this.kept.size <= KEPT_BUILDS) {
          break;
        }
        this.kept.delete(oldest);
      }
    }
    return meshes;
  }

  private releaseRendererLater(): void {
    if (this.rendererTimer !== null) {
      clearTimeout(this.rendererTimer);
    }
    this.rendererTimer = setTimeout(() => {
      this.rendererTimer = null;
      this.renderer?.dispose();
      this.renderer = null;
    }, RENDERER_IDLE_MS);
  }
}

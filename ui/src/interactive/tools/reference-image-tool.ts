import { SketchTool, InsertGeometryFn } from '../sketch-tool';
import { SceneContext } from '../../scene/scene-context';
import { PlaneData, SceneObjectRender, SketchImageData } from '../../types';
import { SnapController } from '../../snapping/snap-controller';
import { ICON_IMAGE } from '../../ui/icons';
import { setSketchImage, type SketchImageEdit, type SetUnitResult, type SourceLocationParam } from '../../api';
import { writeWorkspaceBinaryFile, type BinaryWriteResult } from '../../editor/editor-api';
import { Base64 } from '../../helpers/base64';
import {
  MAX_REFERENCE_IMAGE_BYTES,
  REFERENCE_IMAGE_TYPES,
  ReferenceImageLoader,
  type LoadedImage,
} from '../../scene/reference-image-loader';
import type { ReferenceImageHost } from '../../scene/reference-image-controller';
import { ReferenceImagePanel } from './reference-image-panel';

/** The folder beside the model file that uploaded pictures land in. */
export const REFERENCE_IMAGE_FOLDER = 'images';

/** A click (not a drag) places the picture's centre: down and up within this many pixels. */
const CLICK_SLOP_PX = 8;

/**
 * What the tool needs beyond a drawing tool's basics. The I/O is
 * injectable so the apply flow runs under test without a server.
 */
export type ReferenceImageToolDeps = {
  /** The viewer's reference-image controller: the seed and the live preview. */
  host: ReferenceImageHost;
  /** The sketch statement being edited — the chain's address and the model file the path is relative to. */
  sourceLocation: SourceLocationParam & { filePath: string };
  onRequestExit: () => void;
  upload?: (path: string, base64: string) => Promise<BinaryWriteResult>;
  commit?: (loc: SourceLocationParam, image: SketchImageEdit | null) => Promise<SetUnitResult>;
  decode?: (blob: Blob) => Promise<LoadedImage>;
};

/**
 * The Image tool: opens the Reference image dialog seeded from the sketch's
 * current `.image()` (if any) and previews every edit on the viewer's
 * picture quad. A viewport click moves the centre (snapped). Apply uploads
 * a newly chosen file beside the model (`images/<name>`, never clobbering
 * an existing one) and writes the chain through the acked
 * `set-sketch-image` edit; the re-render then shows the picture from code.
 * Remove takes the chain off. Cancel and Escape drop the preview.
 */
export class ReferenceImageTool extends SketchTool {
  readonly id = 'image' as const;
  readonly label = 'Image';
  readonly icon = ICON_IMAGE;

  private readonly panel: ReferenceImagePanel;
  private readonly host: ReferenceImageHost;
  private readonly sourceLocation: SourceLocationParam & { filePath: string };
  private readonly onRequestExit: () => void;
  private readonly upload: (path: string, base64: string) => Promise<BinaryWriteResult>;
  private readonly commit: (loc: SourceLocationParam, image: SketchImageEdit | null) => Promise<SetUnitResult>;
  private readonly decode: (blob: Blob) => Promise<LoadedImage>;

  /** A picture chosen in this session, decoded in the page, not yet on disk. */
  private chosen: { file: File; image: LoadedImage } | null = null;
  private busy = false;
  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;
  private downX = 0;
  private downY = 0;

  constructor(
    ctx: SceneContext,
    plane: PlaneData,
    snapController: SnapController,
    insertGeometry: InsertGeometryFn,
    container: HTMLElement,
    deps: ReferenceImageToolDeps,
  ) {
    super(ctx, plane, snapController, insertGeometry, container);
    this.host = deps.host;
    this.sourceLocation = deps.sourceLocation;
    this.onRequestExit = deps.onRequestExit;
    this.upload = deps.upload ?? ((path, data) => writeWorkspaceBinaryFile(path, data, 'unique'));
    this.commit = deps.commit ?? setSketchImage;
    this.decode = deps.decode ?? ReferenceImageLoader.decode;
    this.panel = new ReferenceImagePanel(container);
    this.panel.onChange = () => this.refreshPreview();
    this.panel.onApply = () => void this.apply();
    this.panel.onRemove = () => void this.remove();
    this.panel.onExit = () => this.cancel();
    this.panel.onFile = (file) => void this.chooseFile(file);
    this.boundMouseDown = this.handleMouseDown.bind(this);
    this.boundMouseUp = this.handleMouseUp.bind(this);
  }

  protected onActivate(): void {
    const current = this.host.current();
    if (current) {
      this.panel.setValues(current.spec, current.pixel);
    }
    this.canvas.addEventListener('mousedown', this.boundMouseDown);
    this.canvas.addEventListener('mouseup', this.boundMouseUp);
    this.panel.show();
    this.refreshPreview();
  }

  protected onDeactivate(): void {
    this.canvas.removeEventListener('mousedown', this.boundMouseDown);
    this.canvas.removeEventListener('mouseup', this.boundMouseUp);
    this.host.clearPreview();
    this.dropChosen();
    this.panel.destroy();
  }

  onSceneUpdate(_sceneObjects: SceneObjectRender[], _sketchId: string): void {
    // The picture's record arrives with the render through the host; the
    // dialog keeps the user's edits until Apply or Cancel.
    const current = this.host.current();
    if (current?.pixel && !this.chosen) {
      this.panel.setPixelSize(current.pixel);
    }
  }

  handleEscape(): boolean {
    this.cancel();
    return true;
  }

  // ------------------------------------------------------------- viewport

  private handleMouseDown(e: MouseEvent): void {
    this.downX = e.clientX;
    this.downY = e.clientY;
  }

  private handleMouseUp(e: MouseEvent): void {
    if (e.button !== 0 || Math.hypot(e.clientX - this.downX, e.clientY - this.downY) > CLICK_SLOP_PX) {
      return;
    }
    const point = this.snapAt(e.clientX, e.clientY);
    if (!point) {
      return;
    }
    this.panel.setCenter(point[0], point[1]);
    this.refreshPreview();
  }

  // -------------------------------------------------------------- picture

  private async chooseFile(file: File): Promise<void> {
    this.panel.setMessage(null);
    if (file.type && !(REFERENCE_IMAGE_TYPES as readonly string[]).includes(file.type)) {
      this.panel.setMessage('Choose a PNG, JPEG, WebP, GIF or BMP image.');
      return;
    }
    if (file.size > MAX_REFERENCE_IMAGE_BYTES) {
      this.panel.setMessage(`The image is ${(file.size / (1024 * 1024)).toFixed(1)} MB; the limit is ${MAX_REFERENCE_IMAGE_BYTES / (1024 * 1024)} MB.`);
      return;
    }
    let image: LoadedImage;
    try {
      image = await this.decode(file);
    } catch (error) {
      this.panel.setMessage(error instanceof Error ? error.message : String(error));
      return;
    }
    this.dropChosen();
    this.chosen = { file, image };
    this.panel.setFile(file.name, { width: image.width, height: image.height });
    this.refreshPreview();
  }

  private dropChosen(): void {
    this.chosen?.image.close();
    this.chosen = null;
  }

  /** The dialog's fields as a record, or null with the problem shown. */
  private currentValues(): SketchImageData | null {
    const read = this.panel.values();
    if ('error' in read) {
      this.panel.setMessage(read.error);
      return null;
    }
    this.panel.setMessage(null);
    return read.values;
  }

  private refreshPreview(): void {
    const values = this.currentValues();
    if (!values) {
      return;
    }
    this.host.preview(this.plane, values, this.chosen?.image ?? null);
  }

  // --------------------------------------------------------------- commit

  private async apply(): Promise<void> {
    if (this.busy) {
      return;
    }
    const values = this.currentValues();
    if (!values) {
      return;
    }
    this.setBusy(true);
    try {
      let src = values.src;
      if (this.chosen) {
        const uploaded = await this.upload(this.uploadPath(this.chosen.file.name), await Base64.fromBlob(this.chosen.file));
        src = ReferenceImageTool.relativeSrc(this.sourceLocation.filePath, uploaded.absPath);
      }
      if (!src) {
        this.panel.setMessage('Choose an image first.');
        return;
      }
      const result = await this.commit(this.sourceLocation, ReferenceImageTool.editOf({ ...values, src }));
      if (!result.success) {
        this.panel.setMessage(result.reason ?? 'The image could not be written to the sketch.');
        return;
      }
      // The re-render carries the record; the host shows it from the model.
      this.host.clearPreview();
      this.onRequestExit();
    } catch (error) {
      this.panel.setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      this.setBusy(false);
    }
  }

  private async remove(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.setBusy(true);
    try {
      const result = await this.commit(this.sourceLocation, null);
      if (!result.success) {
        this.panel.setMessage(result.reason ?? 'The image could not be removed from the sketch.');
        return;
      }
      this.host.clearPreview();
      this.onRequestExit();
    } catch (error) {
      this.panel.setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      this.setBusy(false);
    }
  }

  private cancel(): void {
    this.host.clearPreview();
    this.onRequestExit();
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.panel.setApplyEnabled(!busy);
  }

  /** Where a chosen file goes: `images/<name>` beside the model, the name made path-safe. */
  private uploadPath(fileName: string): string {
    const folder = ReferenceImageTool.folderOf(this.sourceLocation.filePath);
    return `${folder}/${REFERENCE_IMAGE_FOLDER}/${ReferenceImageTool.safeName(fileName)}`;
  }

  /** The chain's record: the dialog's fields with the written path. */
  static editOf(values: SketchImageData): SketchImageEdit {
    return {
      src: values.src,
      ...(values.width !== undefined ? { width: values.width } : {}),
      ...(values.height !== undefined ? { height: values.height } : {}),
      at: values.at,
      angle: values.angle,
      opacity: values.opacity,
    };
  }

  /** A file name with only letters, digits, dots, dashes and underscores. */
  static safeName(fileName: string): string {
    const base = fileName.replace(/\\/g, '/').replace(/^.*\//, '');
    const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '');
    return cleaned || 'image';
  }

  /** The folder of a model file path, forward slashes. */
  static folderOf(modelFile: string): string {
    return modelFile.replace(/\\/g, '/').replace(/\/[^/]*$/, '');
  }

  /**
   * The `src` to write for a picture the server put at `absPath`: relative
   * to the model file's folder when it sits beneath it (the normal case),
   * the absolute path otherwise.
   */
  static relativeSrc(modelFile: string, absPath: string): string {
    const folder = ReferenceImageTool.folderOf(modelFile);
    const posix = absPath.replace(/\\/g, '/');
    return posix.startsWith(`${folder}/`) ? posix.slice(folder.length + 1) : posix;
  }
}

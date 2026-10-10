import type { Scene } from 'three';
import type { PlaneData, SketchImageData } from '../types';
import { rawWorkspaceFileUrl } from '../editor/editor-api';
import { ReferenceImageLoader, type LoadedImage, type PixelSize } from './reference-image-loader';
import { SketchReferenceImage } from './sketch-reference-image';

/** The active sketch's picture as the render carries it, with the file the sketch lives in. */
export type ReferenceImageSource = {
  plane: PlaneData;
  spec: SketchImageData;
  /** Absolute path of the model file — `spec.src` is relative to its folder. */
  modelFile: string;
};

/** What the Image dialog seeds from: the written record and the picture's pixel size once loaded. */
export type ReferenceImageState = {
  spec: SketchImageData;
  pixel: PixelSize | null;
};

/**
 * What the sketch Image tool drives: the model's current record for its
 * seed, and a live override of the quad while the dialog is open.
 */
export interface ReferenceImageHost {
  current(): ReferenceImageState | null;
  /**
   * Draw `spec` instead of the model's record — with `image`, a picture the
   * dialog decoded in the page (a newly chosen file) in place of the loaded
   * one. Stays until {@link clearPreview}, across re-renders.
   */
  preview(plane: PlaneData, spec: SketchImageData, image?: LoadedImage | null): void;
  clearPreview(): void;
}

/**
 * Owns the reference picture of the sketch being edited. The viewer feeds it
 * the active sketch's record on every render (`sync`); it fetches the bytes
 * once per path, keeps them across the re-renders every sketch edit
 * causes, places the quad and hides it when sketch mode ends. The Image
 * dialog previews through the same quad with an override that wins over
 * the model until it is cleared.
 */
export class ReferenceImageController implements ReferenceImageHost {
  /** A load failure (missing file, undecodable bytes), or null once a picture loads. */
  onStatus?: (message: string | null) => void;

  private readonly quad: SketchReferenceImage;
  private model: ReferenceImageSource | null = null;
  private loaded: { url: string; image: LoadedImage } | null = null;
  private loadSeq = 0;
  private abort: AbortController | null = null;
  private override: { plane: PlaneData; spec: SketchImageData; image: LoadedImage | null } | null = null;
  /** The picture the quad currently holds as a texture, so a slider tick re-uploads nothing. */
  private shown: LoadedImage | null = null;
  private status: string | null = null;

  constructor(
    scene: Scene,
    private readonly loader: ReferenceImageLoader,
    private readonly requestRender: () => void,
  ) {
    this.quad = new SketchReferenceImage(scene);
  }

  /** The model's record (never the dialog's override), with the pixel size once its bytes are in. */
  current(): ReferenceImageState | null {
    if (!this.model) {
      return null;
    }
    const url = ReferenceImageController.imageUrl(this.model.modelFile, this.model.spec.src);
    const pixel = this.loaded && this.loaded.url === url
      ? { width: this.loaded.image.width, height: this.loaded.image.height }
      : null;
    return { spec: this.model.spec, pixel };
  }

  /** The last load failure, if the picture is not on screen because of one. */
  get statusMessage(): string | null {
    return this.status;
  }

  /**
   * The active sketch's picture after a render, or null when there is no
   * active sketch or it has no `.image()`. Same path as before: nothing is
   * fetched again.
   */
  sync(source: ReferenceImageSource | null): void {
    this.model = source;
    if (!source) {
      this.cancelLoad();
      this.apply();
      return;
    }
    const url = ReferenceImageController.imageUrl(source.modelFile, source.spec.src);
    if (this.loaded?.url === url) {
      this.apply();
      return;
    }
    this.cancelLoad();
    this.startLoad(url);
    this.apply();
  }

  preview(plane: PlaneData, spec: SketchImageData, image: LoadedImage | null = null): void {
    this.override = { plane, spec, image };
    this.apply();
  }

  clearPreview(): void {
    this.override = null;
    this.apply();
  }

  dispose(): void {
    this.cancelLoad();
    this.quad.dispose();
    this.shown = null;
    this.loaded?.image.close();
    this.loaded = null;
    this.override = null;
  }

  /** The URL that serves `src` as written in the model at `modelFile`. */
  static imageUrl(modelFile: string, src: string): string {
    return rawWorkspaceFileUrl(ReferenceImageController.resolveSrc(modelFile, src));
  }

  /**
   * `src` resolved against the model file's folder: an absolute path stays,
   * a relative one joins the folder with `.` and `..` segments folded.
   * Forward slashes throughout — the server normalises its paths the same way.
   */
  static resolveSrc(modelFile: string, src: string): string {
    const posixSrc = src.replace(/\\/g, '/');
    if (posixSrc.startsWith('/') || /^[A-Za-z]:\//.test(posixSrc)) {
      return posixSrc;
    }
    const folder = modelFile.replace(/\\/g, '/').replace(/\/[^/]*$/, '');
    const parts = folder.split('/');
    for (const segment of posixSrc.split('/')) {
      if (segment === '' || segment === '.') {
        continue;
      }
      if (segment === '..') {
        if (parts.length > 1) {
          parts.pop();
        }
        continue;
      }
      parts.push(segment);
    }
    return parts.join('/');
  }

  private startLoad(url: string): void {
    const seq = ++this.loadSeq;
    const abort = new AbortController();
    this.abort = abort;
    this.loader.load(url, abort.signal).then(
      (image) => {
        if (seq !== this.loadSeq) {
          image.close();
          return;
        }
        this.abort = null;
        this.loaded?.image.close();
        this.loaded = { url, image };
        this.setStatus(null);
        this.apply();
      },
      (error) => {
        if (seq !== this.loadSeq) {
          return;
        }
        this.abort = null;
        this.loaded?.image.close();
        this.loaded = null;
        const detail = error instanceof Error ? error.message : String(error);
        this.setStatus(`Reference image could not be loaded: ${detail}`);
        this.apply();
      },
    );
  }

  private cancelLoad(): void {
    this.loadSeq++;
    this.abort?.abort();
    this.abort = null;
  }

  private setStatus(message: string | null): void {
    if (this.status === message) {
      return;
    }
    this.status = message;
    this.onStatus?.(message);
  }

  /**
   * Put the effective picture on screen: the dialog's override when there
   * is one (its own decoded picture, or the loaded one), else the model's
   * record once its bytes are in; nothing otherwise.
   */
  private apply(): void {
    const plane = this.override?.plane ?? this.model?.plane ?? null;
    const spec = this.override?.spec ?? this.model?.spec ?? null;
    const image = this.override?.image ?? this.loaded?.image ?? null;
    if (!plane || !spec || !image) {
      this.quad.hide();
      this.requestRender();
      return;
    }
    if (this.shown !== image) {
      this.quad.setImage(image);
      this.shown = image;
    }
    this.quad.place(plane, spec);
    this.requestRender();
  }
}

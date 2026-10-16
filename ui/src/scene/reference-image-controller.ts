import type { Scene } from 'three';
import type { PlaneData, SceneObjectRender, SketchImageData } from '../types';
import { rawWorkspaceFileUrl } from '../editor/editor-api';
import { ReferenceImageLoader, type LoadedImage, type PixelSize } from './reference-image-loader';
import { SketchReferenceImage } from './sketch-reference-image';

/** One `image()` row as the render carries it, with the file its path is relative to. */
export type ReferenceImageSource = {
  /** The statement's identity: `filePath:line:column` of the `image()` call. */
  key: string;
  plane: PlaneData;
  spec: SketchImageData;
  /** Absolute path of the model file — `spec.src` is relative to its folder. */
  modelFile: string;
};

/** What the Image tool seeds from: the written record and the picture's pixel size once loaded. */
export type ReferenceImageState = {
  spec: SketchImageData;
  pixel: PixelSize | null;
};

/** The Image tool's live picture, drawn in place of a row's (or as a new one) until cleared. */
export type ReferenceImagePreview = {
  /** The row it stands in for, or null for a picture not written yet. */
  key: string | null;
  plane: PlaneData;
  spec: SketchImageData;
  /** The model file `spec.src` is relative to. */
  modelFile: string;
  /** A picture the tool decoded in the page (a newly chosen file), in place of the one at `spec.src`. */
  image?: LoadedImage | null;
};

/**
 * What the sketch Image tool drives: a row's current record for its seed,
 * and a live override of the quads while the tool is open.
 */
export interface ReferenceImageHost {
  current(key: string): ReferenceImageState | null;
  /** Stays until {@link clearPreview}, across re-renders. */
  preview(preview: ReferenceImagePreview): void;
  clearPreview(): void;
}

/** A picture by URL: its decoded pixels once in, or the load in flight. */
type Picture = {
  image: LoadedImage | null;
  abort: AbortController | null;
  error: string | null;
};

/** A quad and the picture it holds as a texture, so a slider tick re-uploads nothing. */
type Slot = { quad: SketchReferenceImage; shown: LoadedImage | null };

/** Pictures no row shows any more stay decoded up to this many, so a rollback and back fetches nothing. */
const MAX_IDLE_PICTURES = 4;

/** The slot a not-yet-written preview draws in. */
const NEW_PICTURE_KEY = '\u0000new';

/**
 * Owns the reference pictures on screen. The viewer feeds it the `image()`
 * rows to show on every render ({@link sourcesOf} picks them); it fetches
 * each file once, keeps the bytes across the re-renders every sketch edit
 * causes, and places one quad per row. The Image tool previews through the
 * same quads with an override that wins over the model until cleared.
 */
export class ReferenceImageController implements ReferenceImageHost {
  /** A load failure (missing file, undecodable bytes). */
  onStatus?: (message: string | null) => void;

  private sources: ReferenceImageSource[] = [];
  private override: ReferenceImagePreview | null = null;
  /** Rows the timeline eye hid: kept as sources (the Image tool still seeds from them), never drawn. */
  private hidden: ReadonlySet<string> = new Set();
  private readonly pictures = new Map<string, Picture>();
  private readonly slots = new Map<string, Slot>();

  constructor(
    private readonly scene: Scene,
    private readonly loader: ReferenceImageLoader,
    private readonly requestRender: () => void,
  ) {}

  /**
   * The `image()` rows a render shows. In sketch mode, the pictures of the
   * sketch being edited; otherwise those whose sketch is on screen — a
   * sketch a feature consumed hides its pictures with its lines. A row whose
   * statement failed (no record) or has no file to resolve against is left
   * out.
   */
  static sourcesOf(
    rows: readonly SceneObjectRender[],
    activeSketchId: string | null,
    shownIds: ReadonlySet<string>,
  ): ReferenceImageSource[] {
    const byId = new Map(rows.map(row => [row.id, row]));
    const sources: ReferenceImageSource[] = [];
    for (const row of rows) {
      if (row.type !== 'image' || !row.parentId) {
        continue;
      }
      const sketch = byId.get(row.parentId);
      if (!sketch || sketch.type !== 'sketch') {
        continue;
      }
      const onScreen = activeSketchId
        ? sketch.id === activeSketchId
        : sketch.visible || shownIds.has(sketch.id);
      const spec = row.object?.image as SketchImageData | undefined;
      const plane = (row.object?.plane ?? sketch.object?.plane) as PlaneData | undefined;
      const loc = row.sourceLocation;
      if (!onScreen || !spec || !plane || !loc?.filePath) {
        continue;
      }
      sources.push({ key: ReferenceImageController.keyOf(loc), plane, spec, modelFile: loc.filePath });
    }
    return sources;
  }

  /** An `image()` statement's identity across renders. */
  static keyOf(loc: { filePath: string; line: number; column: number }): string {
    return `${loc.filePath}:${loc.line}:${loc.column}`;
  }

  /** A row's record (never the tool's override), with the pixel size once its bytes are in. */
  current(key: string): ReferenceImageState | null {
    const source = this.sources.find(s => s.key === key);
    if (!source) {
      return null;
    }
    const image = this.pictures.get(ReferenceImageController.urlOf(source))?.image ?? null;
    return { spec: source.spec, pixel: image ? { width: image.width, height: image.height } : null };
  }

  /** The rows to show after a render. A path already loaded is not fetched again. */
  sync(sources: ReferenceImageSource[]): void {
    this.sources = sources;
    this.ensurePictures();
    this.apply();
  }

  preview(preview: ReferenceImagePreview): void {
    this.override = preview;
    this.ensurePictures();
    this.apply();
  }

  clearPreview(): void {
    this.override = null;
    this.ensurePictures();
    this.apply();
  }

  /**
   * The rows the timeline eye hides, by key — view state only. The Image
   * tool's override still draws over a hidden row while it edits it.
   */
  setHidden(keys: ReadonlySet<string>): void {
    this.hidden = new Set(keys);
    this.apply();
  }

  dispose(): void {
    for (const picture of this.pictures.values()) {
      picture.abort?.abort();
      picture.image?.close();
    }
    this.pictures.clear();
    for (const slot of this.slots.values()) {
      slot.quad.dispose();
    }
    this.slots.clear();
    this.override = null;
    this.sources = [];
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

  private static urlOf(source: { modelFile: string; spec: SketchImageData }): string {
    return ReferenceImageController.imageUrl(source.modelFile, source.spec.src);
  }

  /** The URLs the rows and the override need from the server. */
  private wantedUrls(): Set<string> {
    const urls = new Set(this.sources.map(source => ReferenceImageController.urlOf(source)));
    if (this.override && !this.override.image && this.override.spec.src) {
      urls.add(ReferenceImageController.urlOf(this.override));
    }
    return urls;
  }

  /** Start the loads nothing holds yet; let go of the idle pictures past the cap. */
  private ensurePictures(): void {
    const wanted = this.wantedUrls();
    for (const url of wanted) {
      if (!this.pictures.has(url)) {
        this.startLoad(url);
      }
    }
    const idle = [...this.pictures.keys()].filter(url => !wanted.has(url));
    for (const url of idle.slice(0, Math.max(0, idle.length - MAX_IDLE_PICTURES))) {
      const picture = this.pictures.get(url)!;
      picture.abort?.abort();
      picture.image?.close();
      this.pictures.delete(url);
    }
  }

  private startLoad(url: string): void {
    const picture: Picture = { image: null, abort: new AbortController(), error: null };
    this.pictures.set(url, picture);
    this.loader.load(url, picture.abort!.signal).then(
      (image) => {
        if (this.pictures.get(url) !== picture) {
          image.close();
          return;
        }
        picture.abort = null;
        picture.image = image;
        this.apply();
      },
      (error) => {
        if (this.pictures.get(url) !== picture) {
          return;
        }
        picture.abort = null;
        picture.error = error instanceof Error ? error.message : String(error);
        this.onStatus?.(`Reference image could not be loaded: ${picture.error}`);
        this.apply();
      },
    );
  }

  /**
   * Put the effective pictures on screen: every row whose bytes are in and
   * the eye leaves shown, the override in place of the row it edits (or in its own slot when it
   * is new) — with its own decoded picture, or the one at its path.
   */
  private apply(): void {
    const wanted = new Map<string, { plane: PlaneData; spec: SketchImageData; image: LoadedImage }>();
    for (const source of this.sources) {
      const image = this.pictures.get(ReferenceImageController.urlOf(source))?.image;
      if (image && source.key !== this.override?.key && !this.hidden.has(source.key)) {
        wanted.set(source.key, { plane: source.plane, spec: source.spec, image });
      }
    }
    if (this.override) {
      const image = this.override.image
        ?? (this.override.spec.src ? this.pictures.get(ReferenceImageController.urlOf(this.override))?.image : null);
      if (image) {
        wanted.set(this.override.key ?? NEW_PICTURE_KEY, { plane: this.override.plane, spec: this.override.spec, image });
      }
    }
    for (const [key, slot] of this.slots) {
      if (!wanted.has(key)) {
        slot.quad.dispose();
        this.slots.delete(key);
      }
    }
    for (const [key, { plane, spec, image }] of wanted) {
      let slot = this.slots.get(key);
      if (!slot) {
        slot = { quad: new SketchReferenceImage(this.scene), shown: null };
        this.slots.set(key, slot);
      }
      if (slot.shown !== image) {
        slot.quad.setImage(image);
        slot.shown = image;
      }
      slot.quad.place(plane, spec);
    }
    this.requestRender();
  }
}

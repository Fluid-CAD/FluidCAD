/**
 * A decoded picture ready for a texture: the pixel source plus its size, and
 * a `close()` that frees the bitmap once a texture no longer needs it.
 */
export type LoadedImage = {
  source: ImageBitmap | HTMLImageElement;
  width: number;
  height: number;
  close(): void;
};

/** Pixel size of a picture — what sizes the missing dimension of an `image()`. */
export type PixelSize = { width: number; height: number };

/** The picture types the dialog's file picker offers and the loader decodes. */
export const REFERENCE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'] as const;

/** The largest file the dialog uploads, matching the server's `write-binary` cap. */
export const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Fetches and decodes a sketch's reference picture. The bytes come through
 * `fetch` (same path as every other API call, so the editor hosts' page
 * origin needs nothing extra) and decode through `createImageBitmap`, with
 * an `<img>` fallback for browsers without it. One `load` is one request:
 * the viewer's controller keeps the picture of the active sketch and only
 * asks again when the path changes.
 */
export class ReferenceImageLoader {
  constructor(private readonly fetchBlob: (url: string, signal?: AbortSignal) => Promise<Blob> = ReferenceImageLoader.fetchBlob) {}

  async load(url: string, signal?: AbortSignal): Promise<LoadedImage> {
    const blob = await this.fetchBlob(url, signal);
    return ReferenceImageLoader.decode(blob);
  }

  private static async fetchBlob(url: string, signal?: AbortSignal): Promise<Blob> {
    const res = await fetch(url, { signal });
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const body = await res.json();
        if (typeof body?.error === 'string') {
          message = body.error;
        }
      } catch {
        // A non-JSON error body: the status line is all there is.
      }
      throw new Error(message);
    }
    return res.blob();
  }

  /** Decode a picture's bytes. Rejects with a readable message for bytes no decoder takes. */
  static async decode(blob: Blob): Promise<LoadedImage> {
    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(blob);
        return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
      } catch {
        // Fall through to the element decoder — some browsers refuse a
        // format in createImageBitmap that <img> still renders.
      }
    }
    return ReferenceImageLoader.decodeWithElement(blob);
  }

  private static decodeWithElement(blob: Blob): Promise<LoadedImage> {
    return new Promise((resolve, reject) => {
      if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
        reject(new Error('This image cannot be decoded here.'));
        return;
      }
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        resolve({
          source: img,
          width: img.naturalWidth,
          height: img.naturalHeight,
          close: () => URL.revokeObjectURL(url),
        });
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('The file is not an image this browser can decode.'));
      };
      img.src = url;
    });
  }
}

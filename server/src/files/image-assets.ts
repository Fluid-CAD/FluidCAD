import type { Response } from 'express';
import { readFile } from 'fs/promises';
import { extname } from 'path';

/**
 * Serving a declared image — a custom feature's icon and option pictures,
 * a generated definition's, a package's consent-dialog icon — to the page.
 *
 * The rules:
 * - Only the image types a declaration may name are served (the metadata
 *   check admits no others); anything else answers 415.
 * - Every answer carries the same headers: the type, a policy that keeps an
 *   SVG's scripts inert even when the URL is opened on its own, no sniffing,
 *   and no caching (the page busts its copy with a revision when a module
 *   changes).
 */
export class ImageAssets {
  /** The image types a declared image may be, by extension. */
  static readonly TYPES: Readonly<Record<string, string>> = Object.freeze({
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
  });

  /** The content type of `file` by its extension, or null when it is no image type. */
  static typeOf(file: string): string | null {
    return ImageAssets.TYPES[extname(file).toLowerCase()] ?? null;
  }

  /**
   * Answer `res` with the image at `file` (a path already checked by the
   * caller), or 415 with `notImage` when its extension is no image type.
   */
  static async send(res: Response, file: string, notImage: string): Promise<void> {
    const type = ImageAssets.typeOf(file);
    if (!type) {
      res.status(415).json({ error: notImage });
      return;
    }
    try {
      const content = await readFile(file);
      res.setHeader('Content-Type', type);
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-cache');
      res.send(content);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  }
}

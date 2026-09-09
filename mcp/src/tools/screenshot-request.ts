// The one place a PNG is requested from the server: the screenshot tools and
// `measure`'s image both post here, so the error mapping and the image
// block shape stay identical.

import { FluidCadClient, HttpError } from '../client.ts';
import { err, ok, type ToolResult } from '../types.ts';

export type ImageBlock = { mimeType: string; base64: string };

export type ImageResult = {
  image: ImageBlock;
};

export class ScreenshotRequest {

  static async post(client: FluidCadClient, body: Record<string, unknown>): Promise<ToolResult<ImageResult>> {
    const res = await client.postRaw('/api/screenshot', body);
    if (res.statusCode >= 400) {
      const text = res.data.toString('utf8');
      return err('http-error', `HTTP ${res.statusCode}: ${text.slice(0, 200)}`, {
        statusCode: res.statusCode,
      });
    }
    const mime = res.contentType.split(';')[0].trim() || 'image/png';
    return ok({
      image: {
        mimeType: mime,
        base64: res.data.toString('base64'),
      },
    });
  }

  static wrapError<T>(e: any): ToolResult<T> {
    if (e instanceof HttpError) {
      return err('http-error', `HTTP ${e.statusCode}: ${e.body.slice(0, 200)}`, {
        statusCode: e.statusCode,
      }) as ToolResult<T>;
    }
    return err('internal', e?.message ?? String(e)) as ToolResult<T>;
  }
}

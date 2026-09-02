import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { thumbnailsDir } from './engine/paths';

/**
 * Start-screen previews, one PNG per project under `~/.fluidcad/thumbnails/`.
 *
 * A thumbnail is taken **only when a project closes** — the window is closed,
 * the app quits, or the engine manager reopens it on another pin. It shows
 * the file the user was last looking at, which is also the tab the project
 * reopens to. Nothing here renders on its own; the start screen shows
 * whatever is cached and a project without a preview simply gets a
 * placeholder until it has been closed once with a solid up.
 *
 * The picture comes from the engine's own screenshot route, so it is the same
 * transparent, fit-to-model render the MCP `screenshot` tool produces — not a
 * crop of the window with toolbars in it. It deliberately ignores what the
 * viewport looked like: the camera is always the standard iso view (a
 * project closed mid-sketch would otherwise be pictured flat, looking down
 * the sketch normal), and only solids are drawn — no sketches, construction
 * planes, overlays, nor the sketch-mode ghost tint.
 */

/**
 * Rendered square and then auto-cropped to the model's bounds: the fit the
 * engine does on its own is a conservative bounding-diagonal one, and without
 * the crop a flat part would sit small in the middle of a card. Large enough
 * that the cropped result stays crisp on a HiDPI display.
 */
const RENDER_SIZE = 1024;
const CROP_MARGIN_PX = 16;

/**
 * A close must never hang on a screenshot. The render itself takes well under a
 * second; anything longer means the page is wedged, and the thumbnail is not
 * worth keeping the window open for.
 */
const CAPTURE_TIMEOUT_MS = 4_000;

export type Thumbnail = { dataUrl: string; updatedAt: string };

export function thumbnailFileFor(workspacePath: string): string {
  const hash = crypto.createHash('sha1').update(path.resolve(workspacePath)).digest('hex');
  return path.join(thumbnailsDir(), `${hash}.png`);
}

/** The cached preview for a project, or null when it has never been closed with a model up. */
export function readThumbnail(workspacePath: string): Thumbnail | null {
  const file = thumbnailFileFor(workspacePath);
  try {
    const stat = fs.statSync(file);
    const png = fs.readFileSync(file);
    return { dataUrl: `data:image/png;base64,${png.toString('base64')}`, updatedAt: stat.mtime.toISOString() };
  } catch {
    return null;
  }
}

export function deleteThumbnail(workspacePath: string): void {
  try {
    fs.rmSync(thumbnailFileFor(workspacePath), { force: true });
  } catch {
    // A stale preview on disk is a few kilobytes, never a failure.
  }
}

/**
 * Ask the engine behind `url` for a picture of its current scene's solids and
 * cache it for `workspacePath`. Resolves either way: a project whose engine is
 * gone, or which has no solid rendered, keeps whatever preview it had.
 */
export async function captureThumbnail(url: string, workspacePath: string): Promise<boolean> {
  try {
    if (!(await hasRenderedSolid(url))) {
      return false;
    }
    const response = await fetch(`${url}/api/screenshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        width: RENDER_SIZE,
        height: RENDER_SIZE,
        transparent: true,
        showGrid: false,
        showAxes: false,
        fitToModel: true,
        autoCrop: true,
        margin: CROP_MARGIN_PX,
        solidsOnly: true,
        view: { kind: 'named', name: 'iso-ftr' },
      }),
      signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`[shell] thumbnail for ${workspacePath}: ${response.status} ${await response.text()}`);
      return false;
    }
    const png = Buffer.from(await response.arrayBuffer());
    if (png.length === 0) {
      return false;
    }
    writeAtomically(thumbnailFileFor(workspacePath), png);
    return true;
  } catch (err: any) {
    // Diagnosable from a terminal launch, like everything else in the shell.
    console.warn(`[shell] thumbnail for ${workspacePath}: ${err?.message ?? String(err)}`);
    return false;
  }
}

/**
 * True when the engine has a scene with at least one solid in it. An empty
 * workspace, one whose tabs were all closed, or a file that is still only a
 * sketch would otherwise overwrite a good preview with a blank one — the
 * capture draws solids alone.
 */
async function hasRenderedSolid(url: string): Promise<boolean> {
  const response = await fetch(`${url}/api/scene/shapes`, { signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS) });
  if (!response.ok) {
    return false;
  }
  const list: any = await response.json();
  return Array.isArray(list?.shapes) && list.shapes.some((s: any) => s?.type === 'solid');
}

function writeAtomically(file: string, data: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// Canvas-rendered badge textures for the solved-sketch constraint glyphs
// (solved-constraint-meshes.ts). Cached per label+color; solved glyphs
// render in white and tint via material.color so hover/diagnostic states
// don't multiply the cache.

import { CanvasTexture } from 'three';

export const CANVAS_SIZE = 64;

export type IconTexture = { texture: CanvasTexture; aspect: number };

const textureCache = new Map<string, IconTexture>();

const ICON_FONT = `${CANVAS_SIZE * 0.55}px sans-serif`;

/**
 * The drafting parallel mark: two leaning strokes, matching the toolbar's
 * `constraint-parallel` artwork. Typeset `∥` is two UPRIGHT bars, which on a
 * badge reads as a pause rather than as two parallel lines — so this one is
 * drawn instead of set in the font.
 */
function drawParallelMark(ctx: CanvasRenderingContext2D, size: number, colorHex: string): void {
  const lean = size * 0.18; // horizontal run of each stroke
  const rise = size * 0.48; // vertical extent of each stroke
  const gap = size * 0.15; // half the separation between the two strokes
  ctx.strokeStyle = colorHex;
  ctx.lineWidth = size * 0.1;
  ctx.lineCap = 'round';
  for (const cx of [size / 2 - gap, size / 2 + gap]) {
    ctx.beginPath();
    ctx.moveTo(cx - lean / 2, size / 2 + rise / 2);
    ctx.lineTo(cx + lean / 2, size / 2 - rise / 2);
    ctx.stroke();
  }
}

/** Badge labels whose art is drawn rather than typeset, keyed by the label
 * `BADGE_LABELS` gives them. Painters own a square canvas. */
const BADGE_PAINTERS: Record<string, (ctx: CanvasRenderingContext2D, size: number, colorHex: string) => void> = {
  '∥': drawParallelMark,
};

/** Rounded-rect boxed label (the H/V/T badge look). */
export function getIconTexture(label: string, colorHex: string): IconTexture {
  const key = `${label}|${colorHex}`;
  const cached = textureCache.get(key);
  if (cached) {
    return cached;
  }

  const painter = BADGE_PAINTERS[label];
  const canvas = document.createElement('canvas');
  const measure = canvas.getContext('2d')!;
  measure.font = ICON_FONT;
  // Multi-character labels widen the badge to fit; drawn marks stay square.
  const textWidth = painter ? 0 : measure.measureText(label).width;
  const width = painter ? CANVAS_SIZE : Math.max(CANVAS_SIZE, Math.ceil(textWidth + CANVAS_SIZE * 0.4));

  canvas.width = width;
  canvas.height = CANVAS_SIZE;
  const ctx = canvas.getContext('2d')!;

  const stroke = 4;
  const pad = 4;
  const r = 10;
  const x = pad;
  const y = pad;
  const w = width - pad * 2;
  const h = CANVAS_SIZE - pad * 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.lineWidth = stroke;
  ctx.strokeStyle = colorHex;
  ctx.stroke();

  if (painter) {
    painter(ctx, CANVAS_SIZE, colorHex);
  } else {
    ctx.fillStyle = colorHex;
    ctx.font = ICON_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, width / 2, CANVAS_SIZE / 2);
  }

  const entry = { texture: new CanvasTexture(canvas), aspect: width / CANVAS_SIZE };
  textureCache.set(key, entry);
  return entry;
}

/** Box-less text (angle/dimension readouts). */
export function getTextTexture(text: string, colorHex: string): IconTexture {
  const key = `text:${text}|${colorHex}`;
  const cached = textureCache.get(key);
  if (cached) {
    return cached;
  }
  const entry = createTextTexture(text, colorHex);
  textureCache.set(key, entry);
  return entry;
}

/** Uncached text texture — for labels that change every frame (the angle
 * placement preview's live readout); the caller owns disposal. */
export function createTextTexture(text: string, colorHex: string): IconTexture {
  const font = `${CANVAS_SIZE * 0.7}px sans-serif`;
  const canvas = document.createElement('canvas');
  const measure = canvas.getContext('2d')!;
  measure.font = font;
  const width = Math.max(CANVAS_SIZE, Math.ceil(measure.measureText(text).width + 8));

  canvas.width = width;
  canvas.height = CANVAS_SIZE;
  const ctx = canvas.getContext('2d')!;
  ctx.font = font;
  ctx.fillStyle = colorHex;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, width / 2, CANVAS_SIZE / 2);

  return { texture: new CanvasTexture(canvas), aspect: width / CANVAS_SIZE };
}

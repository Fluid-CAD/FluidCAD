// Canvas-rendered badge textures shared by the legacy constraint icons
// (constraint-icon.ts) and the solved-sketch constraint glyphs
// (solved-constraint-meshes.ts). Cached per label+color; solved glyphs
// render in white and tint via material.color so hover/diagnostic states
// don't multiply the cache.

import { CanvasTexture } from 'three';

export const CANVAS_SIZE = 64;

export type IconTexture = { texture: CanvasTexture; aspect: number };

const textureCache = new Map<string, IconTexture>();

const ICON_FONT = `${CANVAS_SIZE * 0.55}px sans-serif`;

/** Rounded-rect boxed label (the H/V/T badge look). */
export function getIconTexture(label: string, colorHex: string): IconTexture {
  const key = `${label}|${colorHex}`;
  const cached = textureCache.get(key);
  if (cached) {
    return cached;
  }

  const canvas = document.createElement('canvas');
  const measure = canvas.getContext('2d')!;
  measure.font = ICON_FONT;
  // Multi-character labels (the aline angle) widen the badge to fit.
  const textWidth = measure.measureText(label).width;
  const width = Math.max(CANVAS_SIZE, Math.ceil(textWidth + CANVAS_SIZE * 0.4));

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

  ctx.fillStyle = colorHex;
  ctx.font = ICON_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, width / 2, CANVAS_SIZE / 2);

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

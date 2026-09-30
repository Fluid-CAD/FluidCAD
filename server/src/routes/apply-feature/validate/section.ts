// section request validation (create).

import type { RepeatPlaneInput } from './repeat.ts';
import { validateSketchLoc } from '../locations.ts';
import { validatePick } from '../picks.ts';

export type SectionRequest = {
  /** The view's name, as the section menu lists it. */
  name: string;
  /** The cut plane — the repeat mirror's plane shapes. */
  plane: RepeatPlaneInput;
  offset: number;
  flip: boolean;
  /** The file the statement lands in — required for a standard plane, which pins no scope. */
  filePath: string;
};

export const MAX_SECTION_NAME = 80;

/**
 * The section request's shape: a name, the plane (a standard origin plane,
 * an existing plane feature, or a picked face — the repeat mirror's exact
 * input), a finite offset and the flip flag.
 */
export function validateSection(body: any): SectionRequest | { error: string } {
  const { name, offset, flip, filePath } = body ?? {};
  if (typeof name !== 'string' || name.trim() === '' || name.length > MAX_SECTION_NAME) {
    return { error: `name must be a non-empty string of at most ${MAX_SECTION_NAME} characters` };
  }
  if (offset !== undefined && (typeof offset !== 'number' || !Number.isFinite(offset))) {
    return { error: 'offset must be a finite number when provided' };
  }
  if (flip !== undefined && typeof flip !== 'boolean') {
    return { error: 'flip must be a boolean when provided' };
  }
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { error: 'filePath must name the file the section lands in' };
  }
  const raw = body?.plane;
  let plane: RepeatPlaneInput;
  if (raw?.kind === 'standard') {
    if (raw.plane !== 'xy' && raw.plane !== 'xz' && raw.plane !== 'yz') {
      return { error: 'a standard section plane must be "xy", "xz" or "yz"' };
    }
    plane = { kind: 'standard', plane: raw.plane };
  } else if (raw?.kind === 'plane') {
    const loc = validateSketchLoc(raw);
    if (!loc) {
      return { error: 'a plane input must carry the plane {filePath, line}' };
    }
    if (loc.filePath !== filePath) {
      return { error: 'the section plane lives in a different file' };
    }
    plane = { kind: 'plane', loc };
  } else if (raw?.kind === 'face') {
    const pick = validatePick(raw.entity);
    if (!pick || pick.sub.type !== 'face') {
      return { error: 'a picked section plane must carry a {shapeId, sub:{type:"face", index}} pick' };
    }
    plane = { kind: 'face', pick };
  } else {
    return { error: 'plane must be {kind: "standard"|"plane"|"face", …}' };
  }
  return { name: name.trim(), plane, offset: offset ?? 0, flip: flip ?? false, filePath };
}

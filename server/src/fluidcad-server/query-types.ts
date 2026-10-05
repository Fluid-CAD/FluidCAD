// Read-only scene query contracts: measure references, selection synthesis options, boundaries and refusals.

import type { MeasureEntitiesFailure } from '../measure-entities.ts';

/** One measured face/edge; assembly entities name their instance and may carry its live world pose. */
export type MeasureRef = {
  shapeId: string;
  kind: 'face' | 'edge';
  index: number;
  instanceId?: string;
  pose?: { position: { x: number; y: number; z: number }; quaternion: { x: number; y: number; z: number; w: number } };
};

/** Why a selection could not be resolved before the lib's own resolver ran. */
export type ResolveSelectionUnavailable = { ok: false; code: 'no-scene' | 'unsupported'; reason: string };

/**
 * Source-derived context for selector synthesis, built over the live buffer
 * (see `makeSynthesisOptionsForFile`): producer variable names as the code
 * transform would bind them, statement bindability, and the file's numeric
 * constants for parameter linking.
 */
export type SelectionSynthesisOptions = {
  namer?: (producers: { line: number; nameHint: string; featureType?: string }[]) => (string | null)[];
  bindable?: (producer: { line: number; featureType?: string }) => boolean;
  params?: { name: string; value: number }[];
};

/** Why a validation could not run before the lib's own validator ran; the same shape as its refusals. */
export type ValidateUnavailable = { kind: 'refused'; code: 'no-scene' | 'unsupported'; reason: string };

/** Why an interference check could not run before the lib's own checker ran; the same shape as its refusals. */
export type InterfereUnavailable = ValidateUnavailable;

export type MeasureEntitiesOutcome =
  | { ok: true; result: any }
  | MeasureEntitiesFailure;

/**
 * Boundary for edit-mode selection queries: the statement being edited,
 * addressed by scene position (timeline row) and call site. Queries carrying
 * one resolve against the objects strictly before it — the world that
 * statement's arguments see at build time. Validation (index still holds
 * that call site) happens kernel-side; a stale boundary refuses.
 */
export type SelectionBoundary = {
  index: number;
  type: string;
  line: number;
  column: number;
};

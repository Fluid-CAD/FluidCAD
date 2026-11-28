// bridge request validation.

import {
  BRIDGE_CONTINUITY,
  BRIDGE_MAGNITUDE_NOT_POSITIVE,
  BRIDGE_SAME_POINT,
  bridgeMagnitudeError,
  validValueExpr,
  type BridgeContinuity,
  type ValueExpr,
} from '../../../apply-feature-edit/index.ts';
import { EndInputs, type EndInput } from '../end-inputs.ts';

/**
 * The bridge request: its two ends (an edge's start or end, a curve's, or
 * a picked vertex), how it meets each — 'g1' when left out — and the two
 * magnitudes, 1 when left out.
 */
export type BridgeRequest = {
  from: EndInput;
  to: EndInput;
  startContinuity: BridgeContinuity;
  endContinuity: BridgeContinuity;
  startMagnitude: ValueExpr;
  endMagnitude: ValueExpr;
};

/** An edit of a bridge: each end re-picked, and each option; every one absent keeps the statement's own. */
export type BridgeEditRequest = {
  from?: EndInput;
  to?: EndInput;
  startContinuity?: BridgeContinuity;
  endContinuity?: BridgeContinuity;
  startMagnitude?: ValueExpr;
  endMagnitude?: ValueExpr;
};

/** The option fields of a request body, as sent. */
type OptionFields = {
  from?: unknown;
  to?: unknown;
  startContinuity?: unknown;
  endContinuity?: unknown;
  startMagnitude?: unknown;
  endMagnitude?: unknown;
} | null | undefined;

/** Whether two ends are the same pick: the same edge's same end, the same curve's, the same vertex. */
function samePick(a: EndInput, b: EndInput): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** One continuity field: absent (undefined or null) reads as undefined; anything else must be one of the words. */
function continuityField(raw: unknown, field: string): { value: BridgeContinuity | undefined } | { error: string } {
  if (raw === undefined || raw === null) {
    return { value: undefined };
  }
  return BRIDGE_CONTINUITY.has(raw) ? { value: raw } : { error: `${field} must be "g0", "g1" or "g2"` };
}

/**
 * One magnitude field of a create: absent reads as 1; at an end met at
 * `'g0'` — where the statement writes none — whatever was sent is not
 * written, and stands as 1 when it is no value; anywhere else it must be a
 * number or an expression, a literal zero or negative number refused in
 * the engine's words.
 */
function magnitudeField(raw: unknown, continuity: BridgeContinuity, field: string): { value: ValueExpr } | { error: string } {
  if (raw === undefined || raw === null) {
    return { value: 1 };
  }
  if (continuity === 'g0') {
    return { value: validValueExpr(raw) ? raw : 1 };
  }
  const error = bridgeMagnitudeError(raw, field);
  return error !== null ? { error } : { value: raw as ValueExpr };
}

export function validateBridge(body: unknown): BridgeRequest | { error: string } {
  const fields = body as OptionFields;
  const from = EndInputs.validate(fields?.from, 'from');
  if ('error' in from) {
    return from;
  }
  const to = EndInputs.validate(fields?.to, 'to');
  if ('error' in to) {
    return to;
  }
  if (samePick(from, to)) {
    return { error: BRIDGE_SAME_POINT };
  }
  const startContinuity = continuityField(fields?.startContinuity, 'startContinuity');
  if ('error' in startContinuity) {
    return startContinuity;
  }
  const endContinuity = continuityField(fields?.endContinuity, 'endContinuity');
  if ('error' in endContinuity) {
    return endContinuity;
  }
  const start = startContinuity.value ?? 'g1';
  const end = endContinuity.value ?? 'g1';
  const startMagnitude = magnitudeField(fields?.startMagnitude, start, 'startMagnitude');
  if ('error' in startMagnitude) {
    return startMagnitude;
  }
  const endMagnitude = magnitudeField(fields?.endMagnitude, end, 'endMagnitude');
  if ('error' in endMagnitude) {
    return endMagnitude;
  }
  return {
    from, to, startContinuity: start, endContinuity: end,
    startMagnitude: startMagnitude.value, endMagnitude: endMagnitude.value,
  };
}

/**
 * An edit's ends and options: each end absent, null or `{kind: "keep"}` to
 * keep the statement's own, else its new end; each continuity and each
 * magnitude absent or null to keep the statement's own. A new magnitude
 * must be a number or an expression; a literal zero or negative one is
 * refused in the engine's words here when the request sets its end to
 * something other than `'g0'`, else by the edit renderer, which knows the
 * statement's continuity (one at an end set to `'g0'` is not written).
 */
export function validateBridgeEdit(body: unknown): BridgeEditRequest | { error: string } {
  const fields = body as OptionFields;
  const request: BridgeEditRequest = {};
  for (const slot of ['from', 'to'] as const) {
    const end = EndInputs.validateEdit(fields?.[slot], slot);
    if ('error' in end) {
      return end;
    }
    if (end.edit !== undefined) {
      request[slot] = end.edit;
    }
  }
  if (request.from && request.to && samePick(request.from, request.to)) {
    return { error: BRIDGE_SAME_POINT };
  }
  for (const [continuityKey, magnitudeKey] of [['startContinuity', 'startMagnitude'], ['endContinuity', 'endMagnitude']] as const) {
    const continuity = continuityField(fields?.[continuityKey], continuityKey);
    if ('error' in continuity) {
      return continuity;
    }
    if (continuity.value !== undefined) {
      request[continuityKey] = continuity.value;
    }
    const raw = fields?.[magnitudeKey];
    if (raw === undefined || raw === null) {
      continue;
    }
    if (continuity.value === 'g0') {
      // Not written at that end: what the hidden field holds does not matter.
      continue;
    }
    const error = bridgeMagnitudeError(raw, magnitudeKey);
    if (error !== null && (error !== BRIDGE_MAGNITUDE_NOT_POSITIVE || continuity.value !== undefined)) {
      return { error };
    }
    request[magnitudeKey] = raw as ValueExpr;
  }
  return request;
}

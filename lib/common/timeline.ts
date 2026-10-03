import type { SourceLocation } from './scene-object.js';

/** A previous evaluation's row, without geometry, build status or editable values. */
export interface TimelineRow {
  id: string;
  parentId?: string | null;
  name?: string;
  type?: string;
  uniqueType?: string;
  isContainer?: boolean;
  hideChildren?: boolean;
  internal?: boolean;
  sourceLocation?: SourceLocation & { occurrence?: number };
}

/** Display order only. Evaluated entries always address the unchanged scene result. */
export type TimelineEntry =
  | { kind: 'evaluated'; index: number }
  | { kind: 'unevaluated'; row: TimelineRow };

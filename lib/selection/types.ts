import { SourceLocation } from "../common/scene-object.js";

/** A picked sub-shape, exactly as the viewer's `pickAt()` produces it. */
export type PickSubRef = { type: 'edge' | 'face'; index: number };
export type PickRef = { shapeId: string; sub: PickSubRef };

/** Geometric summary of a picked sub-shape, for labels and debugging. */
export type PickDescriptors = {
  geomType: string;
  length?: number;
  area?: number;
  radius?: number;
};

/**
 * JSON-safe explanation of one pick: which feature's classified bucket it
 * belongs to and how the language would name it.
 */
export type PickExplanation = {
  ref: PickRef;
  attributed: boolean;
  error?: string;
  producer?: {
    featureType: string;
    featureName: string;
    accessor: string;
    bucketKey: string;
    index: number;
    bucketSize: number;
    sourceLocation: SourceLocation | null;
    sharedCallSite: boolean;
    isClone: boolean;
  };
  /** Set when the pick only attributes through modification lineage. */
  lineage?: {
    classifiedAccessor: string | null;
    classifiedFeatureType: string | null;
    modifiedBy: string[];
  };
  descriptors?: PickDescriptors;
  /** Teach-mode label, e.g. `e.endEdges(2) — end edge of extrude() @ line 4`. */
  expression?: string;
};

export type ExplainResult = {
  picks: PickExplanation[];
};

export type ApplyFeatureKind = 'fillet' | 'chamfer';

/**
 * Everything the tree-sitter code transform needs, and nothing kernel-side —
 * the transform stays a testable string function.
 */
export type ApplyFeatureEditSpec = {
  feature: ApplyFeatureKind;
  value: number;
  filePath: string;
  producers: {
    line: number;
    column: number;
    featureType: string;
    nameHint: string;
  }[];
  parts: {
    /** Index into `producers`. */
    producer: number;
    accessor: string;
    /** Bucket indices to select, or null for the whole bucket. */
    indices: number[] | null;
  }[];
};

export type ApplyFeatureSynthesis =
  | { ok: true; spec: ApplyFeatureEditSpec; preview: string }
  | { ok: false; reason: string; pick?: PickRef };

/**
 * Chain-root callees the code transform accepts at a producer's source line.
 * Guards against binding a variable to a wrapper call (e.g. `repeat(...)`)
 * whose line a clone inherited.
 */
export const PRODUCER_CALLEES = [
  'extrude', 'cut', 'revolve', 'sweep', 'loft', 'rib', 'wrap', 'shell',
] as const;

/** Idiomatic variable base name per producer feature type. */
export function nameHintFor(featureType: string): string {
  switch (featureType) {
    case 'extrude': return 'e';
    case 'cut': return 'c';
    case 'revolve': return 'rev';
    case 'sweep': return 'sw';
    case 'loft': return 'lf';
    case 'rib': return 'rib';
    case 'wrap': return 'wr';
    case 'shell': return 'sh';
    default: return 'f';
  }
}

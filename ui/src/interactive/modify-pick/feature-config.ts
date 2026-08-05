import { ICON_IMG_FALLBACK } from '../../ui/object-icons';

export type ModifyFeatureKind = 'sketch' | 'fillet' | 'chamfer' | 'shell' | 'offset';

/**
 * The chamfer dialog's type dropdown — which `chamfer()` overload the
 * statement uses: `chamfer(d)`, `chamfer(d1, d2)`, or `chamfer(d, a, true)`.
 */
export type ChamferKind = 'equal' | 'distances' | 'angle';

export type FeatureConfig = {
  label: string;
  buttonTitle: string;
  /** Value-row label; null hides the row (the feature has no numeric parameter). */
  valueLabel: string | null;
  defaultValue: number | null;
  /** What `pickAt()` may return while the mode is armed. */
  pickFilter: 'all' | 'face';
  /** Positive-only value, or any nonzero (shell hollows inward with a negative). */
  valueSign: 'positive' | 'nonzero' | null;
  /** What a negative value means — the nonzero features' value-error hint. */
  negativeHint?: string;
  /** Show the join-type dropdown (shell's arc/intersection/tangent). */
  joinRow: boolean;
  /** Static text after the editable args in the expression row. */
  exprSuffix: string;
};

/**
 * Toolbar order — Sketch first, then Fillet, Chamfer, Shell, Offset. Sketch
 * renders in the create group (shared with Extrude, immune to the
 * sketch-toolbar takeover); the rest form the modify group. Offset only
 * shows while a face is highlighted (its kernel form takes faces).
 */
export const FEATURE_ORDER: ModifyFeatureKind[] = ['sketch', 'fillet', 'chamfer', 'shell', 'offset'];

export const FEATURES: Record<ModifyFeatureKind, FeatureConfig> = {
  // Sketch never enters the shared value/expression bar — only its label,
  // buttonTitle and pickFilter are live; it runs the dialog flow instead.
  sketch: {
    label: 'Sketch', buttonTitle: 'Sketch on a face or a plane', valueLabel: null, defaultValue: null,
    pickFilter: 'face', valueSign: null, joinRow: false, exprSuffix: ')',
  },
  fillet: {
    label: 'Fillet', buttonTitle: 'Fillet edges', valueLabel: 'Radius', defaultValue: 1,
    pickFilter: 'all', valueSign: 'positive', joinRow: false, exprSuffix: ')',
  },
  chamfer: {
    label: 'Chamfer', buttonTitle: 'Chamfer edges', valueLabel: 'Distance', defaultValue: 1,
    pickFilter: 'all', valueSign: 'positive', joinRow: false, exprSuffix: ')',
  },
  shell: {
    label: 'Shell', buttonTitle: 'Shell', valueLabel: 'Thickness', defaultValue: -2,
    pickFilter: 'face', valueSign: 'nonzero', joinRow: true, exprSuffix: ')',
    negativeHint: 'negative hollows inward',
  },
  offset: {
    label: 'Offset', buttonTitle: 'Offset the outlines of the highlighted faces', valueLabel: 'Distance', defaultValue: 1,
    pickFilter: 'face', valueSign: 'nonzero', joinRow: false, exprSuffix: ')',
    negativeHint: 'negative offsets inward',
  },
};

/**
 * Same artwork the timeline shows for the feature (`/icons/<type>.png`). The
 * toolbar buttons render it at 32px (`w-8 h-8`); the dialog title keeps the
 * smaller default that sits proportionally beside its `text-sm` heading.
 */
export function featureIconImg(kind: ModifyFeatureKind, sizeClass = 'w-4 h-4'): string {
  return `<img src="/icons/${kind}.png" ${ICON_IMG_FALLBACK} class="${sizeClass} object-contain" alt="" />`;
}

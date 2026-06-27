import { applyFeatureToSelection } from './code-editor.ts';

export type SupportedFeature = 'fillet' | 'chamfer';

/**
 * Everything needed to write a feature-on-selection edit into source code.
 * The geometric half (which feature, which accessor, which index) comes from
 * the kernel's `explainSelection`; the rest is supplied by the request.
 */
export type FeatureEditSpec = {
  /** 1-indexed source line of the producing feature's call. */
  producerLine: number;
  /** `getType()` of the producing feature — drives the variable-name choice. */
  featureType: string;
  /** Classified accessor on the producing feature, e.g. "endEdges". */
  accessor: string;
  /** Argument for the accessor: the picked sub-shape's bucket position. */
  index: number;
  /** The feature to apply to the selection. */
  feature: SupportedFeature;
  /** Numeric parameter — fillet radius or chamfer distance. */
  amount: number;
};

export type FeatureEditResult = {
  newCode: string;
  /** The selector written into the code, e.g. "e.endEdges(0)", or null on no-op. */
  selector: string | null;
  /** The variable bound to the producing feature, or null on no-op. */
  variableName: string | null;
};

/**
 * Turns a kernel selection explanation + a requested feature into a source
 * edit: binds the producing feature to a variable (if needed) and appends the
 * construction-relative feature call, e.g.
 *   extrude(10)            ->  const e = extrude(10)
 *                              fillet(5, e.endEdges(0))
 *
 * Pure (code string in, code string out) so it is testable without the scene,
 * the kernel, or the editor transport. See plans/interactive-selection/.
 */
export class FeatureOnSelection {
  // Readable, collision-resistant base names per producing-feature family.
  private static readonly NAME_BASES: Array<{ prefix: string; base: string }> = [
    { prefix: 'extrude', base: 'e' },
    { prefix: 'cut', base: 'c' },
    { prefix: 'revolve', base: 'rev' },
    { prefix: 'sweep', base: 'sw' },
    { prefix: 'loft', base: 'lf' },
    { prefix: 'rib', base: 'rib' },
    { prefix: 'wrap', base: 'wr' },
  ];

  /** Pick a readable variable-name base from a feature's `getType()`. */
  static baseNameFor(featureType: string): string {
    const match = this.NAME_BASES.find(n => featureType.startsWith(n.prefix));
    if (match) {
      return match.base;
    }
    const word = featureType.match(/^[a-zA-Z]+/)?.[0];
    return word ? word[0].toLowerCase() : 'f';
  }

  static buildSelector(variableName: string, accessor: string, index: number): string {
    return `${variableName}.${accessor}(${index})`;
  }

  static buildStatement(feature: SupportedFeature, amount: number, selector: string): string {
    // fillet(radius, selection) / chamfer(distance, selection)
    return `${feature}(${amount}, ${selector})`;
  }

  static async buildFeatureEdit(code: string, spec: FeatureEditSpec): Promise<FeatureEditResult> {
    const preferredName = this.baseNameFor(spec.featureType);
    let selector: string | null = null;
    const result = await applyFeatureToSelection(code, {
      producerLine: spec.producerLine,
      preferredName,
      buildStatement: (variableName) => {
        selector = this.buildSelector(variableName, spec.accessor, spec.index);
        return this.buildStatement(spec.feature, spec.amount, selector);
      },
    });
    return { newCode: result.newCode, selector, variableName: result.variableName };
  }
}

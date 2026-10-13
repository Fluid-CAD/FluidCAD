import type { ParamDefinition } from "../param-registry.js";
import { FeatureMetas, type FeatureMeta, type FeatureMetaSnapshot, type ResolvedFeatureMeta } from "./meta.js";

/**
 * Why a field counts as undocumented:
 * - `missing`: no description, or one that is empty once trimmed;
 * - `repeats-label`: it says only the label, or the name made readable
 *   (`'Height'` for `height`), which tells a reader nothing new;
 * - `too-long`: over {@link FeatureDocs.MAX_CHARS} characters once trimmed.
 */
export type DocGapReason = 'missing' | 'repeats-label' | 'too-long';

/** One field without a useful description. */
export type DocGap = {
  /** The feature itself, one of its values or declared buckets, or a part's or assembly's parameter. */
  kind: 'feature' | 'value' | 'bucket' | 'param';
  /** What the field belongs to: the feature's id, or the part's or assembly's export name. */
  owner: string;
  /** The feature's id, the value's or the bucket's name, or the parameter's label (its name and override key). */
  name: string;
  /** What the dialog, the editor's menus or the Parameters panel call it. */
  label: string;
  reason: DocGapReason;
};

/** A parameter as the part catalog and the manifest keep it: what the rule reads of one. */
type DocumentedParam = Pick<ParamDefinition, 'label'> & { description?: string };

/**
 * What "documented" means for a field (package-docs DOC5): a `description`
 * that says something — non-empty once trimmed, not just the label or the
 * name made readable, and at most {@link MAX_CHARS} characters. Documentation
 * is never required: pack lists the gaps as a warning, and the MCP shows a
 * missing description as `null`, both through this one rule.
 *
 * It reads a feature's metadata as declared, as resolved by
 * `registerBuilder`, or as a snapshot (a package's manifest), with the same
 * answer for all three. A choice's options are never checked: their
 * `description` is a line under the option, not a field's documentation.
 */
export class FeatureDocs {
  /** The longest description that still counts, in characters, once trimmed. */
  static readonly MAX_CHARS = 1000;

  /** Whether `text` documents the field `name`, labelled `label`. */
  static isDocumented(text: unknown, label: string, name: string): boolean {
    return FeatureDocs.reasonOf(text, label, name) === null;
  }

  /** Why `text` doesn't document the field, or null when it does. */
  static reasonOf(text: unknown, label: string, name: string): DocGapReason | null {
    if (typeof text !== 'string' || text.trim() === '') {
      return 'missing';
    }
    const trimmed = text.trim();
    if (trimmed.length > FeatureDocs.MAX_CHARS) {
      return 'too-long';
    }
    const said = FeatureDocs.words(trimmed);
    if (said === FeatureDocs.words(label) || said === FeatureDocs.words(name)) {
      return 'repeats-label';
    }
    return null;
  }

  /**
   * A feature's undocumented fields: the feature's own description first,
   * then each value in declaration order, then each bucket its class
   * declares (`Feature.with(params, { buckets })`), in declaration order.
   * `owner` defaults to the feature's id.
   */
  static missing(meta: FeatureMeta | ResolvedFeatureMeta | FeatureMetaSnapshot, owner?: string): DocGap[] {
    const id = FeatureDocs.idOf(meta);
    const of = owner ?? id;
    const gaps: DocGap[] = [];
    const own = FeatureDocs.reasonOf(meta.description, meta.label, id);
    if (own !== null) {
      gaps.push({ kind: 'feature', owner: of, name: id, label: meta.label, reason: own });
    }
    for (const [name, spec] of Object.entries(meta.params)) {
      const label = FeatureMetas.labelOf(name, spec);
      const reason = FeatureDocs.reasonOf(spec.description, label, name);
      if (reason !== null) {
        gaps.push({ kind: 'value', owner: of, name, label, reason });
      }
    }
    for (const bucket of FeatureMetas.bucketsOf(meta)) {
      const reason = FeatureDocs.reasonOf(bucket.description, bucket.label, bucket.name);
      if (reason !== null) {
        gaps.push({ kind: 'bucket', owner: of, name: bucket.name, label: bucket.label, reason });
      }
    }
    return gaps;
  }

  /** A part's or assembly's undocumented parameters, in declaration order. */
  static missingParams(params: readonly DocumentedParam[], owner: string): DocGap[] {
    const gaps: DocGap[] = [];
    for (const param of params) {
      const reason = FeatureDocs.reasonOf(param.description, param.label, param.label);
      if (reason !== null) {
        gaps.push({ kind: 'param', owner, name: param.label, label: param.label, reason });
      }
    }
    return gaps;
  }

  /**
   * The warning for the gaps found in one place (a module path), grouped by
   * owner in the order they come:
   *
   *   features/standoff.feature.js: 2 fields without a description — standoff: height, outer (repeats its label). …
   *
   * The empty string when there are none.
   */
  static describe(gaps: readonly DocGap[], where: string): string {
    if (gaps.length === 0) {
      return '';
    }
    const byOwner = new Map<string, string[]>();
    for (const gap of gaps) {
      const field = gap.kind === 'feature' ? 'the feature itself' : gap.name;
      const why = FeatureDocs.REASON_WORDS[gap.reason];
      byOwner.set(gap.owner, [...(byOwner.get(gap.owner) ?? []), why ? `${field} (${why})` : field]);
    }
    const groups = [...byOwner].map(([owner, fields]) => `${owner}: ${fields.join(', ')}`).join('; ');
    const counted = `${gaps.length} ${gaps.length === 1 ? 'field' : 'fields'}`;
    return `${where}: ${counted} without a description — ${groups}. Give ${gaps.length === 1 ? 'it' : 'each'} a \`description\`.`;
  }

  /** What a gap's reason adds after the field's name; nothing for a plain missing one. */
  private static readonly REASON_WORDS: Record<DocGapReason, string> = {
    'missing': '',
    'repeats-label': 'repeats its label',
    'too-long': `over ${FeatureDocs.MAX_CHARS.toLocaleString('en-US')} characters`,
  };

  /** The words of a text, lowercased, without spaces or punctuation: `Hole diameter.` and `holeDiameter` read alike. */
  private static words(text: string): string {
    return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  }

  /** The feature's id: a snapshot's and a resolved metadata's own, a declared metadata's class's. */
  private static idOf(meta: FeatureMeta | ResolvedFeatureMeta | FeatureMetaSnapshot): string {
    const own = (meta as { id?: unknown }).id;
    if (typeof own === 'string') {
      return own;
    }
    const fromClass = (meta as FeatureMeta).class?.id;
    return typeof fromClass === 'string' ? fromClass : '';
  }
}

import { Scene } from "../rendering/scene.js";
import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { EdgeProps } from "../oc/edge-props.js";
import { FaceProps } from "../oc/face-props.js";
import { SelectionIndex } from "./selection-index.js";
import { attributePick, PickAttribution } from "./attribution.js";
import { synthesizeSelectors } from "./synthesis.js";
import {
  ApplyFeatureEditSpec,
  ApplyFeatureKind,
  ApplyFeatureSynthesis,
  ExplainResult,
  PickDescriptors,
  PickExplanation,
  PickRef,
  nameHintFor,
} from "./types.js";

/**
 * Read-only attribution report for a set of picks: which feature bucket each
 * pick belongs to and the expression that names it. Backs the
 * `/api/selection/explain` endpoint and the attribution regression tests.
 */
export function explainSelection(scene: Scene, refs: PickRef[]): ExplainResult {
  const index = new SelectionIndex(scene);
  try {
    return { picks: refs.map(ref => explainPick(scene, index, ref)) };
  } finally {
    index.dispose();
  }
}

/**
 * Synthesize the code edit for applying `fillet`/`chamfer` to the picked
 * edges and faces (a face selection fillets all of the face's edges):
 * oracle-verified selector parts plus the producer call sites the transform
 * must bind. Returns a structured refusal (with the failing pick) when the
 * selection can't be expressed safely.
 */
export function synthesizeApplyFeature(
  scene: Scene,
  refs: PickRef[],
  feature: ApplyFeatureKind,
  value: number,
): ApplyFeatureSynthesis {
  if (refs.length === 0) {
    return { ok: false, reason: 'nothing selected' };
  }

  const index = new SelectionIndex(scene);
  try {
    const attributions = refs.map(ref => attributePick(scene, index, ref));
    const synthesis = synthesizeSelectors(scene, index, attributions);
    if (synthesis.ok === false) {
      return { ok: false, reason: synthesis.reason, pick: synthesis.pick };
    }

    // Anchor-only entries ride the producers list with bind: false — they
    // locate the insertion scope when no producer variable is bound.
    const located = synthesis.producers.map(p => ({ feature: p, bind: true }));
    if (synthesis.anchor) {
      located.push({ feature: synthesis.anchor, bind: false });
    }

    const filePaths = new Set(
      located.map(l => l.feature.getSourceLocation()!.filePath),
    );
    if (filePaths.size > 1) {
      return { ok: false, reason: 'the picked edges come from features in different files' };
    }

    const spec: ApplyFeatureEditSpec = {
      feature,
      value,
      filePath: filePaths.values().next().value!,
      producers: located.map(l => {
        const loc = l.feature.getSourceLocation()!;
        return {
          line: loc.line,
          column: loc.column,
          featureType: l.feature.getType(),
          nameHint: nameHintFor(l.feature.getType()),
          bind: l.bind,
        };
      }),
      parts: synthesis.parts.map(part => ({
        producer: part.producer ? synthesis.producers.indexOf(part.producer) : null,
        accessor: part.accessor,
        indices: part.indices,
        filterArgs: part.filterArgs,
      })),
      imports: collectImports(synthesis.parts),
    };

    return { ok: true, spec, preview: buildPreview(spec) };
  } finally {
    index.dispose();
  }
}

/** Symbols the emitted statement references beyond the feature itself. */
function collectImports(parts: { producer: unknown; filterArgs: string | null }[]): string[] {
  const imports = new Set<string>();
  for (const part of parts) {
    if (part.producer === null) {
      imports.add('select');
    }
    if (part.filterArgs) {
      if (/\bedge\(/.test(part.filterArgs)) {
        imports.add('edge');
      }
      if (/\bface\(/.test(part.filterArgs)) {
        imports.add('face');
      }
    }
  }
  return [...imports];
}

function explainPick(scene: Scene, index: SelectionIndex, ref: PickRef): PickExplanation {
  const attr = attributePick(scene, index, ref);
  const explanation: PickExplanation = {
    ref,
    attributed: !!attr.producer,
  };
  if (attr.error) {
    explanation.error = attr.error;
    return explanation;
  }

  explanation.descriptors = describe(attr);

  if (attr.producer) {
    const feature = attr.producer.bucket.feature;
    const def = attr.producer.bucket.def;
    const loc = feature.getSourceLocation();
    explanation.producer = {
      featureType: feature.getType(),
      featureName: feature.getName(),
      accessor: def.accessor,
      bucketKey: def.key,
      index: attr.producer.index,
      bucketSize: attr.producer.bucket.members.length,
      sourceLocation: loc,
      sharedCallSite: index.isSharedCallSite(feature),
      isClone: !!feature.getCloneSource(),
    };
    const hint = nameHintFor(feature.getType());
    const at = loc ? ` @ line ${loc.line}` : '';
    explanation.expression =
      `${hint}.${def.accessor}(${attr.producer.index}) — ${def.key.replace('-', ' ')} of ${feature.getType()}()${at}`;
  } else if (attr.lineage) {
    explanation.lineage = {
      classifiedAccessor: attr.lineage.classified?.bucket.def.accessor ?? null,
      classifiedFeatureType: attr.lineage.classified?.bucket.feature.getType() ?? null,
      modifiedBy: [...new Set(attr.lineage.modifiedBy.map(m => m.getType()))],
    };
  }
  return explanation;
}

function describe(attr: PickAttribution): PickDescriptors | undefined {
  if (!attr.picked) {
    return undefined;
  }
  try {
    if (attr.picked instanceof Edge) {
      const props = EdgeProps.getProperties(attr.picked.getShape());
      return { geomType: props.curveType, length: props.length, radius: props.radius };
    }
    if (attr.picked instanceof Face) {
      const props = FaceProps.getProperties(attr.picked.getShape());
      return { geomType: props.surfaceType, area: props.areaMm2, radius: props.radius };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function buildPreview(spec: ApplyFeatureEditSpec): string {
  const names = new Map<number, string>();
  const used = new Set<string>();
  spec.producers.forEach((p, i) => {
    if (!p.bind) {
      return;
    }
    let name = p.nameHint;
    let suffix = 1;
    while (used.has(name)) {
      suffix++;
      name = `${p.nameHint}${suffix}`;
    }
    used.add(name);
    names.set(i, name);
  });

  const args = spec.parts.map(part => {
    const selectorArgs = part.indices ? part.indices.join(', ') : (part.filterArgs ?? '');
    if (part.producer === null) {
      return `select(${selectorArgs})`;
    }
    return `${names.get(part.producer)}.${part.accessor}(${selectorArgs})`;
  });
  return `${spec.feature}(${spec.value}, ${args.join(', ')})`;
}

import { SceneObject } from "../common/scene-object.js";
import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { EdgeProps } from "../oc/edge-props.js";
import { FaceProps } from "../oc/face-props.js";
import { FaceOps } from "../oc/face-ops.js";
import { Plane } from "../math/plane.js";
import { BucketHit, SelectionIndex } from "./selection-index.js";
import { attributePick, PickAttribution } from "./attribution.js";
import { checkBindable, synthesizeSelectors, SelectorChain, SelectorPart } from "./synthesis.js";
import {
  ApplyFeatureEditSpec,
  ApplyFeatureKind,
  ApplyFeatureSynthesis,
  CONNECTOR_NAME_PATTERN,
  MEMBER_NAME_PATTERN,
  ExplainResult,
  PickChain,
  PickDescriptors,
  PickExplanation,
  PickRef,
  ProducerNamer,
  SelectionScene,
  SynthesizeOptions,
  nameHintFor,
  renderConnectorAdjustments,
  renderConnectorAnchorSuffix,
} from "./types.js";
import { Part } from "../features/part.js";

/**
 * Read-only attribution report for a set of picks: which feature bucket each
 * pick belongs to and the expression that names it. Backs the
 * `/api/selection/explain` endpoint and the attribution regression tests.
 */
export function explainSelection(scene: SelectionScene, refs: PickRef[]): ExplainResult {
  const index = new SelectionIndex(scene);
  try {
    return { picks: refs.map(ref => explainPick(scene, index, ref)) };
  } finally {
    index.dispose();
  }
}

/**
 * Synthesize the code edit for applying a feature to the picked edges and
 * faces: oracle-verified selector parts plus the producer call sites the
 * transform must bind. `fillet`/`chamfer` take edges (a face pick fillets all
 * of the face's edges), `shell` takes the faces to remove, `sketch` takes
 * exactly one face and no numeric value, `plane` takes exactly one face or
 * edge (a plane base) and no numeric value, `project` takes any mix of edges
 * and faces — each pick is one projected source — and no numeric value.
 * Tangent chains (right-click "Select
 * with tangents") arrive as seed + expanded members and synthesize
 * `.withTangents()` selectors. The result carries the winning argument list
 * plus up to three verified alternative renderings for the UI's expression
 * dropdown. Returns a structured refusal (with the failing pick) when the
 * selection can't be expressed safely.
 */
export function synthesizeApplyFeature(
  scene: SelectionScene,
  refs: PickRef[],
  feature: ApplyFeatureKind,
  value?: number | string,
  chains: PickChain[] = [],
  options: SynthesizeOptions = {},
): ApplyFeatureSynthesis {
  if (refs.length === 0 && chains.length === 0) {
    return { ok: false, reason: 'nothing selected' };
  }
  if (feature === 'sketch') {
    if (chains.length > 0 || refs.length !== 1 || refs[0].sub.type !== 'face') {
      return {
        ok: false,
        reason: 'sketch needs a single face — pick exactly one face',
        pick: refs[0],
      };
    }
  }
  if (feature === 'plane') {
    // Each synthesis call names ONE plane base: a single face or edge.
    if (chains.length > 0 || refs.length !== 1) {
      return {
        ok: false,
        reason: 'a plane base is a single face or edge — pick exactly one',
        pick: refs[0],
      };
    }
  }
  if (feature === 'extrude') {
    // The pick is extrude's up-to-face target: a single face.
    if (chains.length > 0 || refs.length !== 1 || refs[0].sub.type !== 'face') {
      return {
        ok: false,
        reason: 'extrude extends up to a single face — pick exactly one face',
        pick: refs[0],
      };
    }
  }
  if (feature === 'sweep') {
    // The picks describe the sweep path: a wire built from edges.
    const face = [...refs, ...chains.flatMap(c => c.members)].find(r => r.sub.type !== 'edge');
    if (face) {
      return { ok: false, reason: 'a sweep path takes edges — pick edges only', pick: face };
    }
  }
  if (feature === 'revolve') {
    // The pick is the revolve axis: axis() extracts it from a single edge.
    if (chains.length > 0 || refs.length !== 1 || refs[0].sub.type !== 'edge') {
      return {
        ok: false,
        reason: 'a revolve axis is a single edge — pick exactly one edge',
        pick: refs[0],
      };
    }
  }
  if (feature === 'loft') {
    // Each pick is one loft profile: a face selection.
    const edge = [...refs, ...chains.flatMap(c => c.members)].find(r => r.sub.type !== 'face');
    if (edge) {
      return { ok: false, reason: 'a loft profile is a face — pick faces only', pick: edge };
    }
  }
  if (feature === 'offset') {
    // The picks are the coplanar faces whose outlines the offset traces —
    // the kernel's face-target overload takes no edges outside a sketch.
    const edge = [...refs, ...chains.flatMap(c => c.members)].find(r => r.sub.type !== 'face');
    if (edge) {
      return { ok: false, reason: 'offset takes faces — pick faces only', pick: edge };
    }
  }
  if (feature === 'wrap') {
    // The pick is wrap's target: the single face the sketch wraps onto.
    if (chains.length > 0 || refs.length !== 1 || refs[0].sub.type !== 'face') {
      return {
        ok: false,
        reason: 'wrap targets a single face — pick exactly one face',
        pick: refs[0],
      };
    }
  }
  if (feature === 'helix') {
    // The helix source is a single edge — its axis, via axis() — or a single
    // cylindrical/conical face, which supplies the frame directly.
    if (chains.length > 0 || refs.length !== 1
      || (refs[0].sub.type !== 'edge' && refs[0].sub.type !== 'face')) {
      return {
        ok: false,
        reason: 'a helix source is a single edge (axis) or face — pick exactly one',
        pick: refs[0],
      };
    }
  }
  if (feature === 'connector') {
    // The pick is the connector's source geometry: a single face or edge
    // (the frame derives from exactly one shape). The connector's name rides
    // the `value` channel.
    if (chains.length > 0 || refs.length !== 1) {
      return {
        ok: false,
        reason: 'a connector attaches to a single face or edge — pick exactly one',
        pick: refs[0],
      };
    }
    if (typeof value !== 'string' || !CONNECTOR_NAME_PATTERN.test(value)) {
      return {
        ok: false,
        reason: "a connector needs a name — a plain identifier like 'topLeft'",
      };
    }
    const anchor = options.connector?.anchor;
    if (anchor && anchor.kind !== 'center' && refs[0].sub.type !== 'edge') {
      return {
        ok: false,
        reason: `${anchor.kind === 'offset' ? 'an offset anchor' : `${anchor.kind}()`} needs an edge — a face only supports its center`,
        pick: refs[0],
      };
    }
  }
  if (feature === 'expose') {
    // The pick is the exposure's source geometry: a single face or edge.
    // The exposure's name rides the `value` channel.
    if (chains.length > 0 || refs.length !== 1) {
      return {
        ok: false,
        reason: 'an exposure publishes a single face or edge — pick exactly one',
        pick: refs[0],
      };
    }
    if (typeof value !== 'string' || !MEMBER_NAME_PATTERN.test(value)) {
      return {
        ok: false,
        reason: "an exposure needs a name — a plain identifier like 'profile'",
      };
    }
  }

  const index = new SelectionIndex(scene);
  try {
    // Chain members are routed through their chain, never as free picks.
    const chained = new Set(chains.flatMap(c => c.members.map(refKey)));
    const freeRefs = refs.filter(r => !chained.has(refKey(r)));
    const attributions = freeRefs.map(ref => attributePick(scene, index, ref));
    // sketch() and plane() only extract the plane from their face argument,
    // so a face reshaped by later features may still be named by its
    // classified ancestor's accessor — re-home the pick before synthesis
    // routes it to a geometric select(). Every other feature uses the face
    // itself, where the ancestor accessor would resolve to geometry the final
    // solid lost. (Edge picks pass through: the re-home is face-only.)
    if (feature === 'sketch' || feature === 'plane') {
      for (let i = 0; i < attributions.length; i++) {
        attributions[i] = rehomePlaneFacePick(index, attributions[i]);
      }
    }
    const chainInputs: SelectorChain[] = chains.map(c => ({
      seed: attributePick(scene, index, c.seed),
      members: c.members.map(m => attributePick(scene, index, m)),
    }));

    // Sketch and plane name a plane/reference, not geometry — prefer the
    // compact index form over induced filters with baked-in constants.
    const synthesis = synthesizeSelectors(
      scene, index, attributions, chainInputs, options.params ?? [],
      feature === 'sketch' || feature === 'plane',
    );
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

    const winners = synthesis.groups.map(g => g.winner);
    const names = allocateNames(synthesis.producers, options.namer);
    const renderParts = (parts: SelectorPart[]) =>
      parts.map(part => renderPartArgs(part, names)).join(', ');

    // A connector statement lands inside the enclosing part() callback body,
    // so the spec carries that call site; the name (validated above) rides
    // the payload rather than `value`. Duplicate names are refused here so
    // the UI hears about it before any code is written.
    let connectorPayload: ApplyFeatureEditSpec['connector'];
    if (feature === 'connector') {
      const owner = attributions[0]?.solidOwner ?? null;
      const enclosing = owner ? scene.findEnclosingPart(owner) : null;
      if (!enclosing) {
        return {
          ok: false,
          reason: 'connectors attach to geometry inside a part() block — wrap the feature statements in part(...)',
          pick: refs[0],
        };
      }
      const name = value as string;
      const connectorOpts = options.connector;
      const rotate = connectorOpts?.rotate;
      const rotateActive = rotate !== undefined
        && Number.isFinite(rotate.angle) && rotate.angle % 360 !== 0;
      const adjustments = {
        ...(connectorOpts?.anchor ? { anchor: connectorOpts.anchor } : {}),
        ...(rotateActive ? { rotate: { axis: rotate!.axis, angle: rotate!.angle } } : {}),
        ...(connectorOpts?.offset && connectorOpts.offset.some(v => v !== 0)
          ? { offset: connectorOpts.offset } : {}),
      };

      const partLoc = enclosing.getSourceLocation();
      if (!partLoc) {
        return { ok: false, reason: 'the enclosing part() has no source location — re-render and try again' };
      }
      if (partLoc.filePath !== filePaths.values().next().value) {
        // e.g. geometry from a part factory imported into this file — the
        // statement would land in a body the current buffer doesn't hold.
        return { ok: false, reason: 'the enclosing part() lives in a different file than the picked geometry' };
      }
      if (enclosing instanceof Part && enclosing.getNamedConnectors()[name]) {
        return {
          ok: false,
          reason: `the part already has a connector named "${name}" — pick a different name`,
        };
      }
      connectorPayload = {
        name,
        part: { line: partLoc.line, column: partLoc.column },
        ...adjustments,
      };
    }

    // An exposure lands inside the enclosing part() body exactly like a
    // connector — same call-site payload, same refusals — minus the frame
    // adjustments (an exposure has no anchor/rotate/offset).
    let exposePayload: ApplyFeatureEditSpec['expose'];
    if (feature === 'expose') {
      const owner = attributions[0]?.solidOwner ?? null;
      const enclosing = owner ? scene.findEnclosingPart(owner) : null;
      if (!enclosing) {
        return {
          ok: false,
          reason: 'exposures publish geometry inside a part() block — wrap the feature statements in part(...)',
          pick: refs[0],
        };
      }
      const name = value as string;
      const partLoc = enclosing.getSourceLocation();
      if (!partLoc) {
        return { ok: false, reason: 'the enclosing part() has no source location — re-render and try again' };
      }
      if (partLoc.filePath !== filePaths.values().next().value) {
        return { ok: false, reason: 'the enclosing part() lives in a different file than the picked geometry' };
      }
      if (enclosing instanceof Part && enclosing.getNamedExposures()[name]) {
        return {
          ok: false,
          reason: `the part already exposes "${name}" — pick a different name`,
        };
      }
      exposePayload = {
        name,
        part: { line: partLoc.line, column: partLoc.column },
      };
    }

    const spec: ApplyFeatureEditSpec = {
      feature,
      ...(feature === 'sketch' || feature === 'extrude' || feature === 'sweep' || feature === 'loft'
        || feature === 'plane' || feature === 'revolve' || feature === 'wrap' || feature === 'helix'
        || feature === 'project' || feature === 'connector' || feature === 'expose'
        ? {} : { value }),
      ...(connectorPayload ? { connector: connectorPayload } : {}),
      ...(exposePayload ? { expose: exposePayload } : {}),
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
      parts: winners.map(part => ({
        producer: part.producer ? synthesis.producers.indexOf(part.producer) : null,
        accessor: part.accessor,
        indices: part.indices,
        filterArgs: part.filterArgs,
        refs: part.refs && part.refs.length > 0
          ? part.refs.map(ref => synthesis.producers.indexOf(ref))
          : null,
      })),
      imports: collectImports(winners),
    };

    // The anchor suffix rides the args so the expression row shows (and can
    // edit) the full source expression, e.g. `e.endFaces().center()`.
    const anchorSuffix = feature === 'connector'
      ? renderConnectorAnchorSuffix(options.connector?.anchor)
      : '';

    // Statement-level alternatives: vary one group at a time, in group order,
    // walking each group's verified runner-ups. A runner-up referencing a
    // producer no winner bound has no variable name to render with (and
    // binding one just in case would cost the applied edit an unused const)
    // — skip it.
    const args = renderParts(winners) + anchorSuffix;
    const alternatives: string[] = [];
    for (let i = 0; i < synthesis.groups.length && alternatives.length < 3; i++) {
      for (const alt of synthesis.groups[i].alternatives) {
        if (alternatives.length >= 3) {
          break;
        }
        if ((alt.refs ?? []).some(ref => !names.has(ref))) {
          continue;
        }
        const variant = [...winners];
        variant[i] = alt;
        alternatives.push(renderParts(variant) + anchorSuffix);
      }
    }

    return {
      ok: true,
      spec,
      preview: renderPreview(feature, value, args, options),
      args,
      alternatives,
    };
  } finally {
    index.dispose();
  }
}

function refKey(ref: PickRef): string {
  return `${ref.shapeId}:${ref.sub.type}:${ref.sub.index}`;
}

const REHOME_PLANE_TOLERANCE = 1e-6;

/**
 * Re-home a face pick to a classified stand-in for plane-only consumers.
 * A face reshaped by later features belongs to no bucket, so synthesis falls
 * back to a geometric select(); but sketch() never touches the face's
 * geometry — only the plane it lies on — and any bindable classified planar
 * face on that same plane names the plane just as well (the accessor resolves
 * to the pre-modification face, whose plane is what sketch extracts). The
 * lineage ancestor is preferred when history recorded one; otherwise the
 * classified face buckets are scanned for a coplanar member (latest feature
 * first, mirroring the attribution preference order). Both routes require a
 * bindable feature and coplanarity with a same-side normal; anything else
 * keeps the original attribution (and its select() fallback).
 */
function rehomePlaneFacePick(index: SelectionIndex, attr: PickAttribution): PickAttribution {
  if (attr.producer || !(attr.picked instanceof Face)) {
    return attr;
  }
  const pickedPlane = FaceOps.tryGetPlane(attr.picked);
  if (!pickedPlane) {
    return attr;
  }

  const ancestor = attr.lineage ? attr.lineage.classified : null;
  const hit = ancestor && isCoplanarBindableFaceHit(index, ancestor, pickedPlane)
    ? ancestor
    : findCoplanarClassifiedFace(index, pickedPlane);
  if (!hit) {
    return attr;
  }
  return {
    ...attr,
    picked: hit.bucket.members[hit.index],
    pickedKey: hit.bucket.memberKeys[hit.index],
    producer: hit,
    lineage: null,
  };
}

/** True when the hit's feature can be bound and its member face lies on `plane` facing the same way. */
function isCoplanarBindableFaceHit(index: SelectionIndex, hit: BucketHit, plane: Plane): boolean {
  if (hit.bucket.def.kind !== 'face' || checkBindable(index, hit.bucket.feature) !== null) {
    return false;
  }
  const member = hit.bucket.members[hit.index];
  if (!(member instanceof Face)) {
    return false;
  }
  const memberPlane = FaceOps.tryGetPlane(member);
  return memberPlane !== null
    && plane.isCoplanarWith(memberPlane, REHOME_PLANE_TOLERANCE, REHOME_PLANE_TOLERANCE)
    && plane.normal.dot(memberPlane.normal) > 0;
}

/**
 * First classified face on `plane` in bucket scan order — buckets were indexed
 * latest-feature-first with specific categories (end/start/side/…) first, so
 * the name mirrors what attribution would have preferred.
 */
function findCoplanarClassifiedFace(index: SelectionIndex, plane: Plane): BucketHit | null {
  for (const bucket of index.buckets) {
    if (bucket.def.kind !== 'face') {
      continue;
    }
    for (let i = 0; i < bucket.members.length; i++) {
      const hit: BucketHit = { bucket, index: i };
      if (isCoplanarBindableFaceHit(index, hit, plane)) {
        return hit;
      }
    }
  }
  return null;
}

/**
 * One-line statement preview per feature. The transform writes sketch's
 * callback as a real multi-line empty body; the preview stands in for it.
 */
function renderPreview(
  feature: ApplyFeatureKind,
  value: number | string | undefined,
  args: string,
  options: SynthesizeOptions = {},
): string {
  if (feature === 'sketch') {
    return `sketch(${args}, () => { ... })`;
  }
  if (feature === 'extrude') {
    // The args are the target-face selector; the route composes the statement.
    return `extrude(${args})`;
  }
  if (feature === 'sweep') {
    // The args are the path selector; the route composes the full statement.
    return `sweep(${args})`;
  }
  if (feature === 'loft') {
    // The args are one profile's selector; the route composes the statement.
    return `loft(${args})`;
  }
  if (feature === 'plane') {
    // The args are one base's selector; the route composes the statement.
    return `plane(${args})`;
  }
  if (feature === 'revolve') {
    // The args are the axis-edge selector; the route composes the statement.
    return `revolve(axis(${args}))`;
  }
  if (feature === 'wrap') {
    // The args are the target-face selector; the route composes the statement.
    return `wrap(${args})`;
  }
  if (feature === 'helix') {
    // The args are the source (face or axis-edge) selector; the route composes
    // the full statement, wrapping an edge selector in axis().
    return `helix(${args})`;
  }
  if (feature === 'project') {
    // The args ARE the statement — every picked source projects onto the
    // sketch plane the emitted call lands in.
    return `project(${args})`;
  }
  if (feature === 'connector') {
    // The value channel carries the connector's name; the args already carry
    // the anchor suffix, and the dialog's rotate/offset chain follows.
    return `connector('${value}', ${args})${renderConnectorAdjustments(options.connector)}`;
  }
  if (feature === 'expose') {
    // The value channel carries the exposure's name.
    return `expose('${value}', ${args})`;
  }
  return `${feature}(${value}, ${args})`;
}

/**
 * Preview names per bound producer. When a `namer` is provided (the server
 * builds one over the live buffer with the transform's own binding logic),
 * its names win — so the preview shows the reused `const` name or the
 * collision-free allocation the transform will actually write. Without one,
 * fall back to the plain hint-suffix scheme.
 */
export function allocateNames(producers: SceneObject[], namer?: ProducerNamer): Map<SceneObject, string> {
  let external: (string | null)[] | null = null;
  if (namer) {
    try {
      const described = producers.map(producer => {
        const loc = producer.getSourceLocation()!;
        return {
          line: loc.line,
          column: loc.column,
          featureType: producer.getType(),
          nameHint: nameHintFor(producer.getType()),
        };
      });
      const result = namer(described);
      if (Array.isArray(result) && result.length === producers.length) {
        external = result;
      }
    } catch {
      // A namer failure must never block synthesis — fall back to hints.
    }
  }

  const names = new Map<SceneObject, string>();
  const used = new Set<string>();
  producers.forEach((producer, producerIndex) => {
    const externalName = external ? external[producerIndex] : null;
    if (typeof externalName === 'string' && externalName.length > 0) {
      names.set(producer, externalName);
      used.add(externalName);
      return;
    }
    const hint = nameHintFor(producer.getType());
    let name = hint;
    let suffix = 1;
    while (used.has(name)) {
      suffix++;
      name = `${hint}${suffix}`;
    }
    used.add(name);
    names.set(producer, name);
  });
  return names;
}

export function renderPartArgs(part: SelectorPart, names: Map<SceneObject, string>): string {
  let selectorArgs = part.indices ? part.indices.join(', ') : (part.filterArgs ?? '');
  (part.refs ?? []).forEach((ref, i) => {
    selectorArgs = selectorArgs.split(`{{r${i}}}`).join(names.get(ref)!);
  });
  if (part.producer === null) {
    // 'filter' parts are bare edge-filter arguments (2D ops accept them
    // directly); everything else producer-less is a global select().
    if (part.accessor === 'filter') {
      return selectorArgs;
    }
    return `select(${selectorArgs})`;
  }
  // An empty accessor names the whole feature (`fillet(4, l)`).
  if (part.accessor === '') {
    return names.get(part.producer)!;
  }
  return `${names.get(part.producer)}.${part.accessor}(${selectorArgs})`;
}

/** Symbols the emitted statement references beyond the feature itself. */
export function collectImports(
  parts: { producer: unknown; accessor: string; filterArgs: string | null }[],
): string[] {
  const imports = new Set<string>();
  for (const part of parts) {
    if (part.producer === null && part.accessor !== 'filter') {
      imports.add('select');
    }
    if (part.filterArgs) {
      if (/\bedge\(/.test(part.filterArgs)) {
        imports.add('edge');
      }
      if (/\bface\(/.test(part.filterArgs)) {
        imports.add('face');
      }
      if (/\bplane\(/.test(part.filterArgs)) {
        imports.add('plane');
      }
    }
  }
  return [...imports];
}

function explainPick(scene: SelectionScene, index: SelectionIndex, ref: PickRef): PickExplanation {
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

  if (attr.solidOwner) {
    explanation.solidOwnerId = attr.solidOwner.id;
  }

  if (attr.producer) {
    const feature = attr.producer.bucket.feature;
    const def = attr.producer.bucket.def;
    const loc = feature.getSourceLocation();
    explanation.producer = {
      featureType: feature.getType(),
      featureName: feature.getName(),
      featureId: feature.id,
      accessor: def.accessor,
      bucketKey: def.key,
      index: attr.producer.index,
      bucketSize: attr.producer.bucket.members.length,
      sourceLocation: loc,
      sharedCallSite: index.isSharedCallSite(feature),
      isClone: !!feature.getCloneSource(),
    };
    const at = loc ? ` @ line ${loc.line}` : '';
    const bindable = !explanation.producer.sharedCallSite && !explanation.producer.isClone;
    if (bindable) {
      const hint = nameHintFor(feature.getType());
      explanation.expression =
        `${hint}.${def.accessor}(${attr.producer.index}) — ${def.key.replace('-', ' ')} of ${feature.getType()}()${at}`;
    } else {
      // No variable can be bound to a clone or shared call site, so the
      // accessor form would be a lie — say what will actually be synthesized.
      const why = explanation.producer.isClone ? 'repeat instance' : 'shared call site';
      explanation.expression =
        `${def.key.replace('-', ' ')} of ${feature.getType()}()${at} (${why}) — a geometric select() will be synthesized`;
    }
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


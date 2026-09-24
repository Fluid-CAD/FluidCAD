// Parsing an editable feature call chain into its ParsedFeatureStatement.

import type { TSNode } from '../../code-editor/index.ts';
import {
  anyValueArg,
  booleanArgValue,
  numericValueArg,
  resolveRepeatTargetRef,
  stringArgValue,
} from '../ast/args.ts';
import { decomposeChain, type ChainSegment } from '../ast/chain.ts';
import { parseBooleanChain, type BooleanKind } from '../features/boolean.ts';
import { parseConnectorChain } from '../features/connector.ts';
import { parseCopyChain } from '../features/copy.ts';
import type { ExtrudeTargetKind } from '../features/extrude.ts';
import { classifyHelixSource } from '../features/helix.ts';
import { parseConditionSegment } from '../features/loft.ts';
import { parseMirrorChain } from '../features/mirror.ts';
import { parsePlaneChain } from '../features/plane.ts';
import type { ProjectionOp } from '../features/projection.ts';
import { parseRepeatChain } from '../features/repeat.ts';
import { parseRotateChain } from '../features/rotate.ts';
import { parseJoinSegment } from '../features/shell.ts';
import { parseSweepExtendSegments } from '../features/sweep.ts';
import { parseTextChain } from '../features/text.ts';
import {
  EDITABLE_CALLEES,
  OPTION_MEMBERS,
  type ChainParse,
  type ParsedRegionChain,
  type ParsedScopeChain,
} from './parsed-statement.ts';
import type { RegionName, ValueExpr } from '../value-expr.ts';

/**
 * The `.region(…)` chain's arguments: the names of the sketch's `region()`
 * declarations, as string literals. Anything else (a variable, an
 * expression) is not a form the dialog can show, so the parse refuses.
 */
function parseRegionSegment(recognized: Map<string, ChainSegment>): ParsedRegionChain | { error: string } {
  const regions: RegionName[] = [];
  for (const arg of recognized.get('region')?.args ?? []) {
    if (arg.type === 'string') {
      const name = stringArgValue(arg);
      if (name === null) {
        return { error: 'a .region() name is not a plain string — edit it in the source' };
      }
      regions.push(name);
      continue;
    }
    return { error: 'a .region() argument is not a region name — edit it in the source' };
  }
  return { regions };
}

function parseScopeSegment(recognized: Map<string, ChainSegment>, start: number): ParsedScopeChain {
  const scopeNodes = recognized.get('scope')?.args ?? [];
  return {
    scopeTexts: scopeNodes.map(n => n.text),
    scopeRefs: scopeNodes.map(n => resolveRepeatTargetRef(n, start)),
  };
}

export function parseFeatureChain(call: TSNode, code: string, numericVars: Set<string> = new Set()): ChainParse {
  const chain = decomposeChain(call);
  if (!chain) {
    return { error: 'the call at that line is not a plain feature call chain' };
  }
  const feature = EDITABLE_CALLEES[chain.root.name];
  if (!feature) {
    return { error: `${chain.root.name}() is not an editable feature statement` };
  }

  const options = OPTION_MEMBERS[feature];
  const recognized = new Map<string, ChainSegment>();
  const connections: ChainSegment[] = [];
  const extensions: ChainSegment[] = [];
  let end = chain.root.endIndex;
  let stopped = false;
  for (const member of chain.members) {
    if (!stopped && options.has(member.name)) {
      if (feature === 'loft' && member.name === 'connect') {
        connections.push(member);
        end = member.endIndex;
        continue;
      }
      if (feature === 'sweep' && member.name === 'extend') {
        extensions.push(member);
        end = member.endIndex;
        continue;
      }
      if (recognized.has(member.name)) {
        return { error: `the statement chains .${member.name}() twice` };
      }
      recognized.set(member.name, member);
      end = member.endIndex;
      continue;
    }
    stopped = true;
    if (options.has(member.name)) {
      return { error: `a .${member.name}() chain follows other calls the dialog cannot edit — edit the statement in the source instead` };
    }
  }
  const start = call.startIndex;
  const args = chain.root.args;

  if (feature === 'shell' || feature === 'fillet' || feature === 'chamfer') {
    if (args.length === 0) {
      return { error: `the ${feature}() call has no arguments` };
    }
    // The value slot competes with the selector args — a numeric literal,
    // known numeric variable, or arithmetic reads as the value; a selector
    // expression there means the value was omitted, which has no dialog.
    const value = numericValueArg(args[0], numericVars);
    if (value === null) {
      return { error: `the ${feature}() ${feature === 'shell' ? 'thickness' : feature === 'fillet' ? 'radius' : 'distance'} is not a plain number or expression — edit it in the source` };
    }
    // Chamfer's second-value overloads: a numeric second argument reads as
    // the second distance, and a literal `true`/`false` after it as the
    // angle flag — everything past the value slots is the selector list.
    let distance2: ValueExpr | null = null;
    let isAngle = false;
    let selectorsFrom = 1;
    if (feature === 'chamfer' && args.length > 1) {
      const second = numericValueArg(args[1], numericVars);
      if (second !== null) {
        distance2 = second;
        selectorsFrom = 2;
        if (args.length > 2 && (args[2].type === 'true' || args[2].type === 'false')) {
          isAngle = args[2].type === 'true';
          selectorsFrom = 3;
        }
      }
    }
    const argsText = args.length > selectorsFrom
      ? code.slice(args[selectorsFrom].startIndex, args[args.length - 1].endIndex)
      : '';
    if (feature === 'shell') {
      const joinParse = parseJoinSegment(recognized.get('join'));
      if ('error' in joinParse) {
        return joinParse;
      }
      return { parsed: { feature, value, argsText, joinType: joinParse.joinType }, start, end };
    }
    if (feature === 'chamfer') {
      return { parsed: { feature, value, argsText, distance2, isAngle }, start, end };
    }
    return { parsed: { feature, value, argsText }, start, end };
  }

  if (feature === 'offset') {
    // Every slot is optional: `offset()` offsets the whole sketch by the
    // kernel's default 1, and the distance competes with the target list for
    // the first position — a non-numeric first argument IS a target, so the
    // dialog opens on that default rather than refusing.
    let value: ValueExpr = 1;
    let selectorsFrom = 0;
    if (args.length > 0) {
      const distance = numericValueArg(args[0], numericVars);
      if (distance !== null) {
        value = distance;
        selectorsFrom = 1;
      }
    }
    // The removeOriginal boolean was removed from offset() — a statement
    // still carrying it fails its build, so the dialog refuses honestly
    // instead of seeding a toggle that no longer exists.
    if (selectorsFrom === 1 && args.length > 1 && booleanArgValue(args[1]) !== null) {
      return { error: 'offset() no longer takes a removeOriginal flag — delete the boolean in the source and mark the sources .guide() instead' };
    }
    const argsText = args.length > selectorsFrom
      ? code.slice(args[selectorsFrom].startIndex, args[args.length - 1].endIndex)
      : '';
    const closeSegment = recognized.get('close');
    if (closeSegment && closeSegment.args.length > 0) {
      return { error: 'the .close() chain takes no arguments — edit the statement in the source' };
    }
    return {
      parsed: { feature, value, argsText, close: closeSegment !== undefined },
      start,
      end,
    };
  }

  if (feature === 'project') {
    // The whole argument list is the dialog-editable surface — the projected
    // sources, kept verbatim unless re-picked. No value slot, no chains. The
    // callee itself (`project` or `intersect`) is the one thing the dialog
    // never changes, so the rewrite reads it back from here.
    const argsText = args.length > 0
      ? code.slice(args[0].startIndex, args[args.length - 1].endIndex)
      : '';
    return { parsed: { feature, op: chain.root.name as ProjectionOp, argsText }, start, end };
  }

  if (feature === 'connector') {
    return parseConnectorChain(args, recognized, code, start, end);
  }

  if (feature === 'text') {
    return parseTextChain(args, recognized, start, end);
  }

  if (feature === 'sketch') {
    // sketch(() => {…}) / sketch(<target>, () => {…}[, true]): only the
    // target argument (a plane string, plane variable, or face selector) is
    // dialog-editable; the body callback and the solved-mode flag are
    // preserved verbatim.
    const positional = [...args];
    let solvedText: string | null = null;
    const last = positional[positional.length - 1];
    if (last && (last.type === 'true' || last.type === 'false')) {
      solvedText = last.text;
      positional.pop();
    }
    if (positional.length < 1 || positional.length > 2) {
      return { error: 'the sketch has an argument shape the dialog cannot edit' };
    }
    const body = positional[positional.length - 1];
    if (body.type !== 'arrow_function' && body.type !== 'function_expression'
      && body.type !== 'function' && body.type !== 'identifier') {
      return { error: 'the sketch body is not a function — edit it in the source' };
    }
    return {
      parsed: {
        feature,
        targetText: positional.length === 2 ? positional[0].text : null,
        bodyText: body.text,
        solvedText,
      },
      start,
      end,
    };
  }

  if (feature === 'repeat') {
    return parseRepeatChain(args, start, end, numericVars);
  }

  if (feature === 'copy') {
    return parseCopyChain(args, start, end);
  }

  if (feature === 'mirror') {
    return parseMirrorChain(args, recognized, start, end);
  }

  if (feature === 'rotate') {
    return parseRotateChain(args, start, end, numericVars);
  }

  if (feature === 'boolean') {
    return parseBooleanChain(chain.root.name as BooleanKind, args, start, end);
  }

  if (feature === 'plane') {
    return parsePlaneChain(args, start, end, numericVars);
  }

  const isCut = chain.root.name === 'cut';
  const hasRemove = recognized.has('remove');
  const hasNew = recognized.has('new');
  if ((isCut || hasRemove) && hasNew) {
    return { error: 'the statement chains both a remove and .new()' };
  }
  const op: 'add' | 'remove' | 'new' = isCut || hasRemove ? 'remove' : hasNew ? 'new' : 'add';

  let thin: [ValueExpr] | [ValueExpr, ValueExpr] | null = null;
  const thinSeg = recognized.get('thin');
  if (thinSeg) {
    if (thinSeg.args.length < 1 || thinSeg.args.length > 2) {
      return { error: 'only a one- or two-offset .thin() can be edited in the dialog' };
    }
    const offsets: ValueExpr[] = [];
    for (const arg of thinSeg.args) {
      const offset = anyValueArg(arg);
      if (offset === null) {
        return { error: 'a .thin() offset is not a plain number or expression — edit it in the source' };
      }
      offsets.push(offset);
    }
    thin = offsets.length === 1 ? [offsets[0]] : [offsets[0], offsets[1]];
  }

  if (feature === 'extrude') {
    // Leading numeric values are distances — literals, known numeric
    // variables, or arithmetic; one, or two for the two-distance form
    // extrude(d1, d2); a single trailing non-numeric argument is the bound
    // profile expression, kept verbatim. A cut() with no distance is the
    // through-all remove. With NO distance, a leading string literal is a
    // first/last-face target and a call expression (`e.endFaces()`,
    // `select(…)`) is a picked-face target — two non-numeric arguments are
    // the target and the profile.
    const distances: ValueExpr[] = [];
    while (distances.length < Math.min(args.length, 2)) {
      const value = numericValueArg(args[distances.length], numericVars);
      if (value === null) {
        break;
      }
      distances.push(value);
    }
    const rest = args.slice(distances.length);
    const restLimit = distances.length === 0 ? 2 : 1;
    if (rest.length > restLimit || rest.some(arg => numericValueArg(arg, numericVars) !== null)) {
      return { error: 'the extrude has more arguments than the dialog understands' };
    }
    // The only string argument the call takes is a leading first/last-face
    // target; anywhere else it is not a form the dialog can read.
    const literalIndex = rest.findIndex(arg => arg.type === 'string');
    if (literalIndex > 0 || (literalIndex === 0 && distances.length > 0)) {
      return { error: 'the extrude has arguments the dialog does not understand' };
    }
    let toFaceText: string | null = null;
    let toFaceKind: ExtrudeTargetKind | null = null;
    let profileText: string | null = null;
    if (rest[0]?.type === 'string') {
      // extrude/cut('first-face' | 'last-face'[, <profile>]). The target may
      // carry face filters — call expressions the dialog cannot represent —
      // so a filtered target stays in the source.
      const literal = stringArgValue(rest[0]);
      if (literal !== 'first-face' && literal !== 'last-face') {
        return { error: `the ${chain.root.name}() target must be 'first-face' or 'last-face' — edit it in the source` };
      }
      if (rest[1]?.type === 'call_expression') {
        return { error: `a filtered '${literal}' ${chain.root.name}() target is not editable in the dialog — edit it in the source` };
      }
      toFaceText = rest[0].text;
      toFaceKind = literal;
      profileText = rest[1]?.text ?? null;
    } else if (distances.length === 0 && rest.length === 2) {
      // extrude(<face>, <profile>): unambiguous — a two-argument call with
      // no distance is the up-to-face form.
      toFaceText = rest[0].text;
      toFaceKind = 'selector';
      profileText = rest[1].text;
    } else if (distances.length === 0 && rest.length === 1 && rest[0].type === 'call_expression') {
      // A call expression can't be a bound profile variable — read it as
      // the up-to-face target (matches what the create dialog writes).
      toFaceText = rest[0].text;
      toFaceKind = 'selector';
    } else {
      profileText = rest.length === 1 ? rest[0].text : null;
    }
    const distance = distances[0] ?? null;
    const distance2 = distances[1] ?? null;
    if (distance === null && toFaceText === null && !isCut) {
      // extrude(x) is ambiguous between a variable distance and a bound
      // profile at the default distance — neither is dialog-editable.
      return {
        error: profileText !== null
          ? `the ${chain.root.name}() distance is not a plain number — edit it in the source`
          : 'an extrude with no distance is not editable in the dialog',
      };
    }

    const symmetricSeg = recognized.get('symmetric');
    if (symmetricSeg && symmetricSeg.args.length > 0) {
      return { error: 'the .symmetric() chain has arguments the dialog cannot edit' };
    }
    const symmetric = symmetricSeg !== undefined;
    if (symmetric && distance2 !== null) {
      return { error: `a two-distance ${chain.root.name}() cannot chain .symmetric() — edit it in the source` };
    }
    if (symmetric && toFaceText !== null) {
      return { error: `a to-face ${chain.root.name}() cannot chain .symmetric() — edit it in the source` };
    }

    let draft: ValueExpr | null = null;
    const draftSeg = recognized.get('draft');
    if (draftSeg) {
      if (draftSeg.args.length !== 1) {
        return { error: 'the .draft() chain has an argument shape the dialog cannot edit' };
      }
      draft = anyValueArg(draftSeg.args[0]);
      if (draft === null) {
        return { error: 'the .draft() angle is not a plain number or expression — edit it in the source' };
      }
    }

    let endOffset: ValueExpr | null = null;
    const endOffsetSeg = recognized.get('endOffset');
    if (endOffsetSeg) {
      if (endOffsetSeg.args.length !== 1) {
        return { error: 'the .endOffset() chain has an argument shape the dialog cannot edit' };
      }
      endOffset = anyValueArg(endOffsetSeg.args[0]);
      if (endOffset === null) {
        return { error: 'the .endOffset() value is not a plain number or expression — edit it in the source' };
      }
    }

    let drill = true;
    const drillSeg = recognized.get('drill');
    if (drillSeg) {
      if (drillSeg.args.length > 1) {
        return { error: 'the .drill() chain has more arguments than the dialog understands' };
      }
      if (drillSeg.args.length === 1) {
        const value = booleanArgValue(drillSeg.args[0]);
        if (value === null) {
          return { error: 'the .drill() argument is not a plain boolean — edit it in the source' };
        }
        drill = value;
      }
      // A bare .drill() means true — the API default.
    }

    const regionParse = parseRegionSegment(recognized);
    if ('error' in regionParse) {
      return regionParse;
    }
    return {
      parsed: {
        feature, op, distance, distance2, symmetric, draft, endOffset, drill, thin,
        profileText, toFaceText, toFaceKind,
        ...parseScopeSegment(recognized, start),
        ...regionParse,
      },
      start,
      end,
    };
  }

  if (feature === 'rib') {
    // rib(<thickness>[, <spine>]): the thickness is a numeric literal, a
    // known numeric variable, or arithmetic; a single trailing non-numeric
    // argument is the bound spine expression, kept verbatim.
    if (args.length < 1 || args.length > 2) {
      return { error: 'the rib has an argument shape the dialog cannot edit' };
    }
    const thickness = numericValueArg(args[0], numericVars);
    if (thickness === null) {
      return { error: 'the rib thickness is not a plain number or expression — edit it in the source' };
    }
    let spineText: string | null = null;
    if (args.length === 2) {
      if (numericValueArg(args[1], numericVars) !== null) {
        return { error: 'the rib has arguments the dialog does not understand' };
      }
      spineText = args[1].text;
    }

    const parallelSeg = recognized.get('parallel');
    if (parallelSeg && parallelSeg.args.length > 0) {
      return { error: 'the .parallel() chain takes no arguments — edit the statement in the source' };
    }
    const extendSeg = recognized.get('extend');
    if (extendSeg && extendSeg.args.length > 0) {
      return { error: 'the .extend() chain takes no arguments — edit the statement in the source' };
    }

    let draft: ValueExpr | null = null;
    const draftSeg = recognized.get('draft');
    if (draftSeg) {
      if (draftSeg.args.length !== 1) {
        return { error: 'the .draft() chain has an argument shape the dialog cannot edit' };
      }
      draft = anyValueArg(draftSeg.args[0]);
      if (draft === null) {
        return { error: 'the .draft() angle is not a plain number or expression — edit it in the source' };
      }
    }

    return {
      parsed: {
        feature,
        op,
        thickness,
        parallel: parallelSeg !== undefined,
        extend: extendSeg !== undefined,
        draft,
        spineText,
        ...parseScopeSegment(recognized, start),
      },
      start,
      end,
    };
  }

  if (feature === 'sweep') {
    if (args.length < 1 || args.length > 2) {
      return { error: 'the sweep has more arguments than the dialog understands' };
    }
    const extend = parseSweepExtendSegments(extensions);
    if ('error' in extend) {
      return extend;
    }
    const regionParse = parseRegionSegment(recognized);
    if ('error' in regionParse) {
      return regionParse;
    }
    return {
      parsed: {
        feature, op, thin, ...extend, pathText: args[0].text, profileText: args[1]?.text ?? null,
        ...parseScopeSegment(recognized, start),
        ...regionParse,
      },
      start,
      end,
    };
  }

  if (feature === 'wrap') {
    // wrap(<thickness>, <sketch>, <face>): the thickness must be a plain
    // literal; the sketch and face expressions are kept verbatim.
    if (args.length !== 3) {
      return { error: 'the wrap has an argument shape the dialog cannot edit' };
    }
    const thickness = anyValueArg(args[0]);
    if (thickness === null) {
      return { error: 'the wrap() thickness is not a plain number or expression — edit it in the source' };
    }
    const regionParse = parseRegionSegment(recognized);
    if ('error' in regionParse) {
      return regionParse;
    }
    return {
      parsed: { feature, op, thickness, sketchText: args[1].text, faceText: args[2].text, ...regionParse },
      start,
      end,
    };
  }

  if (feature === 'revolve') {
    // revolve(<axis>[, <angle>][, <profile>]): the axis is always first,
    // kept verbatim; a numeric-valued second argument is the angle (360 when
    // omitted) — a literal, known numeric variable, or arithmetic; a
    // trailing non-numeric argument is the bound profile expression, kept
    // verbatim — the create dialog's own shape. An unknown identifier is
    // indistinguishable from a profile, so it reads as one; the rule mirrors
    // extrude's distances.
    if (args.length < 1 || args.length > 3) {
      return { error: 'the revolve has more arguments than the dialog understands' };
    }
    const axisText = args[0].text;
    let angle: ValueExpr | null = null;
    let rest = args.slice(1);
    if (rest.length > 0) {
      const value = numericValueArg(rest[0], numericVars);
      if (value !== null) {
        angle = value;
        rest = rest.slice(1);
      }
    }
    if (rest.length > 1 || (rest.length === 1 && numericValueArg(rest[0], numericVars) !== null)) {
      return { error: 'the revolve has more arguments than the dialog understands' };
    }
    const symmetricSeg = recognized.get('symmetric');
    if (symmetricSeg && symmetricSeg.args.length > 0) {
      return { error: 'the .symmetric() chain has arguments the dialog cannot edit' };
    }
    const symmetric = symmetricSeg !== undefined;
    const regionParse = parseRegionSegment(recognized);
    if ('error' in regionParse) {
      return regionParse;
    }
    return {
      parsed: {
        feature, op, angle, symmetric, thin, axisText, profileText: rest[0]?.text ?? null,
        ...parseScopeSegment(recognized, start),
        ...regionParse,
      },
      start,
      end,
    };
  }

  if (feature === 'helix') {
    // helix(<source>): the single source argument (an axis literal/statement,
    // an axis(edge) call, or a face selector) is kept verbatim; every geometry
    // option is a chained configurator read as a plain number or expression.
    if (args.length !== 1) {
      return { error: 'the helix has an argument shape the dialog cannot edit' };
    }
    const sourceText = args[0].text;
    const option = (name: string): { value: ValueExpr | null } | { error: string } => {
      const seg = recognized.get(name);
      if (!seg) {
        return { value: null };
      }
      if (seg.args.length !== 1) {
        return { error: `the .${name}() chain has an argument shape the dialog cannot edit` };
      }
      const value = anyValueArg(seg.args[0]);
      if (value === null) {
        return { error: `the .${name}() value is not a plain number or expression — edit it in the source` };
      }
      return { value };
    };
    const radius = option('radius');
    if ('error' in radius) {
      return radius;
    }
    const endRadius = option('endRadius');
    if ('error' in endRadius) {
      return endRadius;
    }
    const pitch = option('pitch');
    if ('error' in pitch) {
      return pitch;
    }
    const turns = option('turns');
    if ('error' in turns) {
      return turns;
    }
    const height = option('height');
    if ('error' in height) {
      return height;
    }
    const startOffset = option('startOffset');
    if ('error' in startOffset) {
      return startOffset;
    }
    const endOffset = option('endOffset');
    if ('error' in endOffset) {
      return endOffset;
    }
    return {
      parsed: {
        feature,
        sourceText,
        sourceMode: classifyHelixSource(sourceText),
        radius: radius.value,
        endRadius: endRadius.value,
        pitch: pitch.value,
        turns: turns.value,
        height: height.value,
        startOffset: startOffset.value,
        endOffset: endOffset.value,
      },
      start,
      end,
    };
  }

  // Loft: every root argument is a profile expression, in order.
  if (args.length < 2) {
    return { error: 'the loft has fewer than two profiles' };
  }
  if (connections.some(connection => connection.args.length !== args.length || connection.args.some(arg => arg.type === 'spread_element'))) {
    return { error: `each .connect() must have ${args.length} points, one per loft profile` };
  }
  const guideSeg = recognized.get('guides');
  if (guideSeg && (guideSeg.args.length < 1 || guideSeg.args.length > 2)) {
    return { error: 'the .guides() chain must carry one or two guides' };
  }
  const startParse = parseConditionSegment(recognized.get('startCondition'));
  if ('error' in startParse) {
    return startParse;
  }
  const endParse = parseConditionSegment(recognized.get('endCondition'));
  if ('error' in endParse) {
    return endParse;
  }
  return {
    parsed: {
      feature: 'loft',
      op,
      thin,
      profileTexts: args.map(a => a.text),
      connectionTexts: connections.map(connection => connection.args.map(arg => arg.text)),
      connectionArgs: connections.map(connection => connection.argsText),
      guideTexts: guideSeg ? guideSeg.args.map(a => a.text) : [],
      startCondition: startParse.condition,
      endCondition: endParse.condition,
      ...parseScopeSegment(recognized, start),
    },
    start,
    end,
  };
}

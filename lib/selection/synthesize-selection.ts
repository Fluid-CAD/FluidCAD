import { SceneObject } from "../common/scene-object.js";
import { SelectionIndex } from "./selection-index.js";
import { attributePick } from "./attribution.js";
import { synthesizeSelectors, SelectorPart } from "./synthesis.js";
import { allocateNames, collectImports, makeStatementBindable, renderPartArgs } from "./explain.js";
import { nameHintFor } from "./types.js";
import type { PickRef, SelectionScene, SynthesizeOptions } from "./types.js";
import type { Part } from "../features/part.js";
import type { ResolvedSelectionMatch, ResolveSelectionRequest } from "./resolve-selection.js";

/** A feature the synthesized selector references through a variable. */
export type SynthesizedProducer = {
  sceneObjectId: string;
  sceneObjectName: string;
  featureType: string;
  /** The variable the source form uses for it — the statement's existing `const`, or the name to bind it to. */
  variable: string;
  /** The statement's call site; `bound` is filled in by the server from the live buffer. */
  filePath: string | null;
  line: number | null;
  column: number | null;
  bound?: boolean;
};

/** One rendering of the selector, in both forms. */
export type SynthesizedForm = {
  /** Evaluable form: producers as `$obj["<id>"]`, a list of selections as an array — resolves through the same tool. */
  expression: string;
  /** Source form: the argument list to write into the file, producers by variable name. */
  source: string;
};

export type SynthesizedSelectionPart = {
  producer: string | null;
  accessor: string;
  /**
   * 0: a whole feature bucket (`e.endEdges()`); 1–2: bucket + induced filter;
   * 3: scene-wide `select()` with an induced filter; 4: bucket indices.
   */
  tier: 0 | 1 | 2 | 3 | 4;
  /** Geometry constants the filter bakes that no parameter tracks — lower ranked, fragile under edits. */
  bakedConstants?: number;
};

export type SynthesizedSelection =
  | (SynthesizedForm & {
    ok: true;
    /** Whether the winning expression is the one the request gave (whitespace and quote style aside). */
    sameAsInput: boolean;
    parts: SynthesizedSelectionPart[];
    producers: SynthesizedProducer[];
    /** Symbols the source form needs imported beyond the feature itself (`select`, `edge`, `face`, `plane`). */
    imports: string[];
    /** Verified runner-up renderings, best first. */
    alternatives: SynthesizedForm[];
  })
  | { ok: false; reason: string; pick?: PickRef };

/**
 * The selector the language would write for a resolved set of faces/edges:
 * the same tier ladder and oracle verification the UI's pick flow runs
 * (`synthesizeSelectors`), rendered twice — once in the tool's evaluable
 * `$obj` form, once as the source argument list with the variable names the
 * code transform would use. A request that gave an expression learns whether
 * synthesis kept it (`sameAsInput`) or found a form that binds a producer
 * instead of baking geometry.
 */
export class SelectionSynthesizer {

  static synthesize(
    scene: SelectionScene,
    matches: ResolvedSelectionMatch[],
    scopePart: Part | null,
    request: ResolveSelectionRequest,
    options: SynthesizeOptions,
  ): SynthesizedSelection {
    if (matches.some(m => m.instanceId !== undefined)) {
      return { ok: false, reason: 'selectors are synthesized in the part file; an instance scope resolves the inserted part\'s build only.' };
    }
    const refs: PickRef[] = matches.map(m => ({ shapeId: m.shapeId, sub: { type: m.kind, index: m.index } }));
    const index = new SelectionIndex(scene);
    try {
      const attributions = refs.map(ref => attributePick(scene, index, ref));
      const synthesis = synthesizeSelectors(
        scene, index, attributions, [], options.params ?? [], false, makeStatementBindable(options.bindable),
      );
      if (synthesis.ok === false) {
        return { ok: false, reason: synthesis.reason, ...(synthesis.pick ? { pick: synthesis.pick } : {}) };
      }

      const winners = synthesis.groups.map(g => g.winner);
      const sourceNames = allocateNames(synthesis.producers, options.namer);
      const toolNames = new Map(synthesis.producers.map(p => [p, `$obj["${p.id}"]`] as const));
      const render = (parts: SelectorPart[]): SynthesizedForm => ({
        expression: SelectionSynthesizer.renderToolExpression(parts, toolNames),
        source: parts.map(part => renderPartArgs(part, sourceNames)).join(', '),
      });

      const winner = render(winners);
      const alternatives: SynthesizedForm[] = [];
      for (let i = 0; i < synthesis.groups.length && alternatives.length < 3; i++) {
        for (const alt of synthesis.groups[i].alternatives) {
          if (alternatives.length >= 3) {
            break;
          }
          if ((alt.refs ?? []).some(ref => !sourceNames.has(ref))) {
            continue;
          }
          const variant = [...winners];
          variant[i] = alt;
          alternatives.push(render(variant));
        }
      }

      return {
        ok: true,
        ...winner,
        sameAsInput: request.expression !== undefined
          && SelectionSynthesizer.normalize(request.expression) === SelectionSynthesizer.normalize(winner.expression),
        parts: winners.map(part => ({
          producer: part.producer?.id ?? null,
          accessor: part.accessor,
          tier: part.tier,
          ...(part.bakedConstants ? { bakedConstants: part.bakedConstants } : {}),
        })),
        producers: synthesis.producers.map(p => SelectionSynthesizer.describeProducer(p, sourceNames)),
        imports: collectImports(winners),
        alternatives,
      };
    } finally {
      index.dispose();
    }
  }

  /**
   * The tool form differs from source in two places: producers are `$obj`
   * lookups, and a producer-less part is the bare filter (the evaluator binds
   * no `select`). Several parts become an array, which the evaluator accepts.
   */
  private static renderToolExpression(parts: SelectorPart[], names: Map<SceneObject, string>): string {
    const rendered = parts.map(part => {
      if (part.producer === null) {
        let args = part.indices ? part.indices.join(', ') : (part.filterArgs ?? '');
        (part.refs ?? []).forEach((ref, i) => {
          args = args.split(`{{r${i}}}`).join(names.get(ref)!);
        });
        return args;
      }
      return renderPartArgs(part, names);
    });
    return rendered.length === 1 ? rendered[0] : `[${rendered.join(', ')}]`;
  }

  private static describeProducer(producer: SceneObject, names: Map<SceneObject, string>): SynthesizedProducer {
    const loc = producer.getSourceLocation();
    return {
      sceneObjectId: producer.id,
      sceneObjectName: producer.getName(),
      featureType: producer.getType(),
      variable: names.get(producer) ?? nameHintFor(producer.getType()),
      filePath: loc?.filePath ?? null,
      line: loc?.line ?? null,
      column: loc?.column ?? null,
    };
  }

  /** Whitespace and quote style carry no meaning in a selector; compare without them. */
  private static normalize(expression: string): string {
    return expression.replace(/\s+/g, '').replace(/'/g, '"');
  }
}

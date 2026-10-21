import type { ApplyFeatureEditSpec } from './apply-feature-edit/index.ts';
import type { SceneConfigurations } from './fluidcad-server/index.ts';
import type { ConfigurationEditSpec } from './configuration-edit.ts';
import { DEFAULT_CONFIGURATION_NAME } from './configuration-edit.ts';
import { ConfigurationTargets, ConfigurationsForecast } from './configuration-targets.ts';
import type { ParamEditSpec, ParamLiteral } from './param-edit.ts';
import { coerceParamOverride, ParamKey, type ParamDefinition } from '../../lib/dist/index.js';

/**
 * One value the Parameters panel committed (`POST /api/params/value`): the
 * parameter by its label and body, as the panel keys its rows, and the new
 * value — or null, "inherit again": clear the active row's cell so the
 * parameter reads its literal. `configuration` is the row the panel had on
 * screen; a session that moved on since refuses the write rather than put
 * the value into another row.
 */
export type ParamValueRequest = {
  label: string;
  body?: string;
  value: unknown;
  configuration?: string;
};

/** Where the value goes, as the edit that writes it: a `param()` literal or a row's cell. */
export type ParamValuePlan = {
  /** The parameter written, for the session override the write supersedes. */
  key: ParamKey;
  /** The value as written, coerced to the literal's type; null for a cleared cell. */
  value: ParamLiteral | null;
  /** The ONE edit the host applies — one undo step, one render. */
  spec: ApplyFeatureEditSpec;
  /** On a row: the summary as the render after the edit will report it. */
  configurations?: SceneConfigurations;
};

/** A request this side refuses before any source is touched. */
export type ParamValueRefusal = { status: number; error: string };

/**
 * The Parameters panel's value write, as one source edit. A value edited
 * in the panel is no session tweak on an editing host: it goes where the
 * configuration on screen keeps it.
 *
 * - On a configuration row it is that row's cell, in the table of the body
 *   that declares the parameter (the table, or the row in it, is created as
 *   Add creates them). Null clears the cell: the row inherits the literal
 *   again.
 * - On Default — which is every file's only configuration when it has no
 *   `configurations()` table — it is the `param()` call's default literal,
 *   the same swap the pencil's default-value change makes, in the file that
 *   declares the parameter.
 *
 * The value is checked against the declaration first, as the controls
 * would take it: coerced to the literal's type, inside `min`/`max`, one of
 * a select's options. A refusal here leaves the source alone; the editor
 * refusals (a non-literal table, a default that is no plain value) come
 * back from the transform the same way.
 */
export class ParamValueWrite {

  /**
   * Plan the write of `request` into `file`, rendered last with
   * `definitions` and showing `configurations`.
   */
  static plan(
    definitions: ParamDefinition[],
    file: string,
    configurations: SceneConfigurations,
    request: ParamValueRequest,
  ): ParamValuePlan | ParamValueRefusal {
    const def = ParamValueWrite.definitionOf(definitions, request.label, request.body);
    if (ParamValueWrite.refused(def)) {
      return def;
    }
    const key = ParamKey.ofDefinition(def);
    const active = configurations.active;
    if (request.configuration !== undefined && request.configuration !== active) {
      return {
        status: 409,
        error: `The configuration on screen is ${active}, not ${request.configuration} — the value was not written.`,
      };
    }
    if (request.value === null) {
      return ParamValueWrite.clearCell(definitions, file, configurations, def, key);
    }
    const value = ParamValueWrite.check(def, request.value);
    if (ParamValueWrite.refused(value)) {
      return value;
    }
    if (active === DEFAULT_CONFIGURATION_NAME) {
      return ParamValueWrite.literal(def, key, value);
    }
    const targets = new ConfigurationTargets(definitions, file);
    const cells = targets.group({ [key.id]: value });
    if ('error' in cells) {
      return { status: 400, error: cells.error };
    }
    const edit: ConfigurationEditSpec = { kind: 'set', name: active, bodies: targets.edits(cells) };
    const forecast = new ConfigurationsForecast(configurations, targets.soleBody);
    forecast.setCells(active, cells);
    return {
      key,
      value,
      spec: ParamValueWrite.spec(file, { configurationEdit: edit }),
      configurations: forecast.summary(active, false),
    };
  }

  /**
   * The value as the declaration takes it, or why it does not: the type the
   * literal has (a number field's text is a number), then the declaration's
   * own bounds — `min`/`max` of a number or slider, a select's options.
   */
  static check(def: ParamDefinition, input: unknown): ParamLiteral | ParamValueRefusal {
    const refuse = (error: string): ParamValueRefusal => ({ status: 400, error });
    const label = def.label;
    if (Array.isArray(input) && !Array.isArray(def.defaultValue)) {
      return refuse(`${label} takes one value, not a list.`);
    }
    if (typeof def.defaultValue === 'number') {
      const number = typeof input === 'string' && input.trim() === '' ? Number.NaN : Number(input);
      if (typeof input === 'boolean' || !Number.isFinite(number)) {
        return refuse(`${label} needs a number.`);
      }
    }
    if (typeof def.defaultValue === 'boolean' && ![true, false, 'true', 'false', 1, 0].includes(input as never)) {
      return refuse(`${label} is on or off — true or false.`);
    }
    const value = coerceParamOverride(def.defaultValue, input) as ParamLiteral;
    if (typeof value === 'number') {
      if (typeof def.min === 'number' && value < def.min) {
        return refuse(`${label} must be at least ${def.min}.`);
      }
      if (typeof def.max === 'number' && value > def.max) {
        return refuse(`${label} must be at most ${def.max}.`);
      }
    }
    const options = def.options;
    if (options && options.length > 0) {
      const picked = Array.isArray(value) ? value : [value];
      for (const item of picked) {
        const option = options.find((o) => String(o.value) === String(item));
        if (!option) {
          return refuse(`${String(item)} is not one of ${label}'s options.`);
        }
      }
      // A select's value takes its option's type: `'8'` from a numeric
      // option's <select> is the number 8 the option declares.
      const typed = picked.map((item) => options.find((o) => String(o.value) === String(item))!.value);
      return Array.isArray(value) ? typed : typed[0];
    }
    return value;
  }

  /** Whether a plan step answered with a refusal rather than a value. */
  static refused<T>(result: T | ParamValueRefusal): result is ParamValueRefusal {
    return typeof result === 'object' && result !== null && !Array.isArray(result) && 'status' in result;
  }

  /** The parameter `label` (of `body`) names in the last render, or why none does. */
  private static definitionOf(
    definitions: ParamDefinition[],
    label: string,
    body: string | undefined,
  ): ParamDefinition | ParamValueRefusal {
    const own = definitions.filter((def) => def.kind !== 'global');
    let wanted = body;
    if (wanted === undefined) {
      const resolved = ParamKey.resolveLabel(label, ParamKey.holdersOf(own));
      if ('error' in resolved) {
        return { status: 400, error: resolved.error };
      }
      wanted = resolved.key.body ?? undefined;
    }
    const def = own.find((candidate) => candidate.label === label && candidate.body === wanted);
    if (def) {
      return def;
    }
    if (definitions.some((candidate) => candidate.kind === 'global' && candidate.label === label)) {
      return { status: 400, error: `'${label}' is a project parameter — change it in the project Parameters column.` };
    }
    return { status: 404, error: `${ParamKey.of(wanted, label).describe()} is no parameter of the model on screen.` };
  }

  /** Default: swap the `param()` call's default literal, in the file that declares it. */
  private static literal(def: ParamDefinition, key: ParamKey, value: ParamLiteral): ParamValuePlan | ParamValueRefusal {
    const location = def.sourceLocation;
    if (!location) {
      return {
        status: 422,
        error: `'${def.label}' is not declared in a model file the panel can edit — change it in the code.`,
      };
    }
    const paramEdit: ParamEditSpec = { kind: 'value', expectedLabel: def.label, line: location.line, value };
    return { key, value, spec: ParamValueWrite.spec(location.filePath, { paramEdit }) };
  }

  /** Null on a row: unset the row's cell, so the parameter reads its literal again. */
  private static clearCell(
    definitions: ParamDefinition[],
    file: string,
    configurations: SceneConfigurations,
    def: ParamDefinition,
    key: ParamKey,
  ): ParamValuePlan | ParamValueRefusal {
    const active = configurations.active;
    if (active === DEFAULT_CONFIGURATION_NAME) {
      return { status: 400, error: `${DEFAULT_CONFIGURATION_NAME} is the param() literals — it has no cell to clear.` };
    }
    if (def.configuredValue === undefined) {
      return { status: 400, error: `${active} does not set ${def.label} — it already reads the default.` };
    }
    const targets = new ConfigurationTargets(definitions, file);
    const byBody = targets.groupRows({ [active]: { [key.id]: null } }, null);
    if ('error' in byBody) {
      return { status: 400, error: byBody.error };
    }
    const edit: ConfigurationEditSpec = { kind: 'table', bodies: targets.rowEdits(byBody) };
    const forecast = new ConfigurationsForecast(configurations, targets.soleBody);
    forecast.applyTable(byBody, {}, [], [active], null);
    return {
      key,
      value: null,
      spec: ParamValueWrite.spec(file, { configurationEdit: edit }),
      configurations: forecast.summary(active, false),
    };
  }

  /** An apply-feature spec carrying one side-channel edit to `filePath`. */
  private static spec(
    filePath: string,
    edit: Pick<ApplyFeatureEditSpec, 'paramEdit' | 'configurationEdit'>,
  ): ApplyFeatureEditSpec {
    return {
      feature: 'sketch',
      filePath: filePath.replace(/^virtual:live-render:/, ''),
      producers: [],
      parts: [],
      imports: [],
      ...edit,
    };
  }
}

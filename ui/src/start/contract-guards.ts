/**
 * Runtime checks for every reply the start screen's host sends back.
 *
 * TypeScript types stop at the preload: what arrives over the bridge is
 * whatever the shell sent. These guards check each payload once, on the way
 * in, and hand back a copy holding only the fields the page reads. A reply of
 * the wrong shape throws a {@link ContractError} naming the field, and the page
 * shows one plain error instead of rendering from a payload it misread.
 *
 * No DOM here: `shell/tests/start-contract.test.ts` runs the shell's real
 * payloads through these same functions under Node.
 */

import type {
  Appearance,
  ApplyPinResult,
  EngineChoice,
  EngineOptions,
  FeedNotification,
  FeedTutorial,
  HelloReply,
  ModelDiff,
  OpeningProject,
  OpeningStatus,
  StartFeed,
  StartProject,
  StartProjectList,
  UpgradeDiff,
  UpgradePreview,
  UpgradeProgress,
  WindowState,
} from './host';

/** A reply from the host that does not have the shape this page was built against. */
export class ContractError extends Error {
  constructor(
    readonly where: string,
    readonly expected: string,
  ) {
    super(`${where}: expected ${expected}`);
    this.name = 'ContractError';
  }
}

type Guard<T> = (value: unknown, where: string) => T;

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

const string: Guard<string> = (value, where) => {
  if (typeof value !== 'string') {
    throw new ContractError(where, 'a string');
  }
  return value;
};

const boolean: Guard<boolean> = (value, where) => {
  if (typeof value !== 'boolean') {
    throw new ContractError(where, 'a boolean');
  }
  return value;
};

const number: Guard<number> = (value, where) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ContractError(where, 'a finite number');
  }
  return value;
};

function nullable<T>(guard: Guard<T>): Guard<T | null> {
  return (value, where) => (value === null ? null : guard(value, where));
}

function optional<T>(guard: Guard<T>): Guard<T | undefined> {
  return (value, where) => (value === undefined ? undefined : guard(value, where));
}

function oneOf<T extends string>(...values: T[]): Guard<T> {
  return (value, where) => {
    if (typeof value !== 'string' || !(values as string[]).includes(value)) {
      throw new ContractError(where, `one of ${values.map((v) => `'${v}'`).join(', ')}`);
    }
    return value as T;
  };
}

function arrayOf<T>(guard: Guard<T>): Guard<T[]> {
  return (value, where) => {
    if (!Array.isArray(value)) {
      throw new ContractError(where, 'an array');
    }
    return value.map((item, index) => guard(item, `${where}[${index}]`));
  };
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContractError(where, 'an object');
  }
  return value as Record<string, unknown>;
}

/** An object with exactly these fields checked, and only these copied. */
function object<T>(shape: { [K in keyof T]-?: Guard<T[K]> }): Guard<T> {
  return (value, where) => {
    const source = record(value, where);
    const checked = {} as T;
    for (const key of Object.keys(shape) as (keyof T & string)[]) {
      checked[key] = shape[key](source[key], `${where}.${key}`);
    }
    return checked;
  };
}

// ---------------------------------------------------------------------------
// The contract's shapes
// ---------------------------------------------------------------------------

const hello = object<HelloReply>({ ok: boolean, appVersion: string, platform: string, home: string });

const openingProject = object<OpeningProject>({ path: string, name: string });

const openingStatus: Guard<OpeningStatus> = (value, where) => {
  const step = oneOf('resolving', 'downloading', 'starting')(record(value, where).step, `${where}.step`);
  switch (step) {
    case 'resolving':
      return object<{ step: 'resolving' }>({ step: oneOf('resolving') })(value, where);
    case 'downloading':
      return object<Extract<OpeningStatus, { step: 'downloading' }>>({
        step: oneOf('downloading'),
        version: string,
        receivedBytes: number,
        totalBytes: nullable(number),
      })(value, where);
    case 'starting':
      return object<Extract<OpeningStatus, { step: 'starting' }>>({
        step: oneOf('starting'),
        version: string,
        source: oneOf('project', 'cache', 'builtin', 'downloaded'),
      })(value, where);
  }
};

const windowState: Guard<WindowState> = (value, where) => {
  const phase = oneOf('home', 'opening', 'failed')(record(value, where).phase, `${where}.phase`);
  switch (phase) {
    case 'home':
      return object<{ phase: 'home' }>({ phase: oneOf('home') })(value, where);
    case 'opening':
      return object<Extract<WindowState, { phase: 'opening' }>>({
        phase: oneOf('opening'),
        project: openingProject,
        status: openingStatus,
      })(value, where);
    case 'failed':
      return object<Extract<WindowState, { phase: 'failed' }>>({
        phase: oneOf('failed'),
        project: openingProject,
        message: string,
      })(value, where);
  }
};

const appearance = object<Appearance>({ theme: string });

const startProject = object<StartProject>({
  path: string,
  name: string,
  engine: nullable(string),
  engineSource: nullable(oneOf('pin', 'own')),
  latest: boolean,
  upgradeTo: nullable(string),
  lastOpenedAt: string,
  open: boolean,
  thumbnail: nullable(string),
});

const projectList = object<StartProjectList>({ projects: arrayOf(startProject) });

const feedTutorial = object<FeedTutorial>({
  id: string,
  title: string,
  description: string,
  url: string,
  thumbnail: string,
});

const feedNotification = object<FeedNotification>({
  id: string,
  body: string,
  expiresAt: nullable(string),
  minVersion: nullable(string),
});

const feed = object<StartFeed>({ tutorials: arrayOf(feedTutorial), notifications: arrayOf(feedNotification) });

const engineChoice = object<EngineChoice>({ version: string, builtin: boolean, installed: boolean });

const engineOptions = object<EngineOptions>({
  current: nullable(string),
  currentSource: nullable(oneOf('pin', 'own')),
  latest: nullable(string),
  choices: arrayOf(engineChoice),
});

const modelDiff = object<ModelDiff>({
  file: string,
  status: oneOf('identical', 'changed', 'broken', 'fixed'),
  notes: arrayOf(string),
});

const upgradeDiff = object<UpgradeDiff>({
  from: string,
  to: string,
  models: arrayOf(modelDiff),
  skipped: arrayOf(string),
  identical: boolean,
});

const upgradePreview = object<UpgradePreview>({ diff: optional(upgradeDiff), error: optional(string) });

const applyPinResult = object<ApplyPinResult>({ ok: boolean, error: optional(string) });

const upgradeProgress = object<UpgradeProgress>({ workspacePath: string, message: string });

// ---------------------------------------------------------------------------
// One entry point per reply, named after the call it checks
// ---------------------------------------------------------------------------

export const checkHello = (value: unknown): HelloReply => hello(value, 'hello()');
export const checkWindowState = (value: unknown): WindowState => windowState(value, 'windowState()');
export const checkAppearance = (value: unknown): Appearance => appearance(value, 'appearance()');
export const checkProjectList = (value: unknown): StartProjectList => projectList(value, 'list()');
export const checkFeed = (value: unknown): StartFeed => feed(value, 'feed()');
export const checkEngineOptions = (value: unknown): EngineOptions => engineOptions(value, 'engineOptions()');
export const checkUpgradePreview = (value: unknown): UpgradePreview => upgradePreview(value, 'previewUpgrade()');
export const checkApplyPinResult = (value: unknown): ApplyPinResult => applyPinResult(value, 'applyPin()');
export const checkUpgradeProgress = (value: unknown): UpgradeProgress => upgradeProgress(value, 'onUpgradeProgress()');

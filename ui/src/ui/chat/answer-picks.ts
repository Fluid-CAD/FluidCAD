// Answering a question by picking in the viewport (docs/agent-chat-plan.md
// §27): who the idle selection belongs to while a question card picks.
//
// The picking is the composer's (§11.1): the idle selection, synthesized by
// `SceneReferences` into a selector with its chips. A pick question holds a
// `SceneReferences` of its own and is *armed* from its "Pick in the
// viewport" button; while one is armed the selection is its, and the
// composer's own references stand back, so a face clicked for a question is
// not also attached to the next message.

import type { QuestionPick } from './chat-types';
import {
  SceneReferences,
  type ChatSceneHost,
  type ReferencePick,
  type ReferenceTokenTarget,
  type SceneReferencesOptions,
} from './scene-references';

/** What the page tells a card that asks for a pick when it has no scene to pick from. */
export const NO_SCENE_REASON = 'Picking in the viewport is not available here.';

/** What a question card needs to take picks (the panel's {@link AnswerPicks}). */
export type PickTaker = {
  /** Why nothing can be picked from the model on screen right now; null when it can. */
  unavailable(): string | null;
  /**
   * The references of one pick question: a `SceneReferences` over the page's
   * scene, idle until armed. Null without a scene. `reserved`: the numbers
   * the card's other questions hold, so every chip of a card has its own.
   */
  references(question: QuestionPick, tokens: ReferenceTokenTarget, hooks: PickHooks): SceneReferences | null;
  /** The selection is `owner`'s from now on; whoever had it is told to let go. */
  arm(owner: PickOwner): void;
  /** `owner` lets go of the selection (no-op when it is not the one armed). */
  disarm(owner: PickOwner): void;
  isArmed(owner: PickOwner): boolean;
};

/** What a question's references tell and ask its card. */
export type PickHooks = { onChange(): void; reserved(): readonly number[] };

/** One armed pick: told when another takes the selection, or the panel closes. */
export type PickOwner = { released(): void };

/**
 * The panel's side of picked answers: hands question cards their
 * references, keeps at most one of them armed, and says through
 * `onArmedChange` when the composer's own references must stand back.
 */
export class AnswerPicks implements PickTaker {
  private owner: PickOwner | null = null;

  constructor(
    private readonly host: ChatSceneHost | null,
    private readonly onArmedChange: () => void,
  ) {}

  /** Whether a question card holds the selection. */
  get armed(): boolean {
    return this.owner !== null;
  }

  unavailable(): string | null {
    if (!this.host) {
      return NO_SCENE_REASON;
    }
    return this.host.unpickable?.() ?? null;
  }

  references(question: QuestionPick, tokens: ReferenceTokenTarget, hooks: PickHooks): SceneReferences | null {
    return this.host ? new SceneReferences(this.host, tokens, pickOptions(question, hooks)) : null;
  }

  arm(owner: PickOwner): void {
    if (this.owner === owner) {
      return;
    }
    const previous = this.owner;
    this.owner = owner;
    previous?.released();
    // What was selected before the question was armed is not an answer to it.
    this.host?.clearSelection();
    this.onArmedChange();
  }

  disarm(owner: PickOwner): void {
    if (this.owner !== owner) {
      return;
    }
    this.owner = null;
    this.onArmedChange();
  }

  isArmed(owner: PickOwner): boolean {
    return this.owner === owner;
  }

  /** The panel closed, or another chat came on screen: nobody picks any more. */
  release(): void {
    const owner = this.owner;
    if (!owner) {
      return;
    }
    this.owner = null;
    owner.released();
    this.onArmedChange();
  }
}

/** "a face", "an edge", "a face or an edge". */
export function pickNoun(kind: QuestionPick['kind'], plural = false): string {
  if (kind === 'any') {
    return plural ? 'faces or edges' : 'a face or an edge';
  }
  return plural ? `${kind}s` : kind === 'edge' ? 'an edge' : 'a face';
}

/** What the card says while a question is armed. */
export function pickPrompt(question: QuestionPick): string {
  return question.multiple
    ? `Click ${pickNoun(question.kind, true)} in the viewport. Ctrl-click adds to the pick.`
    : `Click ${pickNoun(question.kind)} in the viewport.`;
}

/**
 * Why a selection does not answer `question`: the wrong kind of entity, or
 * several for a question that takes one. Null when it does. The engine
 * checks the same when the answer is posted.
 */
export function pickRefusal(question: QuestionPick, picks: readonly ReferencePick[]): string | null {
  if (question.kind !== 'any' && picks.some((pick) => pick.kind !== question.kind)) {
    return `This question takes ${pickNoun(question.kind, true)} only.`;
  }
  if (!question.multiple && picks.length > 1) {
    return `This question takes one ${question.kind === 'any' ? 'face or edge' : question.kind}.`;
  }
  return null;
}

function pickOptions(question: QuestionPick, hooks: PickHooks): SceneReferencesOptions {
  return {
    accept: (picks) => pickRefusal(question, picks),
    single: !question.multiple,
    onChange: hooks.onChange,
    reserved: hooks.reserved,
  };
}

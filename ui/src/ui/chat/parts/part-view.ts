import type { Colorizer } from '../code-block';
import type { ApprovalDecision, ChatPart, ParamKeptValue, QuestionReply, VariantsReply } from '../chat-types';
import type { ParamCardHost } from './params-part';
import type { PickTaker } from '../answer-picks';
import type { Pointer } from '../pointing';

/** What a part's view needs from the page. */
export type PartContext = {
  /** Open an http(s) link in the user's browser (ExternalLinks). */
  openLink(url: string): void;
  /** Colours closed code blocks; null leaves them plain. */
  colorizer(): Colorizer | null;
  /** The URL of an image under the session's `files/`. */
  fileUrl(name: string): string;
  /** Show a source location in the editor (a render error's line); absent without one. */
  openSource?(filePath: string, line: number, column: number): void;
  /** Settings → Agent, where "Always" for installs is turned off; absent where the page has no Settings. */
  openAgentSettings?(): void;
  /**
   * Answer a tool call waiting for approval; resolves true once the engine
   * took it (the card then changes through the part's next update). Absent:
   * the card only says it waits.
   */
  decideApproval?(approvalId: string, decision: ApprovalDecision): Promise<boolean>;
  /**
   * Answer (or skip) a question the agent asked; resolves true once the
   * engine took it (the card then changes through the part's next update).
   * Absent: the card only says it waits.
   */
  answerQuestion?(questionId: string, reply: QuestionReply): Promise<boolean>;
  /**
   * Takes the viewport selection for a question answered by picking (§27).
   * Absent: such a question says it cannot be picked here, and is answered
   * in words.
   */
  picks?: PickTaker;
  /**
   * Draws what a `show_user` card points at in the viewport, one card at a
   * time, and says how its items stand against the model on screen (§27).
   * Absent: a card lists its items, with nothing to show them in.
   */
  pointer?: Pointer;
  /**
   * Reply to a variants card (a pick, the user's own words, a skip);
   * resolves true once the engine took it (the card then changes through
   * the part's next update). Absent: the card only says it waits.
   */
  chooseVariant?(variantsId: string, reply: VariantsReply): Promise<boolean>;
  /**
   * Draws the picture of a variant's scratch build: a PNG data URL, or null
   * when it can no longer be drawn (the engine let the build go). Absent:
   * a tile shows only the picture the session kept.
   */
  variantPicture?(buildId: string): Promise<string | null>;
  /** Hands the picture drawn for a tile to the engine, which keeps it with the session. */
  saveVariantPicture?(variantsId: string, label: string, dataUrl: string): void;
  /**
   * Shows a scratch build over the model in the viewport, as a translucent
   * ghost — a variant, or the file with a change waiting for approval;
   * resolves false when it cannot. Absent: no "Show in viewport".
   */
  showVariantGhost?(buildId: string): Promise<boolean>;
  /** Takes the ghost out of the viewport. */
  hideVariantGhost?(): void;
  /**
   * Asks the engine to build the preview an approval card offers instead of
   * building it unasked (§25); resolves true once the engine took it (the
   * card then changes through the part's next update). Absent: the card
   * only says the change was not previewed.
   */
  requestPreview?(approvalId: string): Promise<boolean>;
  /**
   * Draws several scratch builds from one camera, framed on what they draw
   * together — the two sides of a change: a PNG data URL each, in order,
   * null for one that can no longer be drawn. Absent: the card shows only
   * the pictures the session kept.
   */
  buildPictures?(buildIds: string[]): Promise<(string | null)[]>;
  /** Hands the pictures drawn of a change's sides (PNG data URLs) to the engine, which keeps them with the session. */
  savePreviewPictures?(approvalId: string, pictures: { before?: string; after?: string }): void;
  /**
   * The model on screen as a parameter card reads and sets it (§26): its
   * parameters, their session values, Reset and Keep. Absent: a card lists
   * its parameters as they were offered, with nothing to drag.
   */
  params?: ParamCardHost;
  /**
   * Tells the engine what Keep wrote into the source from a parameter card,
   * so the card says so in every tab and the agent is told with the next
   * message; resolves true once the engine took it.
   */
  paramsKept?(paramsId: string, kept: ParamKeptValue[]): Promise<boolean>;
};

/**
 * One part of a message on screen. The transcript makes one per part when
 * it starts and hands it every later change, so a streaming part grows in
 * place instead of being rebuilt.
 */
export interface PartView {
  readonly el: HTMLElement;
  /** The part as it now stands (a `part-update`, or a fresh snapshot). */
  update(part: ChatPart): void;
  /** Text appended to a text or reasoning part (`part-delta`). */
  appendText?(delta: string): void;
  /** Nothing more streams into this part: a later part started, or the message ended. */
  settle?(): void;
  /** The view is leaving the screen (another chat, a fresh snapshot): let go of what it holds outside its element. */
  dispose?(): void;
}

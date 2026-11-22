import type { Colorizer } from '../code-block';
import type { ApprovalDecision, ChatPart, QuestionReply, VariantsReply } from '../chat-types';

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
   * Shows a variant's scratch build over the model in the viewport, as a
   * translucent ghost; resolves false when it cannot. Absent: no "Show in
   * viewport" on the tiles.
   */
  showVariantGhost?(buildId: string): Promise<boolean>;
  /** Takes the ghost out of the viewport. */
  hideVariantGhost?(): void;
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

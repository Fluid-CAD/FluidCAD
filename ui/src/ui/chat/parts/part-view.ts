import type { Colorizer } from '../code-block';
import type { ApprovalDecision, ChatPart, QuestionReply } from '../chat-types';

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
}

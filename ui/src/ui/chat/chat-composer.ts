import { ChatIcons } from './chat-icons';
import { ATTACHMENT_MEDIA_TYPES } from './chat-types';

export type ChatComposerDeps = {
  /** Send `text`; resolves true once the engine took it (the box then empties). */
  onSubmit(text: string): Promise<boolean>;
  /** Stop the running turn (the Stop button, Escape). */
  onStop(): void;
  /**
   * Files the user picked with the Attach button or pasted into the box,
   * to go with the message as images. Absent: neither is offered.
   */
  onAttach?(files: File[]): void;
};

/** The textarea's tallest, before it scrolls. */
const MAX_HEIGHT_PX = 200;

/**
 * Where the user writes (§10.3): an autosizing textarea, two lines to start,
 * and under it a row with the chat's settings chips ({@link controls}: the
 * model, the effort, the edit mode) and the Send button, which becomes Stop
 * while a turn runs. Enter sends, Shift+Enter
 * adds a line, Escape stops the turn. Typing goes on while a turn runs, for
 * the next message; Enter waits until it ends.
 *
 * The textarea carries `data-chat-composer`: the page's shortcuts (Ctrl+B,
 * the bare letters) leave it alone (`editable-target.ts`).
 *
 * `attachments` (`data-ref="attachments"`, above the textarea) holds the
 * scene references (§11.1: the selection's live chip and the kept ones),
 * whose labels put their `[n]` in the text through {@link insertToken}, and
 * the images attached to the message. An image is attached with the Attach
 * button left of the chips (a file picker) or by pasting one into the box;
 * with one attached, the message can go without words
 * ({@link setSendsWithoutText}).
 */
export class ChatComposer {
  readonly el: HTMLDivElement;
  readonly textarea: HTMLTextAreaElement;
  /** Above the textarea: the reference chips and the attached images ({@link setAttachments}). */
  readonly attachments: HTMLDivElement;
  /** Under the textarea, left of Send: the chips the panel puts there (model, effort, edit mode). */
  readonly controls: HTMLDivElement;
  private readonly button: HTMLButtonElement;
  /** Attach an image; null when the composer attaches none. */
  private readonly attachButton: HTMLButtonElement | null = null;
  private busy = false;
  private enabled = true;
  private submitting = false;
  /** Something is attached that can go without words (an image). */
  private sendsWithoutText = false;
  /**
   * Where the caret was when the textarea lost focus: a token put in from
   * a chip goes there (a blurred textarea's own selection does not survive
   * every repaint). Null: at the end.
   */
  private caret: { start: number; end: number } | null = null;

  constructor(private readonly deps: ChatComposerDeps) {
    this.el = document.createElement('div');
    this.el.className = 'chat-composer';
    this.el.dataset.ref = 'composer';

    this.attachments = document.createElement('div');
    this.attachments.className = 'chat-composer-attachments hidden';
    this.attachments.dataset.ref = 'attachments';

    const box = document.createElement('div');
    box.className = 'chat-composer-box';
    this.textarea = document.createElement('textarea');
    this.textarea.rows = 2;
    this.textarea.dataset.chatComposer = '';
    this.textarea.dataset.ref = 'input';
    this.textarea.className = 'chat-composer-input';
    this.textarea.placeholder = 'Ask about this model…';
    this.textarea.setAttribute('aria-label', 'Message the agent');
    this.textarea.spellcheck = true;
    this.textarea.addEventListener('input', () => {
      this.autosize();
      this.paint();
    });
    this.textarea.addEventListener('keydown', (event) => this.onKeyDown(event));
    this.textarea.addEventListener('blur', () => {
      this.caret = { start: this.textarea.selectionStart, end: this.textarea.selectionEnd };
    });
    this.textarea.addEventListener('paste', (event) => this.onPaste(event));

    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.dataset.ref = 'send';
    this.button.addEventListener('click', () => {
      if (this.busy) {
        this.deps.onStop();
      } else {
        void this.submit();
      }
    });
    this.controls = document.createElement('div');
    this.controls.className = 'chat-composer-controls';
    this.controls.dataset.ref = 'composer-controls';
    const footer = document.createElement('div');
    footer.className = 'chat-composer-footer';
    if (deps.onAttach) {
      // The picker behind the Attach button: images only, several at once.
      const picker = document.createElement('input');
      picker.type = 'file';
      picker.accept = ATTACHMENT_MEDIA_TYPES.join(',');
      picker.multiple = true;
      picker.className = 'hidden';
      picker.dataset.ref = 'attach-input';
      picker.tabIndex = -1;
      picker.addEventListener('change', () => {
        const files = [...(picker.files ?? [])];
        // Emptied, so picking the same file again is a change too.
        picker.value = '';
        if (files.length > 0) {
          deps.onAttach!(files);
          this.textarea.focus();
        }
      });
      this.attachButton = document.createElement('button');
      this.attachButton.type = 'button';
      this.attachButton.dataset.ref = 'attach';
      this.attachButton.className = 'chat-composer-attach';
      this.attachButton.title = 'Attach an image (or paste or drop one)';
      this.attachButton.setAttribute('aria-label', 'Attach an image');
      this.attachButton.innerHTML = ChatIcons.ATTACH;
      this.attachButton.addEventListener('click', () => picker.click());
      footer.append(picker, this.attachButton);
    }
    footer.append(this.controls, this.button);
    box.append(this.textarea, footer);
    // A click on the box's padding (not on a chip or the button) types.
    box.addEventListener('mousedown', (event) => {
      if (event.target === box || event.target === footer || event.target === this.controls) {
        event.preventDefault();
        this.textarea.focus();
      }
    });
    this.el.append(this.attachments, box);
    this.paint();
  }

  get value(): string {
    return this.textarea.value;
  }

  set value(text: string) {
    this.caret = null;
    this.textarea.value = text;
    this.autosize();
    this.paint();
  }

  /** A turn is running: the button stops it, Enter waits. */
  setBusy(busy: boolean): void {
    if (this.busy !== busy) {
      this.busy = busy;
      this.paint();
    }
  }

  /** Whether a message can be sent at all (the agent is ready). */
  setEnabled(enabled: boolean): void {
    if (this.enabled !== enabled) {
      this.enabled = enabled;
      this.textarea.disabled = !enabled;
      this.paint();
    }
  }

  /** Whether the message can go with no words typed: an image is attached to it. */
  setSendsWithoutText(sends: boolean): void {
    if (this.sendsWithoutText !== sends) {
      this.sendsWithoutText = sends;
      this.paint();
    }
  }

  focus(): void {
    this.textarea.focus();
  }

  /** Show `els` above the textarea (the scene references, the attached images); each hides itself when empty. */
  setAttachments(...els: HTMLElement[]): void {
    this.attachments.replaceChildren(...els);
    this.attachments.classList.toggle('hidden', els.length === 0);
  }

  /**
   * Put a reference token (`[1]`) at the caret, a space on each side unless
   * one is there, and leave the caret after it (a chip's label was clicked).
   */
  insertToken(token: string): void {
    const value = this.textarea.value;
    const focused = document.activeElement === this.textarea;
    const selection = focused
      ? { start: this.textarea.selectionStart, end: this.textarea.selectionEnd }
      : this.caret ?? { start: value.length, end: value.length };
    const start = Math.min(selection.start, value.length);
    const end = Math.max(start, Math.min(selection.end, value.length));
    const before = value.slice(0, start);
    const after = value.slice(end);
    const lead = before === '' || /\s$/.test(before) ? '' : ' ';
    const trail = /^\s/.test(after) ? '' : ' ';
    const head = `${before}${lead}${token}${trail}`;
    this.value = `${head}${after}`;
    this.textarea.setSelectionRange(head.length, head.length);
    this.caret = { start: head.length, end: head.length };
  }

  /** Send what is typed; the box empties once the engine took it. */
  async submit(): Promise<boolean> {
    const text = this.textarea.value;
    if (this.busy || !this.enabled || this.submitting || !this.hasMessage()) {
      return false;
    }
    this.submitting = true;
    this.paint();
    try {
      const sent = await this.deps.onSubmit(text);
      if (sent && this.textarea.value === text) {
        this.value = '';
      }
      return sent;
    } finally {
      this.submitting = false;
      this.paint();
    }
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      void this.submit();
      return;
    }
    if (event.key === 'Escape' && this.busy) {
      event.preventDefault();
      event.stopPropagation();
      this.deps.onStop();
    }
  }

  /**
   * An image on the clipboard (a screenshot, a copied picture) is attached.
   * A clipboard that also has text is pasted as text: a spreadsheet's cells
   * come with a picture of themselves.
   */
  private onPaste(event: ClipboardEvent): void {
    const data = event.clipboardData;
    if (!this.deps.onAttach || !data) {
      return;
    }
    const images = [...data.files].filter((file) => file.type.startsWith('image/'));
    if (images.length === 0 || data.getData('text/plain') !== '') {
      return;
    }
    event.preventDefault();
    this.deps.onAttach(images);
  }

  /** Whether there is anything to send: words, or an image without them. */
  private hasMessage(): boolean {
    return this.textarea.value.trim() !== '' || this.sendsWithoutText;
  }

  private autosize(): void {
    this.textarea.style.height = 'auto';
    const height = Math.min(this.textarea.scrollHeight, MAX_HEIGHT_PX);
    if (height > 0) {
      this.textarea.style.height = `${height}px`;
    }
    this.textarea.style.overflowY = this.textarea.scrollHeight > MAX_HEIGHT_PX ? 'auto' : 'hidden';
  }

  private paint(): void {
    const stop = this.busy;
    this.button.className = stop
      ? 'btn btn-sm btn-square btn-neutral chat-composer-button [&>svg]:size-4'
      : 'btn btn-sm btn-square btn-primary chat-composer-button [&>svg]:size-4';
    this.button.innerHTML = stop ? ChatIcons.STOP : ChatIcons.SEND;
    this.button.title = stop ? 'Stop (Esc)' : 'Send (Enter)';
    this.button.setAttribute('aria-label', stop ? 'Stop the agent' : 'Send');
    this.button.dataset.action = stop ? 'stop' : 'send';
    this.button.disabled = !stop && (!this.enabled || this.submitting || !this.hasMessage());
    if (this.attachButton) {
      this.attachButton.disabled = !this.enabled;
    }
  }
}

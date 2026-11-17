import { ChatIcons } from './chat-icons';

export type ChatComposerDeps = {
  /** Send `text`; resolves true once the engine took it (the box then empties). */
  onSubmit(text: string): Promise<boolean>;
  /** Stop the running turn (the Stop button, Escape). */
  onStop(): void;
};

/** The textarea's tallest, before it scrolls. */
const MAX_HEIGHT_PX = 200;

/**
 * Where the user writes (§10.3): an autosizing textarea and the Send
 * button, which becomes Stop while a turn runs. Enter sends, Shift+Enter
 * adds a line, Escape stops the turn. Typing goes on while a turn runs, for
 * the next message; Enter waits until it ends.
 *
 * The textarea carries `data-chat-composer`: the page's shortcuts (Ctrl+B,
 * the bare letters) leave it alone (`editable-target.ts`).
 *
 * **Phase 6 plugs in here:** `attachments` (`data-ref="attachments"`, above
 * the textarea) holds the reference chips and the add-selection row.
 */
export class ChatComposer {
  readonly el: HTMLDivElement;
  readonly textarea: HTMLTextAreaElement;
  /** Above the textarea: phase 6's reference chips and add-selection row. */
  readonly attachments: HTMLDivElement;
  private readonly button: HTMLButtonElement;
  private busy = false;
  private enabled = true;
  private submitting = false;

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
    this.textarea.rows = 1;
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
    box.append(this.textarea, this.button);
    this.el.append(this.attachments, box);
    this.paint();
  }

  get value(): string {
    return this.textarea.value;
  }

  set value(text: string) {
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

  focus(): void {
    this.textarea.focus();
  }

  /** Send what is typed; the box empties once the engine took it. */
  async submit(): Promise<boolean> {
    const text = this.textarea.value;
    if (this.busy || !this.enabled || this.submitting || text.trim() === '') {
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
    this.button.disabled = !stop && (!this.enabled || this.submitting || this.textarea.value.trim() === '');
  }
}

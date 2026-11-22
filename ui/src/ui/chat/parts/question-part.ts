import { ChatIcons } from '../chat-icons';
import { MAX_ANSWER_CHARS, type ChatPart, type QuestionAnswer, type QuestionItem, type QuestionOption, type QuestionPart, type QuestionReply } from '../chat-types';
import type { PartContext, PartView } from './part-view';

/** What the user has picked and written for one question, before it is sent. */
type Draft = { selected: Set<string>; text: string };

/**
 * What the agent asked through `ask_user` (docs/agent-chat-plan.md §22), as
 * one card: every question of the call with its options, a field for an
 * answer in the user's own words, and Skip and Send under them.
 *
 * An option is a toggle button: a second click takes the pick back, and a
 * question that takes one option moves the pick. Send needs one question
 * answered; the ones left open are told to the agent as skipped. Enter in a
 * field sends.
 *
 * A question and an option may carry a drawing (`svg`). A question's is a
 * figure under its words; options with drawings lay out as tiles, the
 * drawing above the label.
 *
 * The state comes from the part, so a reloaded page or a second tab shows
 * the same card; the first answer wins and the others are refused by the
 * engine. Once settled the card keeps the questions with what was answered
 * (or that it was skipped, or why nobody answered) and nothing to click.
 */
export class QuestionPartView implements PartView {
  readonly el: HTMLDivElement;
  private part: QuestionPart;
  private drafts: Draft[];
  /** The reply this card sent and the engine has not settled yet (its controls wait). */
  private sending: 'answer' | 'skip' | null = null;
  private sendButton: HTMLButtonElement | null = null;
  private skipButton: HTMLButtonElement | null = null;

  constructor(part: QuestionPart, private readonly ctx: PartContext) {
    this.part = part;
    this.drafts = part.questions.map(() => ({ selected: new Set<string>(), text: '' }));
    this.el = document.createElement('div');
    this.el.className = 'chat-question';
    this.el.dataset.part = 'question';
    this.paint();
  }

  update(part: ChatPart): void {
    if (part.type !== 'question') {
      return;
    }
    const waited = this.part.state === 'awaiting-answer';
    this.part = part;
    // Still waiting: what the user picked and typed stays as it is.
    if (waited && part.state === 'awaiting-answer') {
      return;
    }
    this.sending = null;
    this.paint();
  }

  private paint(): void {
    const part = this.part;
    this.el.dataset.state = part.state;
    this.el.replaceChildren();
    this.sendButton = null;
    this.skipButton = null;
    if (part.state === 'awaiting-answer') {
      this.paintForm();
    } else {
      this.paintSettled();
    }
  }

  // --- Waiting --------------------------------------------------------------

  private paintForm(): void {
    const canAnswer = !!this.ctx.answerQuestion;
    this.part.questions.forEach((question, index) => {
      const item = questionBlock(question, index);
      if (question.options && question.options.length > 0) {
        if (question.multiSelect) {
          const hint = document.createElement('div');
          hint.className = 'chat-question-hint';
          hint.textContent = 'Pick any that apply.';
          item.append(hint);
        }
        const options = document.createElement('div');
        options.className = 'chat-question-options';
        options.setAttribute('role', 'group');
        options.setAttribute('aria-label', question.question);
        options.dataset.drawn = String(question.options.some((option) => !!option.svg));
        for (const option of question.options) {
          options.append(this.optionButton(index, question, option, canAnswer));
        }
        item.append(options);
      }
      if (canAnswer) {
        item.append(this.textField(index, question));
      }
      this.el.append(item);
    });

    const actions = document.createElement('div');
    actions.className = 'chat-question-actions';
    const waiting = document.createElement('span');
    waiting.className = 'chat-question-waiting';
    waiting.append(ChatIcons.span(ChatIcons.WAITING, '[&>svg]:size-3.5'), text('The agent is waiting for your answer'));
    actions.append(waiting);
    if (canAnswer) {
      const buttons = document.createElement('div');
      buttons.className = 'chat-question-buttons';
      this.skipButton = actionButton('question-skip', 'Skip', 'btn-ghost chat-approval-secondary');
      this.skipButton.title = 'Let the agent decide';
      this.skipButton.addEventListener('click', () => void this.send('skip'));
      this.sendButton = actionButton('question-send', 'Send', 'btn-primary');
      this.sendButton.addEventListener('click', () => void this.send('answer'));
      buttons.append(this.skipButton, this.sendButton);
      actions.append(buttons);
    }
    this.el.append(actions);
    this.paintActions();
  }

  private optionButton(index: number, question: QuestionItem, option: QuestionOption, enabled: boolean): HTMLButtonElement {
    const { label, description } = option;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chat-question-option';
    button.dataset.ref = 'option';
    button.dataset.label = label;
    button.dataset.multi = String(!!question.multiSelect);
    button.disabled = !enabled;
    button.setAttribute('aria-pressed', String(this.drafts[index].selected.has(label)));
    const mark = document.createElement('span');
    mark.className = 'chat-question-mark';
    mark.append(ChatIcons.span(ChatIcons.CHECK, '[&>svg]:size-3'));
    const words = document.createElement('span');
    words.className = 'chat-question-option-words';
    const name = document.createElement('span');
    name.className = 'chat-question-label';
    name.textContent = label;
    words.append(name);
    if (description) {
      const more = document.createElement('span');
      more.className = 'chat-question-description';
      more.textContent = description;
      words.append(more);
    }
    if (option.svg) {
      button.append(drawing(option.svg, 'option-drawing'));
    }
    button.append(mark, words);
    button.addEventListener('click', () => this.toggle(index, question, label));
    return button;
  }

  private textField(index: number, question: QuestionItem): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'chat-question-input';
    input.dataset.ref = 'text';
    input.maxLength = MAX_ANSWER_CHARS;
    input.autocomplete = 'off';
    input.spellcheck = true;
    const hasOptions = !!question.options && question.options.length > 0;
    input.placeholder = hasOptions ? 'Or in your own words…' : 'Your answer…';
    input.setAttribute('aria-label', hasOptions ? `Your own answer to: ${question.question}` : question.question);
    input.value = this.drafts[index].text;
    input.addEventListener('input', () => {
      this.drafts[index].text = input.value;
      this.paintActions();
    });
    input.addEventListener('keydown', (event) => {
      // Enter sends; while an IME composes, Enter belongs to it.
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        void this.send('answer');
      }
    });
    return input;
  }

  private toggle(index: number, question: QuestionItem, label: string): void {
    if (this.sending !== null || this.part.state !== 'awaiting-answer') {
      return;
    }
    const selected = this.drafts[index].selected;
    if (selected.has(label)) {
      selected.delete(label);
    } else {
      if (!question.multiSelect) {
        selected.clear();
      }
      selected.add(label);
    }
    const item = this.el.querySelector(`[data-ref="question"][data-index="${index}"]`);
    for (const button of item?.querySelectorAll<HTMLButtonElement>('[data-ref="option"]') ?? []) {
      button.setAttribute('aria-pressed', String(selected.has(button.dataset.label ?? '')));
    }
    this.paintActions();
  }

  /** The answers as they would be sent: one per question, in order. */
  private answers(): QuestionAnswer[] {
    return this.part.questions.map((question, index) => {
      const draft = this.drafts[index];
      // In the options' own order, whatever order they were clicked in.
      const selected = (question.options ?? []).map((o) => o.label).filter((label) => draft.selected.has(label));
      const written = draft.text.trim();
      return { selected, ...(written ? { text: written } : {}) };
    });
  }

  private paintActions(): void {
    const busy = this.sending !== null;
    const answered = this.answers().some((a) => a.selected.length > 0 || !!a.text);
    if (this.sendButton) {
      this.sendButton.disabled = busy || !answered;
      spin(this.sendButton, this.sending === 'answer', 'Send');
    }
    if (this.skipButton) {
      this.skipButton.disabled = busy;
      spin(this.skipButton, this.sending === 'skip', 'Skip');
    }
    for (const control of this.el.querySelectorAll<HTMLButtonElement | HTMLInputElement>('[data-ref="option"], [data-ref="text"]')) {
      control.disabled = busy || !this.ctx.answerQuestion;
    }
  }

  private async send(kind: 'answer' | 'skip'): Promise<void> {
    const part = this.part;
    if (this.sending !== null || !this.ctx.answerQuestion || part.state !== 'awaiting-answer') {
      return;
    }
    let reply: QuestionReply = { skip: true };
    if (kind === 'answer') {
      const answers = this.answers();
      if (!answers.some((a) => a.selected.length > 0 || !!a.text)) {
        return;
      }
      reply = { answers };
    }
    this.sending = kind;
    this.paintActions();
    const ok = await this.ctx.answerQuestion(part.id, reply);
    // Taken: the part's update settles the card. Refused while it still waits: answer again.
    if (!ok && this.part.state === 'awaiting-answer' && this.part.id === part.id) {
      this.sending = null;
      this.paintActions();
    }
  }

  // --- Settled --------------------------------------------------------------

  private paintSettled(): void {
    const part = this.part;
    part.questions.forEach((question, index) => {
      const item = questionBlock(question, index);
      if (part.state === 'answered') {
        item.append(answerLine(part.answers?.[index]));
      }
      this.el.append(item);
    });
    if (part.state === 'skipped') {
      this.el.append(outcomeLine(ChatIcons.DENIED, 'You skipped this; the agent decides.'));
    } else if (part.state === 'unanswered') {
      this.el.append(outcomeLine(ChatIcons.DENIED, part.reason ?? 'Not answered.'));
    }
  }
}

function questionBlock(question: QuestionItem, index: number): HTMLDivElement {
  const item = document.createElement('div');
  item.className = 'chat-question-item';
  item.dataset.ref = 'question';
  item.dataset.index = String(index);
  const words = document.createElement('div');
  words.className = 'chat-question-text';
  words.dataset.ref = 'question-text';
  words.textContent = question.question;
  item.append(words);
  if (question.svg) {
    item.append(drawing(question.svg, 'question-drawing'));
  }
  return item;
}

/**
 * A drawing the model wrote, as an image. The markup is untrusted and never
 * enters the page's DOM: an `<img>` runs no script in it and loads nothing it
 * refers to. Decorative (the words beside it say the same), and one the
 * browser cannot read takes itself out.
 */
function drawing(svg: string, ref: string): HTMLElement {
  const figure = document.createElement('span');
  figure.className = 'chat-question-drawing';
  figure.dataset.ref = ref;
  const image = document.createElement('img');
  image.alt = '';
  image.decoding = 'async';
  image.draggable = false;
  image.addEventListener('error', () => figure.remove());
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  figure.append(image);
  return figure;
}

/** What the user answered to one question: the options picked, then their own words; "Left open" for neither. */
function answerLine(answer: QuestionAnswer | undefined): HTMLElement {
  const line = document.createElement('div');
  line.className = 'chat-question-answer';
  line.dataset.ref = 'answer';
  const selected = answer?.selected ?? [];
  const written = answer?.text ?? '';
  if (selected.length === 0 && !written) {
    line.dataset.open = 'true';
    line.textContent = 'Left open';
    return line;
  }
  line.append(ChatIcons.span(ChatIcons.CHECK, '[&>svg]:size-3.5 mt-px'));
  const words = document.createElement('span');
  words.className = 'min-w-0 break-words whitespace-pre-wrap';
  words.textContent = [selected.join(', '), written].filter((piece) => piece !== '').join(' — ');
  line.append(words);
  return line;
}

function outcomeLine(icon: string, words: string): HTMLElement {
  const line = document.createElement('div');
  line.className = 'chat-question-outcome';
  line.dataset.ref = 'outcome';
  line.append(ChatIcons.span(icon, '[&>svg]:size-3.5'), text(words));
  return line;
}

function actionButton(ref: string, label: string, variant: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.ref = ref;
  button.className = `btn btn-xs ${variant}`;
  button.textContent = label;
  return button;
}

/** The button's label, behind a spinner while its reply is on the way. */
function spin(button: HTMLButtonElement, on: boolean, label: string): void {
  button.replaceChildren();
  if (on) {
    const spinner = document.createElement('span');
    spinner.className = 'loading loading-spinner loading-xs';
    button.append(spinner);
  }
  button.append(text(label));
}

function text(value: string): Text {
  return document.createTextNode(value);
}

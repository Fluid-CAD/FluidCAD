import { NO_SCENE_REASON, pickNoun, pickPrompt, type PickOwner } from '../answer-picks';
import { ChatIcons } from '../chat-icons';
import { MAX_ANSWER_CHARS, type ChatPart, type QuestionAnswer, type QuestionItem, type QuestionOption, type QuestionPart, type QuestionReply } from '../chat-types';
import type { SceneReferences } from '../scene-references';
import type { PartContext, PartView } from './part-view';
import { referenceChip } from './references-part';

/** What the user has picked and written for one question, before it is sent. */
type Draft = { selected: Set<string>; text: string };

/**
 * A pick question's side of the card while it waits: its references (the
 * composer's own picking, on this card), the handle it holds the viewport
 * selection with while armed, and its controls.
 */
type PickSlot = {
  refs: SceneReferences;
  owner: PickOwner;
  button: HTMLButtonElement;
  prompt: HTMLSpanElement;
  unavailable: HTMLDivElement;
};

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
 * A question may ask for a pick instead of offering options (§27): "Pick in
 * the viewport" arms the composer's own picking for it, and what is clicked
 * shows under the question as reference chips, removable until the answer is
 * sent. One question is armed at a time; Done, Send, Skip and the card's
 * end disarm it. When the model on screen cannot be picked from (an
 * assembly, no model), the card says so in place of the button, and the
 * question is answered in words or skipped like any other.
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
  /** One per question; null for a question that takes no pick, or once the card is settled. */
  private slots: (PickSlot | null)[] = [];
  /** A Send waiting for a click to resolve. */
  private settling: Promise<void> | null = null;

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

  dispose(): void {
    this.releaseSlots();
  }

  private paint(): void {
    const part = this.part;
    this.el.dataset.state = part.state;
    this.releaseSlots();
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
      const field = canAnswer ? this.textField(index, question) : null;
      if (question.pick) {
        this.paintPick(item, index, question, field);
      }
      if (field) {
        item.append(field);
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
    const hasOptions = (!!question.options && question.options.length > 0) || !!question.pick;
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

  // --- Picking (§27) ---------------------------------------------------------

  /**
   * The pick controls of question `index`: the button that arms it, what to
   * click while it is armed, the chips of what was picked, or why the model
   * on screen cannot be picked from. `field` is the question's own-words
   * field: a chip's label puts its `[n]` there.
   */
  private paintPick(item: HTMLElement, index: number, question: QuestionItem, field: HTMLInputElement | null): void {
    const pick = question.pick!;
    const row = document.createElement('div');
    row.className = 'chat-question-pick';
    row.dataset.ref = 'pick';
    const unavailable = document.createElement('div');
    unavailable.className = 'chat-question-pick-unavailable hidden';
    unavailable.dataset.ref = 'pick-unavailable';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chat-question-pick-button';
    button.dataset.ref = 'pick-button';
    button.setAttribute('aria-pressed', 'false');
    button.title = `Answer by clicking ${pickNoun(pick.kind, !!pick.multiple)} of the model`;
    const prompt = document.createElement('span');
    prompt.className = 'chat-question-pick-prompt hidden';
    prompt.dataset.ref = 'pick-prompt';
    prompt.textContent = pickPrompt(pick);
    row.append(button, prompt);
    item.append(row, unavailable);

    const taker = this.ctx.picks;
    const refs = taker && field
      ? taker.references(
          pick,
          {
            insertToken: (token) => {
              const at = field.selectionStart ?? field.value.length;
              field.setRangeText(token, at, field.selectionEnd ?? at, 'end');
              field.dispatchEvent(new Event('input', { bubbles: true }));
            },
            focus: () => field.focus(),
          },
          {
            onChange: () => this.pickChanged(index),
            // Every chip of the card has its own number and colour, whichever question it answers.
            reserved: () => this.slots.flatMap((slot, other) => (slot && other !== index ? slot.refs.references.map((reference) => reference.n) : [])),
          },
        )
      : null;
    if (!refs) {
      // Nothing to pick from here, or nothing to answer with: the question is answered in words.
      row.classList.add('hidden');
      if (field) {
        unavailable.classList.remove('hidden');
        unavailable.textContent = `${taker?.unavailable() ?? NO_SCENE_REASON} Answer in words.`;
      }
      return;
    }
    refs.el.classList.add('chat-question-picks');
    item.append(refs.el);
    this.slots[index] = { refs, owner: { released: () => this.released(index) }, button, prompt, unavailable };
    button.addEventListener('click', () => void this.togglePick(index));
    this.syncPick(index);
  }

  /** "Pick in the viewport" / "Done": arm question `index`, or let go of the selection. */
  private async togglePick(index: number): Promise<void> {
    const slot = this.slots[index];
    const taker = this.ctx.picks;
    if (!slot || !taker || this.sending !== null || this.part.state !== 'awaiting-answer') {
      return;
    }
    if (taker.isArmed(slot.owner)) {
      // A click still resolving is waited for, so Done keeps it.
      await slot.refs.settle();
      this.disarm(index);
      return;
    }
    if (taker.unavailable() !== null) {
      this.syncPick(index);
      return;
    }
    taker.arm(slot.owner);
    slot.refs.setActive(true);
    this.syncPick(index);
  }

  /** Question `index` lets go of the selection; what it picked stays on the card. */
  private disarm(index: number): void {
    const slot = this.slots[index];
    const taker = this.ctx.picks;
    if (!slot || !taker?.isArmed(slot.owner)) {
      return;
    }
    this.letGo(slot);
    taker.disarm(slot.owner);
    this.syncPick(index);
  }

  /** The selection went to another question, or the panel closed. */
  private released(index: number): void {
    const slot = this.slots[index];
    if (slot) {
      this.letGo(slot);
      this.syncPick(index);
    }
  }

  /** Keep what the selection stands for as a chip of its own, clear the selection, and stop following it. */
  private letGo(slot: PickSlot): void {
    if (!slot.refs.keep()) {
      slot.refs.dismissLive();
    }
    slot.refs.setActive(false);
  }

  /** The references of question `index` changed (a pick resolved, a chip was removed, the model re-rendered). */
  private pickChanged(index: number): void {
    // The references paint once while they are being made, before the slot exists.
    if (!this.slots[index]) {
      return;
    }
    this.syncPick(index);
    this.paintActions();
  }

  private syncPick(index: number): void {
    const slot = this.slots[index];
    const taker = this.ctx.picks;
    if (!slot || !taker) {
      return;
    }
    const reason = taker.unavailable();
    if (reason !== null && taker.isArmed(slot.owner)) {
      // The model on screen changed under an armed question (an assembly was opened).
      slot.refs.setActive(false);
      taker.disarm(slot.owner);
    }
    const armed = taker.isArmed(slot.owner);
    slot.button.parentElement!.classList.toggle('hidden', reason !== null);
    slot.unavailable.classList.toggle('hidden', reason === null);
    slot.unavailable.textContent = reason === null ? '' : `${reason} Answer in words.`;
    slot.button.setAttribute('aria-pressed', String(armed));
    const label = armed ? 'Done' : slot.refs.size > 0 ? 'Pick again' : 'Pick in the viewport';
    if (slot.button.dataset.label !== label) {
      slot.button.dataset.label = label;
      slot.button.replaceChildren(ChatIcons.span(armed ? ChatIcons.CHECK : ChatIcons.PICK, '[&>svg]:size-3.5'), text(label));
    }
    slot.prompt.classList.toggle('hidden', !armed);
  }

  /** The card is settled or leaves the screen: nothing of it follows the selection any more. */
  private releaseSlots(): void {
    const taker = this.ctx.picks;
    const slots = this.slots;
    this.slots = [];
    for (const slot of slots) {
      if (!slot) {
        continue;
      }
      if (taker?.isArmed(slot.owner)) {
        slot.refs.dismissLive();
        slot.refs.setActive(false);
        taker.disarm(slot.owner);
      }
      slot.refs.destroy();
    }
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
      const picks = this.slots[index]?.refs.references ?? [];
      return { selected, ...(written ? { text: written } : {}), ...(picks.length > 0 ? { picks } : {}) };
    });
  }

  private paintActions(): void {
    const busy = this.sending !== null;
    const answered = this.answers().some(isAnswered);
    if (this.sendButton) {
      this.sendButton.disabled = busy || !answered;
      spin(this.sendButton, this.sending === 'answer', 'Send');
    }
    if (this.skipButton) {
      this.skipButton.disabled = busy;
      spin(this.skipButton, this.sending === 'skip', 'Skip');
    }
    for (const control of this.el.querySelectorAll<HTMLButtonElement | HTMLInputElement>('[data-ref="option"], [data-ref="text"], [data-ref="pick-button"]')) {
      control.disabled = busy || !this.ctx.answerQuestion;
    }
  }

  private async send(kind: 'answer' | 'skip'): Promise<void> {
    const part = this.part;
    if (this.sending !== null || !this.ctx.answerQuestion || part.state !== 'awaiting-answer') {
      return;
    }
    if (kind === 'answer' && this.slots.some((slot) => slot)) {
      // The answer carries what the chips show: a click still resolving is waited for.
      this.settling ??= Promise.all(this.slots.map((slot) => slot?.refs.settle())).then(() => undefined);
      await this.settling;
      this.settling = null;
      if (this.sending !== null || this.part !== part) {
        return;
      }
    }
    let reply: QuestionReply = { skip: true };
    if (kind === 'answer') {
      const answers = this.answers();
      if (!answers.some(isAnswered)) {
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

function isAnswered(answer: QuestionAnswer): boolean {
  return answer.selected.length > 0 || !!answer.text || (answer.picks?.length ?? 0) > 0;
}

/** What the user answered to one question: the options picked or the geometry clicked, then their own words; "Left open" for none. */
function answerLine(answer: QuestionAnswer | undefined): HTMLElement {
  const line = document.createElement('div');
  line.className = 'chat-question-answer';
  line.dataset.ref = 'answer';
  const selected = answer?.selected ?? [];
  const written = answer?.text ?? '';
  const picks = answer?.picks ?? [];
  if (selected.length === 0 && !written && picks.length === 0) {
    line.dataset.open = 'true';
    line.textContent = 'Left open';
    return line;
  }
  line.append(ChatIcons.span(ChatIcons.CHECK, '[&>svg]:size-3.5 mt-px'));
  const words = document.createElement('span');
  words.className = 'min-w-0 break-words whitespace-pre-wrap';
  if (picks.length > 0) {
    // What was picked, as the chips it was sent with.
    const chips = document.createElement('span');
    chips.className = 'chat-question-picked';
    chips.dataset.ref = 'picked';
    chips.append(...picks.map(referenceChip));
    words.append(chips);
  }
  const said = [selected.join(', '), written].filter((piece) => piece !== '').join(' — ');
  if (said) {
    words.append(text(said));
  }
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

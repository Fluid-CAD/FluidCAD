// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { NO_SCENE_REASON, pickRefusal } from '../src/ui/chat/answer-picks';
import { ChatPanel } from '../src/ui/chat/chat-panel';
import type { QuestionPart, SceneReference } from '../src/ui/chat/chat-types';
import { REFERENCE_COLORS } from '../src/ui/chat/reference-colors';
import { MODEL_CHANGED_NOTICE, RESOLVE_DEBOUNCE_MS, type ResolveSelectionAnswer } from '../src/ui/chat/scene-references';
import { LeftSlot } from '../src/ui/left-slot';
import { FakeChatClient } from './fixtures/fake-chat-client';
import { FakeScene, edges, face } from './fixtures/fake-chat-scene';
import { settle } from './fixtures/fake-packages-client';
import rimEdges from './fixtures/resolve-selection/plate-rim-edges.json';
import topFace from './fixtures/resolve-selection/plate-top-face.json';
import twoPartsRefused from './fixtures/resolve-selection/two-parts-refused.json';

// Questions answered by picking in the viewport (docs/agent-chat-plan.md
// §27): the card arms the composer's own picking for one question, shows
// what was clicked as reference chips, and sends them with the answer. The
// resolver answers from the recordings the scene references are tested with.

const MOUNT = { question: 'Which face is the mounting face?', pick: { kind: 'face' as const } };
const RIM = { question: 'Which edges get the fillet?', pick: { kind: 'edge' as const, multiple: true } };

function pickQuestion(overrides: Partial<QuestionPart> = {}): QuestionPart {
  return { type: 'question', id: 'q1', state: 'awaiting-answer', questions: [MOUNT, RIM, { question: 'How large a fillet?' }], ...overrides };
}

const panels: ChatPanel[] = [];

afterEach(() => {
  for (const panel of panels.splice(0)) {
    panel.destroy();
  }
  document.body.innerHTML = '';
});

async function mount(part: QuestionPart = pickQuestion(), scene: FakeScene | null = new FakeScene()) {
  const client = new FakeChatClient();
  client.addSession({
    id: 's',
    title: 'Bracket',
    status: part.state === 'awaiting-answer' ? { state: 'awaiting-answer', turnId: 't1', questionIds: [part.id] } : { state: 'idle' },
    messages: [
      { id: 'u1', role: 'user', turnId: 't1', createdAt: '', parts: [{ type: 'text', id: 'u1t', text: 'fillet the rim and add mounting holes' }] },
      { id: 'a1', role: 'assistant', turnId: 't1', createdAt: '', parts: [part] },
    ],
    turns: [{ id: 't1', userMessageId: 'u1', revertible: false }],
  });
  const container = document.createElement('div');
  document.body.append(container);
  const panel = new ChatPanel({
    container,
    client,
    slot: new LeftSlot({ width: 500 }),
    settings: () => ({ defaultAgent: null, permissionMode: 'ask' }),
    openExternal: () => {},
    ...(scene ? { scene } : {}),
  });
  panels.push(panel);
  panel.show();
  await settle();
  await settle();
  const card = panel.el.querySelector<HTMLElement>('[data-part="question"]')!;
  const item = (index: number) => card.querySelector<HTMLElement>(`[data-ref="question"][data-index="${index}"]`)!;
  const button = (index: number) => item(index).querySelector<HTMLButtonElement>('[data-ref="pick-button"]')!;
  /** The chips under question `index` as "colour:label", the live one marked with its state. */
  const chips = (index: number) =>
    [...item(index).querySelectorAll<HTMLElement>('[data-ref=reference-chips] .chat-reference-chip')].map((c) => {
      const label = c.querySelector('.chat-reference-label')?.textContent ?? '';
      const reason = c.querySelector('.chat-reference-reason')?.textContent;
      const live = c.dataset.ref === 'live-reference' ? `(${c.dataset.state})` : '';
      return `${c.dataset.color ?? '-'}:${label}${live}${reason ? ` — ${reason}` : ''}`;
    });
  /** The composer's own live chip, above the message box. */
  const composerChips = () => panel.el.querySelectorAll('.chat-composer-attachments [data-ref=reference-chips] .chat-reference-chip').length;
  /** Let the debounce run out and the resolver answer. */
  const resolved = async () => {
    await new Promise((r) => setTimeout(r, RESOLVE_DEBOUNCE_MS + 10));
    await settle();
  };
  const send = async () => {
    card.querySelector<HTMLButtonElement>('[data-ref="question-send"]')!.click();
    await settle();
    await settle();
  };
  const sendDisabled = () => card.querySelector<HTMLButtonElement>('[data-ref="question-send"]')!.disabled;
  return { client, panel, scene: scene!, card, item, button, chips, composerChips, resolved, send, sendDisabled };
}

describe('a question answered by picking (§27)', () => {
  it('arms the composer\'s picking for the question, shows the pick as a chip, and sends it as a scene reference', async () => {
    const h = await mount();
    expect(h.button(0).textContent!.trim()).toBe('Pick in the viewport');
    expect(h.button(0).getAttribute('aria-pressed')).toBe('false');
    expect(h.item(0).querySelector('[data-ref="pick-prompt"]')!.classList.contains('hidden')).toBe(true);
    // A question that takes no pick has no such button; every question keeps its own-words field.
    expect(h.item(2).querySelector('[data-ref="pick-button"]')).toBeNull();
    expect(h.item(0).querySelector<HTMLInputElement>('[data-ref="text"]')!.placeholder).toBe('Or in your own words…');
    expect(h.sendDisabled()).toBe(true);

    // Not armed: the selection is the composer's, as before.
    h.scene.select([face()]);
    await h.resolved();
    expect(h.composerChips()).toBe(1);
    expect(h.chips(0)).toEqual([]);

    // Armed: what was selected before is not an answer, and the composer stands back.
    h.button(0).click();
    expect(h.scene.entities).toEqual([]);
    expect(h.button(0).getAttribute('aria-pressed')).toBe('true');
    expect(h.button(0).textContent!.trim()).toBe('Done');
    expect(h.item(0).querySelector('[data-ref="pick-prompt"]')!.textContent).toBe('Click a face in the viewport.');
    expect(h.item(0).querySelector('[data-ref="pick-prompt"]')!.classList.contains('hidden')).toBe(false);

    h.scene.answers = () => ({ ok: true, answer: topFace as ResolveSelectionAnswer });
    h.scene.select([face()]);
    expect(h.chips(0)).toEqual(['red:[1] 1 face(pending)']);
    await h.resolved();
    expect(h.chips(0)).toEqual(['red:[1] 1 face(ready)']);
    expect(h.composerChips()).toBe(0);
    // One reference: no pin to keep it and select more.
    expect(h.item(0).querySelector('[data-ref=keep-reference]')).toBeNull();
    expect(h.sendDisabled()).toBe(false);

    // Done keeps the pick on the card, clears the selection and hands it back to the composer.
    h.button(0).click();
    await settle();
    expect(h.button(0).getAttribute('aria-pressed')).toBe('false');
    expect(h.button(0).textContent!.trim()).toBe('Pick again');
    expect(h.chips(0)).toEqual(['red:[1] 1 face']);
    expect(h.scene.entities).toEqual([]);
    h.scene.select(edges(2));
    await h.resolved();
    expect(h.composerChips()).toBe(1);
    expect(h.chips(0)).toEqual(['red:[1] 1 face']);

    await h.send();
    expect(h.client.answerQuestion).toHaveBeenCalledTimes(1);
    const reply = h.client.answerQuestion.mock.calls[0][2] as { answers: { selected: string[]; picks?: SceneReference[] }[] };
    expect(reply.answers.map((a) => a.picks?.length ?? 0)).toEqual([1, 0, 0]);
    expect(reply.answers[0].picks![0]).toMatchObject({
      n: 1,
      color: { name: 'red', hex: REFERENCE_COLORS[0].hex },
      kind: 'face',
      count: 1,
      file: '/w/plate.part.js',
      selector: { source: 'e.endFaces()' },
      unit: 'mm',
    });
    // A selector, never an address.
    expect(JSON.stringify(reply)).not.toMatch(/shapeId|sceneObjectId|\$obj|"index"/);

    // Settled: the question with what was picked, and nothing to click.
    expect(h.card.dataset.state).toBe('answered');
    const picked = h.item(0).querySelector('[data-ref="picked"] .chat-reference-chip') as HTMLElement;
    expect(picked.textContent).toBe('[1] 1 face');
    expect(picked.dataset.color).toBe('red');
    expect(picked.title).toBe('e.endFaces()');
    expect(h.card.querySelectorAll('button')).toHaveLength(0);
    expect(h.item(1).querySelector('[data-ref="answer"]')!.textContent).toBe('Left open');
  });

  it('takes one face where the question takes one: a second entity or an edge is told, and a new click replaces the pick', async () => {
    const h = await mount();
    h.button(0).click();
    h.scene.select([face(1), face(2)]);
    await h.resolved();
    expect(h.chips(0)).toEqual(['-:2 faces(hint) — This question takes one face.']);
    h.scene.select(edges(1));
    await h.resolved();
    expect(h.chips(0)).toEqual(['-:1 edge(hint) — This question takes faces only.']);
    expect(h.sendDisabled()).toBe(true);
    expect(h.scene.resolveCalls).toEqual([]);

    h.scene.answers = () => ({ ok: true, answer: topFace as ResolveSelectionAnswer });
    h.scene.select([face(1)]);
    await h.resolved();
    h.button(0).click();
    await settle();
    expect(h.chips(0)).toEqual(['red:[1] 1 face']);
    // Pick again: the next face takes the place of the one kept.
    h.button(0).click();
    h.scene.select([face(2)]);
    expect(h.chips(0)).toEqual(['red:[1] 1 face', 'red:[1] 1 face(pending)']);
    await h.resolved();
    expect(h.chips(0)).toEqual(['red:[1] 1 face(ready)']);

    expect(pickRefusal({ kind: 'any' }, [{ shapeId: 's', kind: 'face', index: 0 }, { shapeId: 's', kind: 'edge', index: 0 }])).toBe('This question takes one face or edge.');
    expect(pickRefusal({ kind: 'any', multiple: true }, [{ shapeId: 's', kind: 'face', index: 0 }, { shapeId: 's', kind: 'edge', index: 0 }])).toBeNull();
  });

  it('takes several where the question takes several: one reference for a selection, the pin for another, × to remove', async () => {
    const h = await mount();
    h.button(1).click();
    expect(h.item(1).querySelector('[data-ref="pick-prompt"]')!.textContent).toBe('Click edges in the viewport. Ctrl-click adds to the pick.');
    h.scene.select(edges(4));
    await h.resolved();
    // The whole selection is one selector, as in the composer.
    expect(h.chips(1)).toEqual(['red:[1] 4 edges(ready)']);
    h.item(1).querySelector<HTMLElement>('[data-ref=keep-reference]')!.click();
    h.scene.select(edges(1));
    await h.resolved();
    expect(h.chips(1)).toEqual(['red:[1] 4 edges', 'blue:[2] 4 edges(ready)']);
    h.item(1).querySelector<HTMLElement>('[data-ref=remove-reference]')!.click();
    expect(h.chips(1)).toEqual(['blue:[2] 4 edges(ready)']);

    // A chip's label puts its [n] in the question's own-words field.
    h.item(1).querySelector<HTMLElement>('[data-ref=reference-label]')!.click();
    expect(h.item(1).querySelector<HTMLInputElement>('[data-ref="text"]')!.value).toBe('[2]');

    // Send without Done: the live pick goes with the answer.
    await h.send();
    const reply = h.client.answerQuestion.mock.calls[0][2] as { answers: { text?: string; picks?: SceneReference[] }[] };
    expect(reply.answers[1].picks!.map((p) => [p.n, p.color.name, p.kind, p.count, p.selector.source])).toEqual([[2, 'blue', 'edge', 4, 'e.endEdges(edge().line())']]);
    expect(reply.answers[1].text).toBe('[2]');
    expect(h.scene.entities).toEqual([]);
    expect(h.item(1).querySelector('[data-ref="answer"]')!.textContent!.trim()).toBe('[2] 4 edges[2]');
  });

  it('arming a second question takes the selection from the first, which keeps its pick', async () => {
    const h = await mount();
    h.button(0).click();
    h.scene.answers = () => ({ ok: true, answer: topFace as ResolveSelectionAnswer });
    h.scene.select([face()]);
    await h.resolved();
    h.button(1).click();
    expect(h.button(0).getAttribute('aria-pressed')).toBe('false');
    expect(h.button(1).getAttribute('aria-pressed')).toBe('true');
    expect(h.chips(0)).toEqual(['red:[1] 1 face']);
    expect(h.scene.entities).toEqual([]);
    h.scene.answers = () => ({ ok: true, answer: rimEdges as ResolveSelectionAnswer });
    h.scene.select(edges(4));
    await h.resolved();
    expect(h.chips(0)).toEqual(['red:[1] 1 face']);
    expect(h.chips(1)).toEqual(['red:[1] 4 edges(ready)']);
  });

  it('shows why a selection has no selector, and the question is still answered in words', async () => {
    const h = await mount();
    h.button(0).click();
    h.scene.answers = () => ({ ok: true, answer: twoPartsRefused as ResolveSelectionAnswer });
    h.scene.select([face()]);
    await h.resolved();
    expect(h.chips(0)[0]).toContain('(refused)');
    expect(h.sendDisabled()).toBe(true);
    const field = h.item(0).querySelector<HTMLInputElement>('[data-ref="text"]')!;
    field.value = 'the one facing the wall';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await h.send();
    const reply = h.client.answerQuestion.mock.calls[0][2] as { answers: { text?: string; picks?: SceneReference[] }[] };
    expect(reply.answers[0]).toEqual({ selected: [], text: 'the one facing the wall' });
    // The refused selection is not left for the composer to attach.
    expect(h.scene.entities).toEqual([]);
  });

  it('says so when the model on screen cannot be picked from, and follows the model', async () => {
    const scene = new FakeScene();
    scene.unpickableReason = 'Faces and edges of an assembly cannot be picked yet.';
    const h = await mount(pickQuestion(), scene);
    const unavailable = () => h.item(0).querySelector<HTMLElement>('[data-ref="pick-unavailable"]')!;
    expect(unavailable().textContent).toBe('Faces and edges of an assembly cannot be picked yet. Answer in words.');
    expect(unavailable().classList.contains('hidden')).toBe(false);
    expect(h.item(0).querySelector<HTMLElement>('[data-ref="pick"]')!.classList.contains('hidden')).toBe(true);
    // Still a question: words and Skip work.
    expect(h.item(0).querySelector('[data-ref="text"]')).not.toBeNull();
    expect(h.card.querySelector<HTMLButtonElement>('[data-ref="question-skip"]')!.disabled).toBe(false);

    // A part file comes on screen: the button is back.
    scene.unpickableReason = null;
    scene.render();
    expect(unavailable().classList.contains('hidden')).toBe(true);
    expect(h.item(0).querySelector<HTMLElement>('[data-ref="pick"]')!.classList.contains('hidden')).toBe(false);

    // And an assembly again, under an armed question: it lets go.
    h.button(0).click();
    expect(h.button(0).getAttribute('aria-pressed')).toBe('true');
    scene.unpickableReason = 'Faces and edges of an assembly cannot be picked yet.';
    scene.render();
    expect(h.button(0).getAttribute('aria-pressed')).toBe('false');
    expect(unavailable().classList.contains('hidden')).toBe(false);
    scene.select([face()]);
    await h.resolved();
    expect(h.composerChips()).toBe(1);
  });

  it('says picking is not available on a page with no scene', async () => {
    const h = await mount(pickQuestion(), null);
    expect(h.item(0).querySelector('[data-ref="pick-unavailable"]')!.textContent).toBe(`${NO_SCENE_REASON} Answer in words.`);
    expect(h.item(0).querySelector<HTMLElement>('[data-ref="pick"]')!.classList.contains('hidden')).toBe(true);
    expect(h.item(0).querySelector('[data-ref="text"]')).not.toBeNull();
  });

  it('drops what was picked when the model re-renders, and lets go of the selection when the panel closes or the card ends', async () => {
    const h = await mount();
    h.button(1).click();
    h.scene.select(edges(4));
    await h.resolved();
    h.item(1).querySelector<HTMLElement>('[data-ref=keep-reference]')!.click();
    expect(h.chips(1)).toEqual(['red:[1] 4 edges']);
    h.scene.render();
    expect(h.chips(1)).toEqual([]);
    expect(h.item(1).querySelector('[data-ref="reference-notice"]')!.textContent).toBe(MODEL_CHANGED_NOTICE);
    expect(h.sendDisabled()).toBe(true);

    // Closing the panel disarms: the next selection is not taken by a card nobody sees.
    expect(h.button(1).getAttribute('aria-pressed')).toBe('true');
    h.panel.close();
    expect(h.button(1).getAttribute('aria-pressed')).toBe('false');
    h.panel.show();
    await settle();

    // The turn is stopped while a question is armed: the selection goes back to the composer.
    h.button(1).click();
    h.scene.select(edges(4));
    await h.resolved();
    h.client.emit('s', { type: 'part-update', messageId: 'a1', partId: 'q1', patch: { state: 'unanswered', reason: 'Stopped before you answered.' } });
    h.client.emit('s', { type: 'status', status: { state: 'idle' } });
    await settle();
    expect(h.card.dataset.state).toBe('unanswered');
    expect(h.scene.entities).toEqual([]);
    h.scene.select(edges(4));
    await h.resolved();
    expect(h.composerChips()).toBe(1);
  });

  it('a reloaded page shows an answered pick question with its chips', async () => {
    const reference: SceneReference = {
      n: 1,
      color: { name: 'red', hex: REFERENCE_COLORS[0].hex },
      kind: 'face',
      count: 1,
      file: '/w/plate.part.js',
      selector: { source: 'e.endFaces()', producers: [], imports: [], alternatives: [] },
      geometry: [],
      unit: 'mm',
    };
    const h = await mount(pickQuestion({ state: 'answered', answers: [{ selected: [], picks: [reference], text: 'the top' }, { selected: [] }, { selected: [], text: '2' }] }));
    expect(h.item(0).querySelector('[data-ref="answer"]')!.textContent!.trim()).toBe('[1] 1 facethe top');
    expect(h.item(0).querySelectorAll('[data-ref="picked"] .chat-reference-chip')).toHaveLength(1);
    expect(h.item(0).querySelector('[data-ref="pick-button"]')).toBeNull();
    expect(h.item(1).querySelector('[data-ref="answer"]')!.textContent).toBe('Left open');
  });
});

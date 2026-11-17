// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatComposer } from '../src/ui/chat/chat-composer';
import { REFERENCE_COLORS, MAX_REFERENCES } from '../src/ui/chat/reference-colors';
import {
  buildSceneReference,
  FULL_HINT,
  MODEL_CHANGED_NOTICE,
  ROLLED_BACK_HINT,
  SceneReferences,
  type ChatSceneHost,
  type ReferencePick,
  type ResolveOutcome,
  type ResolveSelectionAnswer,
  type SelectedEntityLike,
} from '../src/ui/chat/scene-references';
import { ReferencesPartView } from '../src/ui/chat/parts/references-part';
import { ChatPanel } from '../src/ui/chat/chat-panel';
import { LeftSlot } from '../src/ui/left-slot';
import { FakeChatClient } from './fixtures/fake-chat-client';
import { settle } from './fixtures/fake-packages-client';
import rimEdges from './fixtures/resolve-selection/plate-rim-edges.json';
import topFace from './fixtures/resolve-selection/plate-top-face.json';
import faceAndEdge from './fixtures/resolve-selection/plate-face-and-edge.json';
import twoPartsRefused from './fixtures/resolve-selection/two-parts-refused.json';
import twoPartsOneFace from './fixtures/resolve-selection/two-parts-one-face.json';

// Scene references (docs/agent-chat-plan.md §11): the reference built from
// recorded `POST api/resolve-selection` answers (a real engine on the
// videos/part plate: the four rim edges of the top face, the top face, a
// face and an edge together; two parts' top faces, which the synthesizer
// refuses), and the composer's chips and tokens.

const SLOT = { n: 1, color: REFERENCE_COLORS[0], file: '/w/plate.part.js' };

describe('buildSceneReference', () => {
  it('keeps the selector, its features, imports, alternatives and geometry of the four rim edges', () => {
    const built = buildSceneReference(rimEdges as ResolveSelectionAnswer, SLOT);
    expect(built).toEqual({
      ok: true,
      reference: {
        n: 1,
        color: { name: 'red', hex: REFERENCE_COLORS[0].hex },
        kind: 'edge',
        count: 4,
        file: '/w/plate.part.js',
        selector: {
          source: 'e.endEdges(edge().line())',
          producers: [{ variable: 'e', feature: 'extrude', featureType: 'extrude', line: 37, bound: false }],
          imports: ['edge'],
          alternatives: ['e.endEdges(0, 1, 2, 3)'],
        },
        geometry: rimEdges.matches.map((m) => m.summary),
        unit: 'mm',
      },
    });
  });

  it('serializes without any shape id, index, scene-object id or $obj form', () => {
    for (const answer of [rimEdges, topFace, faceAndEdge]) {
      const built = buildSceneReference(answer as ResolveSelectionAnswer, SLOT);
      expect(built.ok).toBe(true);
      const json = JSON.stringify(built.ok ? built.reference : null);
      expect(json).not.toMatch(/shapeId|"index"|sceneObjectId|\$obj|expression|filePath|column/);
      for (const match of answer.matches) {
        expect(json).not.toContain(match.shapeId);
        expect(json).not.toContain(match.sceneObjectId);
      }
    }
  });

  it('marks a face and an edge together as mixed, with the comma-separated selector', () => {
    const built = buildSceneReference(faceAndEdge as ResolveSelectionAnswer, SLOT);
    expect(built.ok && built.reference.kind).toBe('mixed');
    expect(built.ok && built.reference.selector.source).toBe("e.endFaces(), e.endEdges(edge().nearest('x'))");
    expect(built.ok && built.reference.count).toBe(2);
  });

  it('refuses what the synthesizer refuses, with its reason, and never falls back to ids', () => {
    const built = buildSceneReference(twoPartsRefused as ResolveSelectionAnswer, SLOT);
    expect(built).toEqual({ ok: false, reason: (twoPartsRefused.synthesized as { reason: string }).reason });
    const { synthesized: _drop, ...bare } = rimEdges;
    expect(buildSceneReference(bare as ResolveSelectionAnswer, SLOT).ok).toBe(false);
    expect(buildSceneReference({ ...(rimEdges as ResolveSelectionAnswer), matches: [], count: 0 }, SLOT).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------

/** A scene the composer attaches from: a selection, renders, a resolver answering from the recordings. */
class FakeScene implements ChatSceneHost {
  entities: SelectedEntityLike[] = [];
  rolledBack = false;
  private selectionListeners = new Set<() => void>();
  private renderListeners = new Set<() => void>();
  resolveCalls: ReferencePick[][] = [];
  /** Answers by the picks' shape id and count; anything else is the rim-edges answer. */
  answers: (picks: ReferencePick[]) => ResolveOutcome = () => ({ ok: true, answer: rimEdges as ResolveSelectionAnswer });
  pending: { resolve: () => void } | null = null;
  hold = false;

  selection = () => this.entities;
  addSelectionListener = (fn: () => void) => {
    this.selectionListeners.add(fn);
    return () => this.selectionListeners.delete(fn);
  };
  addRenderListener = (fn: () => void) => {
    this.renderListeners.add(fn);
    return () => this.renderListeners.delete(fn);
  };
  clearSelection = () => this.select([]);
  isRolledBack = () => this.rolledBack;
  currentFile = () => '/w/plate.part.js';
  capture = vi.fn(async () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }));
  resolve = async (picks: ReferencePick[]): Promise<ResolveOutcome> => {
    this.resolveCalls.push(picks);
    if (this.hold) {
      await new Promise<void>((resolve) => {
        this.pending = { resolve };
      });
    }
    return this.answers(picks);
  };

  select(entities: SelectedEntityLike[]): void {
    this.entities = entities;
    for (const fn of [...this.selectionListeners]) {
      fn();
    }
  }

  render(): void {
    this.entities = [];
    for (const fn of [...this.renderListeners]) {
      fn();
    }
  }
}

const edges = (n: number): SelectedEntityLike[] =>
  Array.from({ length: n }, (_, i) => ({ shapeId: 'sh-1', sub: { type: 'edge', index: i } }));
const face = (index = 9): SelectedEntityLike => ({ shapeId: 'sh-1', sub: { type: 'face', index } });

const mounted: { refs: SceneReferences; composer: ChatComposer }[] = [];

function mount(scene = new FakeScene()) {
  const composer = new ChatComposer({ onSubmit: async () => true, onStop: () => {} });
  const refs = new SceneReferences(scene, composer);
  composer.setAttachments(refs.el);
  document.body.append(composer.el);
  mounted.push({ refs, composer });
  const $ = (selector: string) => composer.el.querySelector<HTMLElement>(selector);
  const $$ = (selector: string) => [...composer.el.querySelectorAll<HTMLElement>(selector)];
  const chips = () => $$('[data-ref=reference-chips] .chat-reference-chip').map((c) => `${c.dataset.color}:${c.textContent?.replace('×', '').trim()}`);
  const click = async (ref: string) => {
    $(`[data-ref=${ref}]`)!.click();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { scene, refs, composer, $, $$, chips, click };
}

afterEach(() => {
  for (const { refs, composer } of mounted.splice(0)) {
    refs.destroy();
    composer.el.remove();
  }
});

describe('the composer\'s scene references', () => {
  it('offers the selection, attaches it as one reference with a [1] token at the caret, and clears the selection', async () => {
    const { scene, refs, composer, $, chips, click } = mount();
    expect(refs.el.classList.contains('hidden')).toBe(true);

    scene.select(edges(4));
    expect($('[data-ref=selection-label]')!.textContent).toBe('4 edges selected');
    expect($('[data-ref=selection-row]')!.dataset.state).toBe('ready');

    composer.value = 'fillet  by 2';
    composer.textarea.focus();
    composer.textarea.setSelectionRange(7, 7);
    // Picking in the viewport takes the focus: the caret is remembered.
    composer.textarea.blur();
    await click('add-selection');

    expect(scene.resolveCalls).toEqual([[0, 1, 2, 3].map((index) => ({ shapeId: 'sh-1', kind: 'edge', index }))]);
    expect(composer.value).toBe('fillet [1] by 2');
    expect(chips()).toEqual(['red:[1] 4 edges']);
    expect($('[data-ref=reference-chips] .chat-reference-chip')!.title).toBe('e.endEdges(edge().line())');
    expect(scene.entities).toEqual([]);
    expect($('[data-ref=selection-row]')!.classList.contains('hidden')).toBe(true);

    // The next one takes the next colour; its token lands at the caret (here the end).
    scene.answers = () => ({ ok: true, answer: topFace as ResolveSelectionAnswer });
    scene.select([face()]);
    expect($('[data-ref=selection-label]')!.textContent).toBe('1 face selected');
    composer.textarea.focus();
    composer.textarea.setSelectionRange(composer.value.length, composer.value.length);
    await click('add-selection');
    expect(composer.value).toBe('fillet [1] by 2 [2] ');
    // Without a caret of its own (a new text), a token goes at the end.
    composer.textarea.blur();
    composer.value = 'chamfer';
    composer.removeToken('[2]');
    expect(composer.value).toBe('chamfer');
    expect(chips()).toEqual(['red:[1] 4 edges', 'blue:[2] 1 face']);
  });

  it('removing a chip removes its token and frees its colour for the next reference', async () => {
    const { scene, composer, $$, chips, click } = mount();
    for (let i = 0; i < 3; i++) {
      scene.select(edges(4));
      composer.textarea.setSelectionRange(composer.value.length, composer.value.length);
      await click('add-selection');
    }
    composer.value = 'fillet [1] by 2, [2] by 3 and chamfer [3]';
    expect(chips()).toEqual(['red:[1] 4 edges', 'blue:[2] 4 edges', 'green:[3] 4 edges']);

    $$('[data-ref=remove-reference]')[1].click();
    expect(chips()).toEqual(['red:[1] 4 edges', 'green:[3] 4 edges']);
    expect(composer.value).toBe('fillet [1] by 2, by 3 and chamfer [3]');

    scene.select(edges(2));
    await click('add-selection');
    expect(chips()).toEqual(['red:[1] 4 edges', 'blue:[2] 4 edges', 'green:[3] 4 edges']);
  });

  it('holds at most eight references, one colour each', async () => {
    const { scene, refs, $, chips, click } = mount();
    for (let i = 0; i < MAX_REFERENCES; i++) {
      scene.select(edges(1));
      await click('add-selection');
    }
    expect(chips().map((c) => c.split(':')[0])).toEqual(REFERENCE_COLORS.map((c) => c.name));
    expect(new Set(REFERENCE_COLORS.map((c) => c.hex)).size).toBe(MAX_REFERENCES);

    scene.select(edges(1));
    const add = $('[data-ref=add-selection]') as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect($('[data-ref=selection-hint]')!.textContent).toBe(FULL_HINT);
    expect(await refs.add()).toBe(false);
    expect(refs.size).toBe(MAX_REFERENCES);
  });

  it('drops the unsent references and their tokens when the model re-renders', async () => {
    const { scene, refs, composer, $, chips, click } = mount();
    scene.select(edges(4));
    await click('add-selection');
    composer.value = `${composer.value}by 2`;
    const sent = refs.forSend()!;
    expect(sent.highlight).toEqual([0, 1, 2, 3].map((index) => ({ shapeId: 'sh-1', kind: 'edge', index, color: REFERENCE_COLORS[0].hex })));

    scene.render();
    expect(chips()).toEqual([]);
    expect(composer.value).toBe('by 2');
    expect($('[data-ref=reference-notice]')!.textContent).toBe(MODEL_CHANGED_NOTICE);
    expect(refs.forSend()).toBeNull();
    expect(refs.isCurrent(sent.generation)).toBe(false);

    // Selecting again clears the notice.
    scene.select(edges(1));
    expect($('[data-ref=reference-notice]')!.classList.contains('hidden')).toBe(true);
  });

  it('drops an answer that arrives after a render: its picks are gone', async () => {
    const { scene, refs, chips } = mount();
    scene.hold = true;
    scene.select(edges(4));
    const adding = refs.add();
    await new Promise((r) => setTimeout(r, 0));
    scene.render();
    scene.pending!.resolve();
    expect(await adding).toBe(false);
    expect(chips()).toEqual([]);
  });

  it('shows the synthesizer\'s refusal and adds the entities one at a time on request', async () => {
    const { scene, composer, $, chips, click } = mount();
    scene.answers = (picks) => ({
      ok: true,
      answer: (picks.length > 1 ? twoPartsRefused : twoPartsOneFace) as ResolveSelectionAnswer,
    });
    scene.select([{ shapeId: 'a', sub: { type: 'face', index: 2 } }, { shapeId: 'b', sub: { type: 'face', index: 2 } }]);
    await click('add-selection');

    expect($('[data-ref=selection-row]')!.dataset.state).toBe('refused');
    expect($('[data-ref=refusal]')!.textContent).toContain('different part() scopes');
    expect(chips()).toEqual([]);
    expect(scene.entities).toHaveLength(2);

    await click('add-one-at-a-time');
    expect(scene.resolveCalls.slice(1)).toEqual([[{ shapeId: 'a', kind: 'face', index: 2 }], [{ shapeId: 'b', kind: 'face', index: 2 }]]);
    expect(chips()).toEqual(['red:[1] 1 face', 'blue:[2] 1 face']);
    expect(composer.value).toBe('[1] [2] ');
    expect(scene.entities).toEqual([]);
  });

  it('shows a 4xx from the route as a refusal, without "Add one at a time" for one entity', async () => {
    const { scene, $, click } = mount();
    scene.answers = () => ({ ok: false, reason: 'No solid "x" in the scene.' });
    scene.select([face()]);
    await click('add-selection');
    expect($('[data-ref=refusal]')!.textContent).toBe('No solid "x" in the scene.');
    expect($('[data-ref=add-one-at-a-time]')).toBeNull();
  });

  it('turns Add off with a hint while the timeline is rolled back, and refuses inserted instances', async () => {
    const { scene, refs, $, click } = mount();
    scene.rolledBack = true;
    scene.select(edges(2));
    expect(($('[data-ref=add-selection]') as HTMLButtonElement).disabled).toBe(true);
    expect($('[data-ref=selection-hint]')!.textContent).toBe(ROLLED_BACK_HINT);
    expect(await refs.add()).toBe(false);
    expect(scene.resolveCalls).toEqual([]);

    scene.rolledBack = false;
    scene.select([{ shapeId: 'sh-1', sub: { type: 'face', index: 0 }, instanceId: 'inst-1' }]);
    await click('add-selection');
    expect($('[data-ref=selection-row]')!.dataset.state).toBe('refused');
    expect(scene.resolveCalls).toEqual([]);
  });

  it('clears the chips once the message went, leaving the text to the composer', async () => {
    const { scene, refs, chips, click } = mount();
    scene.select(edges(4));
    await click('add-selection');
    refs.clearSent();
    expect(chips()).toEqual([]);
    expect(refs.el.classList.contains('hidden')).toBe(true);
  });
});

describe('ReferencesPartView', () => {
  it('shows each sent reference as a chip: colour, [n], count and kind, the selector as tooltip', () => {
    const built = buildSceneReference(rimEdges as ResolveSelectionAnswer, SLOT);
    const view = new ReferencesPartView({ type: 'references', id: 'p1', references: [built.ok ? built.reference : null!] });
    const chip = view.el.querySelector<HTMLElement>('.chat-reference-chip')!;
    expect(chip.textContent).toBe('[1] 4 edges');
    expect(chip.title).toBe('e.endEdges(edge().line())');
    expect(chip.dataset.color).toBe('red');
  });
});

describe('sending a message with references', () => {
  it('sends the references and one capture with each reference in its colour, then clears the chips', async () => {
    const scene = new FakeScene();
    const client = new FakeChatClient();
    const container = document.createElement('div');
    document.body.append(container);
    const panel = new ChatPanel({
      container,
      client,
      slot: new LeftSlot({ width: 500 }),
      settings: () => ({ defaultAgent: null, permissionMode: 'ask' }),
      openExternal: () => {},
      scene,
    });
    try {
      panel.show();
      await settle();
      await settle();
      scene.select(edges(4));
      panel.el.querySelector<HTMLElement>('[data-ref=add-selection]')!.click();
      await settle();
      scene.answers = () => ({ ok: true, answer: topFace as ResolveSelectionAnswer });
      scene.select([face()]);
      panel.el.querySelector<HTMLElement>('[data-ref=add-selection]')!.click();
      await settle();
      const input = panel.el.querySelector<HTMLTextAreaElement>('[data-ref=input]')!;
      expect(input.value).toBe('[1] [2] ');
      input.value = 'fillet [1] by 2 and shell from [2]';
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await settle();
      await settle();

      expect(scene.capture).toHaveBeenCalledTimes(1);
      expect(scene.capture.mock.calls[0][0]).toEqual([
        ...[0, 1, 2, 3].map((index) => ({ shapeId: 'sh-1', kind: 'edge', index, color: REFERENCE_COLORS[0].hex })),
        { shapeId: 'sh-1', kind: 'face', index: 9, color: REFERENCE_COLORS[1].hex },
      ]);
      expect(client.sent).toHaveLength(1);
      const message = client.sent[0].message;
      expect(message.text).toBe('fillet [1] by 2 and shell from [2]');
      expect(message.references!.map((r) => [r.n, r.color.name, r.kind, r.count, r.selector.source])).toEqual([
        [1, 'red', 'edge', 4, 'e.endEdges(edge().line())'],
        [2, 'blue', 'face', 1, 'e.endFaces()'],
      ]);
      expect(message.image).toEqual({ mediaType: 'image/png', base64: 'iVBORw==' });
      expect(JSON.stringify(message.references)).not.toMatch(/shapeId|sceneObjectId|\$obj|"index"/);
      expect(panel.el.querySelectorAll('[data-ref=reference-chips] .chat-reference-chip')).toHaveLength(0);
      expect(input.value).toBe('');
    } finally {
      panel.destroy();
    }
  });
});

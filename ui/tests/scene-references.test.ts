// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatComposer } from '../src/ui/chat/chat-composer';
import { REFERENCE_COLORS, MAX_REFERENCES } from '../src/ui/chat/reference-colors';
import {
  buildSceneReference,
  FULL_HINT,
  MODEL_CHANGED_NOTICE,
  RESOLVE_DEBOUNCE_MS,
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
import { FakeScene, edges, face } from './fixtures/fake-chat-scene';
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

  it('keeps what a summary says of a free-form face, a spline and a recovered plane, and still not the match\'s own kind', () => {
    const summaries = [
      { form: 'surface', surfaceType: 'freeform', center: [0, 0, 15], area: 2400.5 },
      { form: 'curve', curveType: 'spline', center: [120, 22, 10], length: 41.2, closed: false, planar: true },
      { form: 'ellipse', center: [0, 0, 30], normal: [0, 0, 1], length: 44.9, closed: true },
      { form: 'plane', recovered: true, center: [0, -8, 10], normal: [0, -1, 0], area: 280 },
    ];
    const answer = {
      ...(rimEdges as ResolveSelectionAnswer),
      matches: summaries.map((summary, index) => ({
        ...rimEdges.matches[0], kind: index === 0 || index === 3 ? 'face' : 'edge', summary,
      })),
      count: summaries.length,
    } as ResolveSelectionAnswer;

    const built = buildSceneReference(answer, SLOT);
    expect(built.ok && built.reference.geometry).toEqual(summaries);
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

const mounted: { refs: SceneReferences; composer: ChatComposer }[] = [];

function mount(scene = new FakeScene(), { active = true } = {}) {
  const composer = new ChatComposer({ onSubmit: async () => true, onStop: () => {} });
  const refs = new SceneReferences(scene, composer);
  refs.setActive(active);
  composer.setAttachments(refs.el);
  document.body.append(composer.el);
  mounted.push({ refs, composer });
  const $ = (selector: string) => composer.el.querySelector<HTMLElement>(selector);
  const $$ = (selector: string) => [...composer.el.querySelectorAll<HTMLElement>(selector)];
  /** Every chip as "colour:label", the live one marked with its state. */
  const chips = () => $$('[data-ref=reference-chips] .chat-reference-chip').map((c) => {
    const label = c.querySelector('.chat-reference-label')?.textContent ?? '';
    const live = c.dataset.ref === 'live-reference' ? `(${c.dataset.state})` : '';
    return `${c.dataset.color ?? '-'}:${label}${live}`;
  });
  const live = () => $('[data-ref=live-reference]');
  const click = async (ref: string, within: ParentNode = composer.el) => {
    within.querySelector<HTMLElement>(`[data-ref=${ref}]`)!.click();
    await vi.advanceTimersByTimeAsync(0);
  };
  /** Let the debounce run out and the resolver answer. */
  const resolved = () => vi.advanceTimersByTimeAsync(RESOLVE_DEBOUNCE_MS);
  return { scene, refs, composer, $, $$, chips, live, click, resolved };
}

afterEach(() => {
  for (const { refs, composer } of mounted.splice(0)) {
    refs.destroy();
    composer.el.remove();
  }
  vi.useRealTimers();
});

describe('the composer\'s scene references', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('shows the selection as a live chip by itself, follows it, and drops it when the selection clears', async () => {
    const { scene, refs, composer, chips, live, resolved } = mount();
    expect(refs.el.classList.contains('hidden')).toBe(true);

    scene.select(edges(4));
    // Numbered and coloured at once, pending until the synthesizer answers.
    expect(chips()).toEqual(['red:[1] 4 edges(pending)']);
    expect(live()!.getAttribute('aria-busy')).toBe('true');
    expect((live()!.querySelector('[data-ref=keep-reference]') as HTMLButtonElement).disabled).toBe(true);
    expect(scene.resolveCalls).toEqual([]);
    await resolved();
    expect(scene.resolveCalls).toEqual([[0, 1, 2, 3].map((index) => ({ shapeId: 'sh-1', kind: 'edge', index }))]);
    expect(chips()).toEqual(['red:[1] 4 edges(ready)']);
    expect(live()!.querySelector('[data-ref=reference-label]')!.getAttribute('title')).toContain('e.endEdges(edge().line())');
    expect(refs.references.map((r) => [r.n, r.color.name, r.selector.source])).toEqual([[1, 'red', 'e.endEdges(edge().line())']]);
    // Nothing is typed for the user.
    expect(composer.value).toBe('');

    // A new selection is resolved again, as one reference.
    scene.answers = () => ({ ok: true, answer: topFace as ResolveSelectionAnswer });
    scene.select([face()]);
    expect(chips()).toEqual(['red:[1] 1 face(pending)']);
    expect(refs.references).toEqual([]);
    await resolved();
    expect(chips()).toEqual(['red:[1] 1 face(ready)']);

    scene.select([]);
    expect(chips()).toEqual([]);
    expect(refs.el.classList.contains('hidden')).toBe(true);
    expect(refs.forSend()).toBeNull();
  });

  it('waits for the selection to hold still, and ignores answers for a selection that changed', async () => {
    const { scene, chips, resolved } = mount();
    scene.select(edges(1));
    await vi.advanceTimersByTimeAsync(100);
    scene.select(edges(2));
    await vi.advanceTimersByTimeAsync(100);
    scene.select(edges(3));
    expect(scene.resolveCalls).toEqual([]);
    await resolved();
    expect(scene.resolveCalls.map((p) => p.length)).toEqual([3]);

    // An answer that arrives after the selection moved on is dropped.
    scene.hold = true;
    scene.select(edges(4));
    await resolved();
    const stale = scene.pending!;
    scene.hold = false;
    scene.answers = () => ({ ok: true, answer: topFace as ResolveSelectionAnswer });
    scene.select([face()]);
    stale.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(chips()).toEqual(['red:[1] 1 face(pending)']);
    await resolved();
    expect(chips()).toEqual(['red:[1] 1 face(ready)']);
  });

  it('keeps the live chip and starts a new one with the next number and colour', async () => {
    const { scene, refs, chips, live, click, resolved } = mount();
    scene.select(edges(4));
    await resolved();
    await click('keep-reference', live()!);
    expect(scene.entities).toEqual([]);
    expect(chips()).toEqual(['red:[1] 4 edges']);

    scene.answers = () => ({ ok: true, answer: topFace as ResolveSelectionAnswer });
    scene.select([face()]);
    expect(chips()).toEqual(['red:[1] 4 edges', 'blue:[2] 1 face(pending)']);
    await resolved();
    expect(chips()).toEqual(['red:[1] 4 edges', 'blue:[2] 1 face(ready)']);
    expect(refs.references.map((r) => [r.n, r.color.name])).toEqual([[1, 'red'], [2, 'blue']]);
  });

  it('removing a kept chip frees its colour without renumbering the others or touching the text', async () => {
    const { scene, composer, $$, chips, live, click, resolved } = mount();
    for (let i = 0; i < 3; i++) {
      scene.select(edges(4));
      await resolved();
      await click('keep-reference', live()!);
    }
    composer.value = 'fillet [1] by 2, [2] by 3 and chamfer [3]';
    expect(chips()).toEqual(['red:[1] 4 edges', 'blue:[2] 4 edges', 'green:[3] 4 edges']);

    $$('[data-ref=remove-reference]')[1].click();
    expect(chips()).toEqual(['red:[1] 4 edges', 'green:[3] 4 edges']);
    expect(composer.value).toBe('fillet [1] by 2, [2] by 3 and chamfer [3]');

    scene.select(edges(2));
    await resolved();
    expect(chips()).toEqual(['red:[1] 4 edges', 'blue:[2] 4 edges(ready)', 'green:[3] 4 edges']);
  });

  it('puts a chip\'s [n] where the caret was when its label is clicked', async () => {
    const { scene, composer, live, click, resolved } = mount();
    scene.select(edges(4));
    await resolved();
    composer.value = 'fillet  by 2';
    composer.textarea.focus();
    composer.textarea.setSelectionRange(7, 7);
    // Picking in the viewport (or the click itself) takes the focus: the caret is remembered.
    composer.textarea.blur();
    await click('reference-label', live()!);
    expect(composer.value).toBe('fillet [1] by 2');
    expect(document.activeElement).toBe(composer.textarea);
  });

  it('× on the live chip clears the selection', async () => {
    const { scene, chips, live, click, resolved } = mount();
    scene.select(edges(4));
    await resolved();
    await click('dismiss-live', live()!);
    expect(scene.entities).toEqual([]);
    expect(chips()).toEqual([]);
  });

  it('holds at most eight references with the live one; past that the live chip shows a hint', async () => {
    const { scene, refs, $, $$, chips, live, click, resolved } = mount();
    for (let i = 0; i < MAX_REFERENCES - 1; i++) {
      scene.select(edges(1));
      await resolved();
      await click('keep-reference', live()!);
    }
    scene.select(edges(1));
    await resolved();
    expect(refs.size).toBe(MAX_REFERENCES);
    expect(refs.references.map((r) => r.color.name)).toEqual(REFERENCE_COLORS.map((c) => c.name));
    expect(new Set(REFERENCE_COLORS.map((c) => c.hex)).size).toBe(MAX_REFERENCES);
    await click('keep-reference', live()!);

    const calls = scene.resolveCalls.length;
    scene.select(edges(4));
    await resolved();
    expect(scene.resolveCalls).toHaveLength(calls);
    expect(live()!.dataset.state).toBe('hint');
    expect($('[data-ref=live-hint]')!.textContent).toBe(FULL_HINT);
    expect(live()!.querySelector('[data-ref=keep-reference]')).toBeNull();
    expect(refs.size).toBe(MAX_REFERENCES);

    // Removing one makes room: the selection attaches in the freed slot.
    $$('[data-ref=remove-reference]')[2].click();
    await resolved();
    expect(chips()[2]).toBe('green:[3] 4 edges(ready)');
  });

  it('drops the kept references when the model re-renders; the live chip goes with the selection', async () => {
    const { scene, refs, composer, $, chips, live, click, resolved } = mount();
    scene.select(edges(4));
    await resolved();
    await click('keep-reference', live()!);
    scene.select([face()]);
    await resolved();
    composer.value = 'fillet [1] by 2';
    const sent = refs.forSend()!;
    expect(sent.highlight.slice(0, 4)).toEqual([0, 1, 2, 3].map((index) => ({ shapeId: 'sh-1', kind: 'edge', index, color: REFERENCE_COLORS[0].hex })));

    scene.render();
    expect(chips()).toEqual([]);
    expect(composer.value).toBe('fillet [1] by 2');
    expect($('[data-ref=reference-notice]')!.textContent).toBe(MODEL_CHANGED_NOTICE);
    expect(refs.forSend()).toBeNull();
    expect(refs.isCurrent(sent.generation)).toBe(false);

    // Selecting again clears the notice.
    scene.select(edges(1));
    expect($('[data-ref=reference-notice]')!.classList.contains('hidden')).toBe(true);
  });

  it('drops an answer that arrives after a render: its picks are gone', async () => {
    const { scene, refs, chips, resolved } = mount();
    scene.hold = true;
    scene.select(edges(4));
    await resolved();
    scene.render();
    scene.pending!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(chips()).toEqual([]);
    expect(refs.forSend()).toBeNull();
  });

  it('shows the synthesizer\'s refusal on the live chip, does not send it, and keeps the entities one at a time on request', async () => {
    const { scene, refs, $, chips, live, click, resolved } = mount();
    scene.answers = (picks) => ({
      ok: true,
      answer: (picks.length > 1 ? twoPartsRefused : twoPartsOneFace) as ResolveSelectionAnswer,
    });
    scene.select([{ shapeId: 'a', sub: { type: 'face', index: 2 } }, { shapeId: 'b', sub: { type: 'face', index: 2 } }]);
    await resolved();

    expect(live()!.dataset.state).toBe('refused');
    expect($('[data-ref=refusal]')!.textContent).toContain('different part() scopes');
    expect($('[data-ref=refusal]')!.title).toBe($('[data-ref=refusal]')!.textContent);
    expect(chips()).toEqual(['-:2 faces(refused)']);
    expect(refs.forSend()).toBeNull();
    expect(scene.entities).toHaveLength(2);

    await click('one-at-a-time', live()!);
    expect(scene.resolveCalls.slice(1)).toEqual([[{ shapeId: 'a', kind: 'face', index: 2 }], [{ shapeId: 'b', kind: 'face', index: 2 }]]);
    expect(chips()).toEqual(['red:[1] 1 face', 'blue:[2] 1 face']);
    expect(scene.entities).toEqual([]);
  });

  it('keeps those of several entities that synthesize, and says how many could not be', async () => {
    const { scene, $, chips, live, click, resolved } = mount();
    scene.answers = (picks) => (picks.length > 1
      ? { ok: true, answer: twoPartsRefused as ResolveSelectionAnswer }
      : picks[0].shapeId === 'a'
        ? { ok: true, answer: twoPartsOneFace as ResolveSelectionAnswer }
        : { ok: false, reason: 'No solid "b" in the scene.' });
    scene.select([{ shapeId: 'a', sub: { type: 'face', index: 2 } }, { shapeId: 'b', sub: { type: 'face', index: 2 } }]);
    await resolved();
    await click('one-at-a-time', live()!);
    expect(chips()).toEqual(['red:[1] 1 face']);
    expect($('[data-ref=reference-notice]')!.textContent).toBe('1 of 2 could not be attached: No solid "b" in the scene.');
  });

  it('shows a 4xx from the route as a refusal, without "One at a time" for one entity', async () => {
    const { scene, $, live, resolved } = mount();
    scene.answers = () => ({ ok: false, reason: 'No solid "x" in the scene.' });
    scene.select([face()]);
    await resolved();
    expect(live()!.dataset.state).toBe('refused');
    expect($('[data-ref=refusal]')!.textContent).toBe('No solid "x" in the scene.');
    expect($('[data-ref=one-at-a-time]')).toBeNull();
  });

  it('shows a hint while the timeline is rolled back, and refuses inserted instances, without resolving', async () => {
    const { scene, refs, $, live, resolved } = mount();
    scene.rolledBack = true;
    scene.select(edges(2));
    await resolved();
    expect(live()!.dataset.state).toBe('hint');
    expect($('[data-ref=live-hint]')!.textContent).toBe(ROLLED_BACK_HINT);
    expect(refs.forSend()).toBeNull();
    expect(scene.resolveCalls).toEqual([]);

    scene.rolledBack = false;
    scene.select([{ shapeId: 'sh-1', sub: { type: 'face', index: 0 }, instanceId: 'inst-1' }]);
    await resolved();
    expect(live()!.dataset.state).toBe('refused');
    expect($('[data-ref=one-at-a-time]')).toBeNull();
    expect(refs.forSend()).toBeNull();
    expect(scene.resolveCalls).toEqual([]);
  });

  it('attaches nothing while inactive (the panel closed); the kept chips stay', async () => {
    const { scene, refs, chips, live, click, resolved } = mount(new FakeScene(), { active: false });
    scene.select(edges(4));
    await resolved();
    expect(chips()).toEqual([]);
    expect(scene.resolveCalls).toEqual([]);

    refs.setActive(true);
    expect(chips()).toEqual(['red:[1] 4 edges(pending)']);
    await resolved();
    await click('keep-reference', live()!);
    scene.select([face()]);
    refs.setActive(false);
    await resolved();
    expect(chips()).toEqual(['red:[1] 4 edges']);
    expect(scene.resolveCalls).toHaveLength(1);
  });

  it('settles a selection still waiting or resolving before a send reads it', async () => {
    const { scene, refs } = mount();
    scene.select(edges(4));
    // The debounce is cut short.
    const settling = refs.settle();
    await vi.advanceTimersByTimeAsync(0);
    await settling;
    expect(refs.references.map((r) => r.n)).toEqual([1]);

    scene.hold = true;
    scene.answers = () => ({ ok: true, answer: topFace as ResolveSelectionAnswer });
    scene.select([face()]);
    await vi.advanceTimersByTimeAsync(RESOLVE_DEBOUNCE_MS);
    let settled = false;
    const waiting = refs.settle().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    scene.pending!.resolve();
    await waiting;
    expect(refs.references.map((r) => r.selector.source)).toEqual(['e.endFaces()']);
  });

  it('clears the chips and the selection once the message went', async () => {
    const { scene, refs, chips, live, click, resolved } = mount();
    scene.select(edges(4));
    await resolved();
    await click('keep-reference', live()!);
    scene.select([face()]);
    await resolved();
    refs.clearSent();
    expect(chips()).toEqual([]);
    expect(scene.entities).toEqual([]);
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
  it('sends the kept references and the live one with one capture in their colours, then clears the chips and the selection', async () => {
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
      // The selection attaches by itself; the pin keeps it for the next one.
      scene.select(edges(4));
      await new Promise((r) => setTimeout(r, RESOLVE_DEBOUNCE_MS + 10));
      await settle();
      expect(panel.el.querySelector<HTMLElement>('[data-ref=live-reference]')!.dataset.state).toBe('ready');
      panel.el.querySelector<HTMLElement>('[data-ref=keep-reference]')!.click();
      await settle();
      // The second one is still resolving when Enter is pressed: the send waits for it.
      scene.hold = true;
      scene.answers = () => ({ ok: true, answer: topFace as ResolveSelectionAnswer });
      scene.select([face()]);
      const input = panel.el.querySelector<HTMLTextAreaElement>('[data-ref=input]')!;
      expect(input.value).toBe('');
      input.value = 'fillet [1] by 2 and shell from [2]';
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await settle();
      expect(client.sent).toHaveLength(0);
      scene.pending!.resolve();
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
      expect(scene.entities).toEqual([]);
      expect(input.value).toBe('');
    } finally {
      panel.destroy();
    }
  });
});

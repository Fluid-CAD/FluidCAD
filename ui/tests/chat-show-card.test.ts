// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from '../src/ui/chat/chat-panel';
import type { ShowPart, ShowTarget } from '../src/ui/chat/chat-types';
import { STALE_NOTHING, httpTargetResolver, readRefs, type ChatPointHost, type PointHighlight, type TargetOutcome } from '../src/ui/chat/pointing';
import { REFERENCE_COLORS } from '../src/ui/chat/reference-colors';
import { LeftSlot } from '../src/ui/left-slot';
import { FakeChatClient } from './fixtures/fake-chat-client';
import { settle } from './fixtures/fake-packages-client';

// What the agent points at (`show_user`, docs/agent-chat-plan.md §27): the
// card of numbered, coloured chips, and the page's side of the highlight —
// the items of the one shown card resolved against the model on screen,
// drawn each in its colour, resolved again after every render.

const RED = REFERENCE_COLORS[0].hex;
const BLUE = REFERENCE_COLORS[1].hex;
const TOP: ShowTarget = { expression: '$obj["ex-1"].endFaces()' };
const EDGE: ShowTarget = { pick: { shapeId: 'sh-1', kind: 'edge', index: 4 } };

function showPart(overrides: Partial<ShowPart> = {}): ShowPart {
  return {
    type: 'show',
    id: 'show-1',
    file: 'plate.part.js',
    absPath: '/w/plate.part.js',
    note: 'Which of these carries the load?',
    items: [
      { n: 1, color: 'red', label: 'the mounting face', target: TOP, faces: 1, edges: 0 },
      { n: 2, color: 'blue', label: 'this edge', target: EDGE, faces: 0, edges: 1 },
    ],
    ...overrides,
  };
}

/** The viewport the panel points in: what it was last asked to draw, and a resolver the test answers. */
class FakePointHost implements ChatPointHost {
  onScreen: string | null = '/w/plate.part.js';
  draws: PointHighlight[][] = [];
  resolved: ShowTarget[] = [];
  private renderListeners = new Set<() => void>();
  /** By target; anything else resolves to nothing. */
  answers: (target: ShowTarget) => TargetOutcome = (target) =>
    'pick' in target
      ? { ok: true, refs: [{ shapeId: 'sh-1', kind: 'edge', index: 4 }] }
      : { ok: true, refs: [{ shapeId: 'sh-1', kind: 'face', index: 5 }] };

  file = () => this.onScreen;
  draw = (highlight: PointHighlight[]) => {
    this.draws.push(highlight);
  };
  addRenderListener = (fn: () => void) => {
    this.renderListeners.add(fn);
    return () => this.renderListeners.delete(fn);
  };
  resolve = async (target: ShowTarget): Promise<TargetOutcome> => {
    this.resolved.push(target);
    return this.answers(target);
  };

  /** What is in the viewport now. */
  get drawn(): PointHighlight[] {
    return this.draws[this.draws.length - 1] ?? [];
  }

  async render(): Promise<void> {
    for (const fn of [...this.renderListeners]) {
      fn();
    }
    await settle();
  }
}

const panels: ChatPanel[] = [];

afterEach(() => {
  for (const panel of panels.splice(0)) {
    panel.destroy();
  }
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

/** A panel on a chat whose turn is running, with `stored` cards already in the transcript (a reload). */
async function mount(stored: ShowPart[] = [], host: FakePointHost | null = new FakePointHost()) {
  const client = new FakeChatClient();
  client.addSession({
    id: 's',
    title: 'Bracket',
    status: { state: 'idle' },
    messages: [
      { id: 'u0', role: 'user', turnId: 't0', createdAt: '', parts: [{ type: 'text', id: 'u0t', text: 'where do the holes go?' }] },
      { id: 'a0', role: 'assistant', turnId: 't0', createdAt: '', parts: stored },
    ],
    turns: [{ id: 't0', userMessageId: 'u0', revertible: false }],
  });
  const container = document.createElement('div');
  document.body.append(container);
  const panel = new ChatPanel({
    container,
    client,
    slot: new LeftSlot({ width: 500 }),
    settings: () => ({ defaultAgent: null, permissionMode: 'ask' }),
    openExternal: () => {},
    ...(host ? { point: host } : {}),
  });
  panels.push(panel);
  panel.show();
  await settle();
  await settle();
  let turn = 0;
  /** The agent calls show_user in a new turn: the card arrives while its message streams. */
  const arrives = async (part: ShowPart) => {
    turn += 1;
    client.emit('s', { type: 'status', status: { state: 'running', turnId: `t${turn}` } });
    client.emit('s', { type: 'message-start', message: { id: `a${turn}`, role: 'assistant', turnId: `t${turn}`, createdAt: '' } });
    client.emit('s', { type: 'part-start', messageId: `a${turn}`, part });
    await settle();
  };
  const cards = () => [...panel.el.querySelectorAll<HTMLElement>('[data-part="show"]')];
  const chips = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-ref="show-chip"]')].map((c) => `${c.dataset.color}:${c.querySelector('[data-ref="show-label"]')!.textContent}(${c.dataset.state})`);
  const toggle = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('[data-ref="show-toggle"]')!;
  const status = (el: HTMLElement) => {
    const line = el.querySelector<HTMLElement>('[data-ref="show-status"]')!;
    return line.classList.contains('hidden') ? null : line.textContent;
  };
  return { client, panel, host: host!, arrives, cards, chips, toggle, status };
}

describe('a show_user card (§27)', () => {
  it('highlights its items by itself when it arrives, each in the colour of its numbered chip', async () => {
    const h = await mount();
    await h.arrives(showPart());
    const [card] = h.cards();
    expect(card.dataset.shown).toBe('true');
    expect(h.chips(card)).toEqual(['red:[1] the mounting face(shown)', 'blue:[2] this edge(shown)']);
    expect(card.querySelector('[data-ref="show-note"]')!.textContent).toBe('Which of these carries the load?');
    expect(card.querySelector('[data-ref="show-file"]')!.textContent).toBe('plate.part.js');
    // Resolved against the model on screen, the way the card names them: a selector and a pick.
    expect(h.host.resolved).toEqual([TOP, EDGE]);
    expect(h.host.drawn).toEqual([
      { shapeId: 'sh-1', kind: 'face', index: 5, color: RED },
      { shapeId: 'sh-1', kind: 'edge', index: 4, color: BLUE },
    ]);
    expect(h.status(card)).toBeNull();
    const chip = card.querySelector<HTMLElement>('[data-ref="show-chip"]')!;
    expect(chip.title).toBe('the mounting face — 1 face');
    // The dot is the colour drawn in the viewport.
    expect(chip.querySelector<HTMLElement>('.chat-reference-dot')!.style.backgroundColor).toBe('rgb(229, 72, 77)');
  });

  it('Clear removes the highlight, and Show in viewport brings it back', async () => {
    const h = await mount();
    await h.arrives(showPart());
    const [card] = h.cards();
    expect(h.toggle(card).textContent).toBe('Clear');
    expect(h.toggle(card).getAttribute('aria-pressed')).toBe('true');
    h.toggle(card).click();
    expect(h.host.drawn).toEqual([]);
    expect(card.dataset.shown).toBe('false');
    expect(h.toggle(card).textContent).toBe('Show in viewport');
    expect(h.chips(card)).toEqual(['red:[1] the mounting face(idle)', 'blue:[2] this edge(idle)']);
    h.toggle(card).click();
    await settle();
    expect(card.dataset.shown).toBe('true');
    expect(h.host.drawn).toHaveLength(2);
  });

  it('hovering or focusing a chip draws that item alone at full strength', async () => {
    const h = await mount();
    await h.arrives(showPart());
    const [card] = h.cards();
    const [first, second] = [...card.querySelectorAll<HTMLElement>('[data-ref="show-chip"]')];
    second.dispatchEvent(new MouseEvent('mouseenter'));
    expect(h.host.drawn).toEqual([
      { shapeId: 'sh-1', kind: 'face', index: 5, color: RED, dim: true },
      { shapeId: 'sh-1', kind: 'edge', index: 4, color: BLUE },
    ]);
    // The chip under the pointer is the same element: repainting it would end the hover.
    expect(card.querySelectorAll<HTMLElement>('[data-ref="show-chip"]')[1]).toBe(second);
    expect(second.dataset.emphasised).toBe('true');
    expect(first.dataset.emphasised).toBe('false');
    second.dispatchEvent(new MouseEvent('mouseleave'));
    expect(h.host.drawn.some((entry) => entry.dim)).toBe(false);
    expect(second.dataset.emphasised).toBe('false');
    // The keyboard does the same.
    expect(first.tabIndex).toBe(0);
    first.dispatchEvent(new FocusEvent('focus'));
    expect(h.host.drawn.map((entry) => !!entry.dim)).toEqual([false, true]);
    first.dispatchEvent(new FocusEvent('blur'));
    expect(h.host.drawn.some((entry) => entry.dim)).toBe(false);

    // A card that is not shown has nothing to emphasise.
    h.toggle(card).click();
    const draws = h.host.draws.length;
    second.dispatchEvent(new MouseEvent('mouseenter'));
    expect(h.host.draws).toHaveLength(draws);
  });

  it('a newer card replaces the highlight of an older one', async () => {
    const h = await mount();
    await h.arrives(showPart());
    await h.arrives(showPart({ id: 'show-2', note: undefined, items: [{ n: 1, color: 'red', label: 'the thin wall', target: { expression: 'face().onPlane("xz", 2)' }, faces: 1, edges: 0 }] }));
    const [older, newer] = h.cards();
    expect(older.dataset.shown).toBe('false');
    expect(h.toggle(older).textContent).toBe('Show in viewport');
    expect(newer.dataset.shown).toBe('true');
    expect(h.host.drawn).toEqual([{ shapeId: 'sh-1', kind: 'face', index: 5, color: RED }]);
    // The older one can be shown again, which takes the highlight back.
    h.toggle(older).click();
    await settle();
    expect(older.dataset.shown).toBe('true');
    expect(newer.dataset.shown).toBe('false');
    expect(h.host.drawn).toHaveLength(2);
  });

  it('marks an item that no longer resolves after a render as stale, and stops drawing it', async () => {
    const h = await mount();
    await h.arrives(showPart());
    const [card] = h.cards();
    // The model re-rendered: the edge's solid was rebuilt under another id, the face moved to another shape.
    h.host.answers = (target) =>
      'pick' in target
        ? { ok: false, reason: 'No solid "sh-1" in the scene (ids come from list_shapes / get_scene_summary).' }
        : { ok: true, refs: [{ shapeId: 'sh-2', kind: 'face', index: 3 }] };
    await h.host.render();
    expect(h.chips(card)).toEqual(['red:[1] the mounting face(shown)', 'blue:[2] this edge(stale)']);
    expect(h.host.drawn).toEqual([{ shapeId: 'sh-2', kind: 'face', index: 3, color: RED }]);
    expect(h.status(card)).toBe('The model changed: [2] is no longer in it.');
    const stale = card.querySelectorAll<HTMLElement>('[data-ref="show-chip"]')[1];
    expect(stale.querySelector('[data-ref="show-stale"]')!.classList.contains('hidden')).toBe(false);
    expect(stale.title).toContain('no longer in the model: No solid "sh-1"');
    expect(card.querySelectorAll<HTMLElement>('[data-ref="show-chip"]')[0].querySelector('[data-ref="show-stale"]')!.classList.contains('hidden')).toBe(true);

    // A selector that matches nothing is stale too; with both gone nothing is drawn.
    h.host.answers = (target) => ('pick' in target ? { ok: false, reason: 'gone' } : { ok: true, refs: [] });
    await h.host.render();
    expect(h.chips(card)).toEqual(['red:[1] the mounting face(stale)', 'blue:[2] this edge(stale)']);
    expect(card.querySelector<HTMLElement>('[data-ref="show-chip"]')!.title).toContain(STALE_NOTHING);
    expect(h.host.drawn).toEqual([]);
    expect(h.status(card)).toBe('The model changed: none of these is in it any more.');

    // An undo brings the geometry back: the items point again.
    h.host.answers = new FakePointHost().answers;
    await h.host.render();
    expect(h.chips(card)).toEqual(['red:[1] the mounting face(shown)', 'blue:[2] this edge(shown)']);
    expect(h.status(card)).toBeNull();
    expect(h.host.drawn).toHaveLength(2);
  });

  it('drops an answer for an older render', async () => {
    const host = new FakePointHost();
    let release: (() => void) | null = null;
    // The first round (the card arriving) is answered late, after a render asked again.
    host.resolve = async (target) => {
      host.resolved.push(target);
      if (host.resolved.length <= 2) {
        await new Promise<void>((resolve) => {
          const previous = release;
          release = () => {
            previous?.();
            resolve();
          };
        });
        return { ok: true, refs: [{ shapeId: 'old', kind: 'face', index: 0 }] };
      }
      return { ok: true, refs: [{ shapeId: 'new', kind: 'face', index: 0 }] };
    };
    const h = await mount([], host);
    await h.arrives(showPart());
    expect(h.chips(h.cards()[0])).toEqual(['red:[1] the mounting face(resolving)', 'blue:[2] this edge(resolving)']);
    await host.render();
    expect(host.drawn.map((entry) => entry.shapeId)).toEqual(['new', 'new']);
    release!();
    await settle();
    expect(host.drawn.map((entry) => entry.shapeId)).toEqual(['new', 'new']);
  });

  it('after a reload the card is there with nothing highlighted, and shows again when asked', async () => {
    const h = await mount([showPart()]);
    const [card] = h.cards();
    expect(card.dataset.shown).toBe('false');
    expect(h.chips(card)).toEqual(['red:[1] the mounting face(idle)', 'blue:[2] this edge(idle)']);
    expect(card.querySelector('[data-ref="show-note"]')!.textContent).toBe('Which of these carries the load?');
    expect(h.host.resolved).toEqual([]);
    expect(h.host.draws).toEqual([]);

    // The app restarted: the selector still resolves, the pick was the old render's.
    h.host.answers = (target) => ('pick' in target ? { ok: false, reason: 'No solid "sh-1" in the scene.' } : { ok: true, refs: [{ shapeId: 'sh-9', kind: 'face', index: 5 }] });
    h.toggle(card).click();
    await settle();
    expect(h.chips(card)).toEqual(['red:[1] the mounting face(shown)', 'blue:[2] this edge(stale)']);
    expect(h.host.drawn).toEqual([{ shapeId: 'sh-9', kind: 'face', index: 5, color: RED }]);
  });

  it('says so when another file is on screen, without resolving its selectors there', async () => {
    const h = await mount();
    await h.arrives(showPart());
    const [card] = h.cards();
    const asked = h.host.resolved.length;
    h.host.onScreen = '/w/lid.part.js';
    await h.host.render();
    expect(h.host.drawn).toEqual([]);
    expect(h.host.resolved).toHaveLength(asked);
    expect(h.status(card)).toBe('plate.part.js is not the model on screen, so nothing is highlighted.');
    expect(h.chips(card)).toEqual(['red:[1] the mounting face(idle)', 'blue:[2] this edge(idle)']);
    // Back on its own file, it points again.
    h.host.onScreen = '/w/plate.part.js';
    await h.host.render();
    expect(h.status(card)).toBeNull();
    expect(h.host.drawn).toHaveLength(2);
  });

  it('lets go of the highlight when the panel closes or another chat comes on screen', async () => {
    const h = await mount();
    await h.arrives(showPart());
    expect(h.host.drawn).toHaveLength(2);
    h.panel.close();
    expect(h.host.drawn).toEqual([]);
    h.panel.show();
    await settle();
    const [card] = h.cards();
    expect(card.dataset.shown).toBe('false');
    h.toggle(card).click();
    await settle();
    expect(h.host.drawn).toHaveLength(2);

    h.client.addSession({ id: 'other', title: 'Another chat' });
    await h.panel.state.openSession('other');
    await settle();
    expect(h.host.drawn).toEqual([]);
    // And a render after that draws nothing of the chat that is gone.
    const draws = h.host.draws.length;
    await h.host.render();
    expect(h.host.draws).toHaveLength(draws);
  });

  it('shows the agent\'s label and note as text, never as markup', async () => {
    const hostile = '<img src=x onerror="window.__shown = true"><b>face</b>';
    const h = await mount();
    await h.arrives(showPart({ note: hostile, items: [{ n: 1, color: 'red', label: hostile, target: TOP, faces: 1, edges: 0 }] }));
    const [card] = h.cards();
    expect(card.querySelector('[data-ref="show-label"]')!.textContent).toBe(`[1] ${hostile}`);
    expect(card.querySelector('[data-ref="show-note"]')!.textContent).toBe(hostile);
    expect(card.querySelectorAll('img, b')).toHaveLength(0);
    expect((window as any).__shown).toBeUndefined();
  });

  it('lists its items without a control on a page with no viewport to point in', async () => {
    const h = await mount([showPart()], null);
    const [card] = h.cards();
    expect(card.querySelector('[data-ref="show-toggle"]')).toBeNull();
    expect(h.chips(card)).toEqual(['red:[1] the mounting face(idle)', 'blue:[2] this edge(idle)']);
  });
});

describe('resolving what a card points at', () => {
  it('asks api/resolve-selection for the selector or the pick, and keeps the faces and edges of the answer', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      bodies.push([url, JSON.parse(String(init.body))]);
      return new Response(JSON.stringify({
        ok: true,
        matches: [
          { shapeId: 'sh-1', kind: 'face', index: 5, sceneObjectId: 'ex-1', summary: {} },
          { shapeId: 'sh-1', kind: 'vertex', index: 0 },
          { shapeId: 'sh-1', kind: 'edge', index: 2, instanceId: 'inst-1', pose: {} },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    expect(await httpTargetResolver({ expression: 'face()', scope: { part: 'Lid' } })).toEqual({
      ok: true,
      refs: [{ shapeId: 'sh-1', kind: 'face', index: 5 }, { shapeId: 'sh-1', kind: 'edge', index: 2, instanceId: 'inst-1' }],
    });
    await httpTargetResolver(EDGE);
    expect(bodies).toEqual([
      ['api/resolve-selection', { expression: 'face()', scope: { part: 'Lid' } }],
      ['api/resolve-selection', { picks: [{ shapeId: 'sh-1', kind: 'edge', index: 4 }] }],
    ]);
  });

  it('gives the engine\'s reason when it refuses, and says so when it cannot be asked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'No solid "sh-1" in the scene.', code: 'unresolved-pick' }), { status: 404 })));
    expect(await httpTargetResolver(EDGE)).toEqual({ ok: false, reason: 'No solid "sh-1" in the scene.' });
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    expect(await httpTargetResolver(EDGE)).toEqual({ ok: false, reason: 'It could not be resolved: offline' });
    expect(readRefs([null, { shapeId: 7, kind: 'face', index: 0 }, { shapeId: 's', kind: 'face', index: 1.5 }, { shapeId: 's', kind: 'face', index: 1 }])).toEqual([{ shapeId: 's', kind: 'face', index: 1 }]);
  });
});

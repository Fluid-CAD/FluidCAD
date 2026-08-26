// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnimateBar, type AnimateBarHost } from '../src/ui/animate-bar';

// Playback semantics: Single stops at End; Loop restarts from Start after
// the End frame; Reciprocate bounces start→end→start. Frames are pumped
// through a stubbed rAF with explicit timestamps (one step per 40ms+).

type Harness = {
  bar: AnimateBar;
  driven: number[];
  settle: ReturnType<typeof vi.fn>;
  pump: (frames: number) => void;
  el: (ref: string) => HTMLElement;
};

let rafCb: FrameRequestCallback | null;
let now: number;

function mount(): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const driven: number[] = [];
  const settle = vi.fn();
  const host: AnimateBarHost = {
    getMateDriveState: () => ({ kind: 'angle', value: 0 }),
    driveMateValue: (_id, value) => {
      driven.push(value);
      return true;
    },
    settle,
  };
  const bar = new AnimateBar(container, host, () => {});
  bar.open({ mateId: 'm1', label: 'revolute · A ↔ B', kind: 'angle' });
  const el = (ref: string) => container.querySelector<HTMLElement>(`[data-ref="${ref}"]`)!;
  (el('start') as HTMLInputElement).value = '0';
  (el('end') as HTMLInputElement).value = '90';
  (el('steps') as HTMLInputElement).value = '3';
  // Advance time past the step interval, then deliver one animation frame.
  const pump = (frames: number) => {
    for (let i = 0; i < frames; i += 1) {
      now += 50;
      const cb = rafCb;
      rafCb = null;
      cb?.(now);
    }
  };
  return { bar, driven, settle, pump, el };
}

beforeEach(() => {
  rafCb = null;
  now = 1000;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    rafCb = cb;
    return 1;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => { rafCb = null; });
  vi.spyOn(performance, 'now').mockImplementation(() => now);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('animate bar playback', () => {
  it('single: sweeps start→end once and stops', () => {
    const { driven, settle, pump, el } = mount();
    el('play').click();
    pump(6);
    expect(driven).toEqual([0, 30, 60, 90]);
    expect(el('play').title).toBe('Play'); // auto-paused at End
    expect(settle).toHaveBeenCalled();
  });

  it('loop: restarts from Start after the End frame', () => {
    const { driven, pump, el } = mount();
    (el('playback') as HTMLSelectElement).value = 'loop';
    el('play').click();
    pump(8);
    expect(driven).toEqual([0, 30, 60, 90, 0, 30, 60, 90, 0]);
    expect(el('play').title).toBe('Pause'); // still running
  });

  it('reciprocate: bounces at both ends', () => {
    const { driven, pump, el } = mount();
    (el('playback') as HTMLSelectElement).value = 'reciprocate';
    el('play').click();
    pump(8);
    expect(driven).toEqual([0, 30, 60, 90, 60, 30, 0, 30, 60]);
  });

  it('stop: halts and drives back to the value at open', () => {
    const { driven, settle, pump, el } = mount();
    (el('playback') as HTMLSelectElement).value = 'loop';
    el('play').click();
    pump(2);
    el('stop').click();
    expect(driven[driven.length - 1]).toBe(0); // restValue captured at open
    expect(el('play').title).toBe('Play');
    expect(settle).toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { RangeTrack } from '../../src/ui/controls';

// The range track: a thumb between two ends that may claim no value.

describe('RangeTrack', () => {
  it('is a daisyUI range over its ends and step, claiming no value until given one', () => {
    const track = new RangeTrack({ min: 1, max: 50, step: 0.5 });
    expect(track.element.type).toBe('range');
    expect(track.element.className).toContain('range range-xs range-primary');
    expect([track.element.min, track.element.max, track.element.step]).toEqual(['1', '50', '0.5']);
    expect(track.value).toBeUndefined();
    expect(track.element.dataset.unset).toBe('true');
    expect(track.element.classList.contains('opacity-40')).toBe(true);
  });

  it('places the thumb silently, clamped to the ends, and gives the value up again', () => {
    const track = new RangeTrack({ min: 1, max: 50, step: 1, value: 10 });
    const heard: number[] = [];
    track.onInput = value => heard.push(value);
    expect(track.value).toBe(10);
    track.setValue(80);
    expect(track.value).toBe(50);
    expect(track.element.value).toBe('50');
    track.setValue(-3);
    expect(track.value).toBe(1);
    expect(track.element.dataset.unset).toBe('false');
    track.setValue(undefined);
    expect(track.value).toBeUndefined();
    expect(track.element.classList.contains('opacity-40')).toBe(true);
    expect(heard).toEqual([]);
  });

  it('reports a drag, which gives a track without a value one', () => {
    const track = new RangeTrack({ min: 1, max: 50, step: 1 });
    const heard: number[] = [];
    track.onInput = value => heard.push(value);
    track.element.value = '12';
    track.element.dispatchEvent(new Event('input'));
    expect(heard).toEqual([12]);
    expect(track.value).toBe(12);
    expect(track.element.dataset.unset).toBe('false');
  });

  it('can be disabled', () => {
    const track = new RangeTrack({ min: 0, max: 1, step: 0.1, value: 0 });
    track.setEnabled(false);
    expect(track.element.disabled).toBe(true);
    track.setEnabled(true);
    expect(track.element.disabled).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { SketchUISuspender } from '../src/interactive/create-feature/sketch-suspender';
import type { Viewer } from '../src/viewer';

/** The three viewer calls the suspender makes, recorded in order. */
function stubViewer(missedSketchRender: boolean) {
  const calls: string[] = [];
  const viewer = {
    missedSketchRender,
    suspendSketchEditing: () => { calls.push('suspend'); },
    resumeSketchEditing: (immediate: boolean) => { calls.push(`resume:${immediate}`); },
  };
  return { viewer: viewer as unknown as Viewer, calls };
}

function makeSuspender(missedSketchRender = false) {
  const { viewer, calls } = stubViewer(missedSketchRender);
  const suspender = new SketchUISuspender(viewer, {
    onSuspendSketchUI: () => { calls.push('ui:suspend'); },
    onResumeSketchUI: () => { calls.push('ui:resume'); },
  });
  return { suspender, calls };
}

describe('SketchUISuspender', () => {
  it('suspends once and resumes lazily, leaving the UI to the next render', () => {
    const { suspender, calls } = makeSuspender();
    suspender.suspend();
    suspender.suspend();
    expect(suspender.suspended).toBe(true);
    suspender.resume(false);
    expect(suspender.suspended).toBe(false);
    expect(calls).toEqual(['suspend', 'ui:suspend', 'resume:false']);
  });

  it('an immediate resume restores the sketch view and its toolbar now', () => {
    const { suspender, calls } = makeSuspender();
    suspender.suspend();
    suspender.resume(true);
    expect(calls).toEqual(['suspend', 'ui:suspend', 'resume:true', 'ui:resume']);
  });

  // The apply's render and the apply's response race: when the render wins, it
  // draws the scene with sketch editing still suspended and no later render is
  // coming, so a lazy resume has to behave like an immediate one.
  it('a lazy resume upgrades to immediate when the render it waited for already landed', () => {
    const { suspender, calls } = makeSuspender(true);
    suspender.suspend();
    suspender.resume(false);
    expect(calls).toEqual(['suspend', 'ui:suspend', 'resume:true', 'ui:resume']);
  });

  it('resuming without a suspension does nothing', () => {
    const { suspender, calls } = makeSuspender(true);
    suspender.resume(true);
    expect(calls).toEqual([]);
  });
});

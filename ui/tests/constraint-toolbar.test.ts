// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { SegmentConversionsResponse } from '../src/api';
import { ConstraintToolbar } from '../src/interactive/constraint-toolbar/constraint-toolbar';
import { ConstraintToolbarService } from '../src/interactive/constraint-toolbar/constraint-toolbar-service';

const LABELS = ['H-Line', 'V-Line', 'T-Line', 'A-Line', 'T-Arc', 'Free'];

function buttonsOf(container: HTMLElement): Map<string, HTMLButtonElement> {
  const result = new Map<string, HTMLButtonElement>();
  for (const btn of container.querySelectorAll('button')) {
    result.set(btn.textContent!, btn);
  }
  return result;
}

function tooltipOf(btn: HTMLButtonElement): string {
  return btn.parentElement!.querySelector('div')!.textContent!;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('ConstraintToolbar view', () => {
  it('renders all buttons disabled with the neutral tooltip for null options', () => {
    const container = document.createElement('div');
    const view = new ConstraintToolbar(container);
    view.setOptions(null);

    const buttons = buttonsOf(container);
    expect([...buttons.keys()]).toEqual(LABELS);
    for (const label of LABELS) {
      expect(buttons.get(label)!.disabled).toBe(true);
      expect(tooltipOf(buttons.get(label)!)).toBe('Select a chained segment to convert it');
    }
  });

  it('enables per option, tooltips the reason on disabled ones', () => {
    const container = document.createElement('div');
    const view = new ConstraintToolbar(container);
    view.setOptions([
      { target: 'aLine', enabled: true, newStatement: 'aLine(45, 141.42)' },
      { target: 'hLine', enabled: false, reason: 'the segment is 40° off horizontal' },
      { target: 'free', enabled: true, newStatement: 'line(100, 100)' },
    ]);

    const buttons = buttonsOf(container);
    expect(buttons.get('A-Line')!.disabled).toBe(false);
    expect(tooltipOf(buttons.get('A-Line')!)).toBe('Convert to A-Line');
    expect(buttons.get('Free')!.disabled).toBe(false);
    expect(buttons.get('H-Line')!.disabled).toBe(true);
    expect(tooltipOf(buttons.get('H-Line')!)).toBe('the segment is 40° off horizontal');
    // Targets absent from the options list are simply not offered.
    expect(buttons.get('T-Arc')!.disabled).toBe(true);
    expect(tooltipOf(buttons.get('T-Arc')!)).toBe('Not available for this segment');
  });

  it('warns about a non-trivial endpoint move in the tooltip', () => {
    const container = document.createElement('div');
    const view = new ConstraintToolbar(container);
    view.setOptions([
      { target: 'hLine', enabled: true, newStatement: 'hline(100)', endpointDelta: 3.5 },
      { target: 'vLine', enabled: true, newStatement: 'vline(100)', endpointDelta: 0 },
    ]);

    const buttons = buttonsOf(container);
    expect(tooltipOf(buttons.get('H-Line')!)).toBe('Convert to H-Line — moves endpoint by ~3.50 mm');
    expect(tooltipOf(buttons.get('V-Line')!)).toBe('Convert to V-Line');
  });

  it('fires onConvert with the clicked target, never from disabled buttons', () => {
    const container = document.createElement('div');
    const view = new ConstraintToolbar(container);
    const converted: string[] = [];
    view.onConvert = (target) => converted.push(target);
    view.setOptions([
      { target: 'aLine', enabled: true, newStatement: 'aLine(45, 141.42)' },
      { target: 'hLine', enabled: false, reason: 'too steep' },
    ]);

    const buttons = buttonsOf(container);
    buttons.get('A-Line')!.click();
    buttons.get('H-Line')!.click();
    buttons.get('T-Arc')!.click();
    expect(converted).toEqual(['aLine']);
  });
});

type FakeApi = {
  fetchSegmentConversions: ReturnType<typeof vi.fn>;
  convertSegment: ReturnType<typeof vi.fn>;
};

function makeService(api: FakeApi): {
  service: ConstraintToolbarService;
  container: HTMLElement;
  messages: string[];
} {
  const container = document.createElement('div');
  const messages: string[] = [];
  const service = new ConstraintToolbarService(container, (m) => messages.push(m), api as any);
  return { service, container, messages };
}

function handlerWith(ids: string[]): any {
  return {
    selectedIds: new Set(ids),
    selectShape: vi.fn(),
  };
}

const A_LINE_RESPONSE: SegmentConversionsResponse = {
  ok: true,
  currentKind: 'line-two-points',
  sourceLocation: { filePath: '/w/a.fluid.js', line: 7, column: 3 },
  options: [{ target: 'aLine', enabled: true, newStatement: 'aLine(45, 141.42)' }],
  expectedStatement: 'line(100, 100)',
};

describe('ConstraintToolbarService', () => {
  it('fetches options for a single selection and renders them', async () => {
    const api: FakeApi = {
      fetchSegmentConversions: vi.fn().mockResolvedValue(A_LINE_RESPONSE),
      convertSegment: vi.fn(),
    };
    const { service, container } = makeService(api);

    service.selectionChanged(handlerWith(['s1']));
    await flushMicrotasks();

    expect(api.fetchSegmentConversions).toHaveBeenCalledWith('s1');
    expect(buttonsOf(container).get('A-Line')!.disabled).toBe(false);
  });

  it('disables everything for empty and multi selections without fetching', () => {
    const api: FakeApi = {
      fetchSegmentConversions: vi.fn(),
      convertSegment: vi.fn(),
    };
    const { service, container } = makeService(api);

    service.selectionChanged(handlerWith([]));
    service.selectionChanged(handlerWith(['s1', 's2']));
    service.selectionChanged(null);

    expect(api.fetchSegmentConversions).not.toHaveBeenCalled();
    expect(buttonsOf(container).get('A-Line')!.disabled).toBe(true);
  });

  it('surfaces a refusal (ok: false) as the shared disabled tooltip', async () => {
    const api: FakeApi = {
      fetchSegmentConversions: vi.fn().mockResolvedValue({
        ok: false, reason: 'only chained segments can be converted',
      }),
      convertSegment: vi.fn(),
    };
    const { service, container } = makeService(api);

    service.selectionChanged(handlerWith(['s1']));
    await flushMicrotasks();

    const buttons = buttonsOf(container);
    expect(buttons.get('A-Line')!.disabled).toBe(true);
    expect(tooltipOf(buttons.get('A-Line')!)).toBe('Only chained segments can be converted');
  });

  it('ignores a stale fetch response', async () => {
    let resolveFirst!: (r: SegmentConversionsResponse) => void;
    const api: FakeApi = {
      fetchSegmentConversions: vi.fn()
        .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
        .mockResolvedValueOnce({ ok: true, options: [], expectedStatement: 'x', sourceLocation: { filePath: 'f', line: 1, column: 0 } }),
      convertSegment: vi.fn(),
    };
    const { service, container } = makeService(api);

    service.selectionChanged(handlerWith(['s1']));
    service.selectionChanged(handlerWith(['s2']));
    await flushMicrotasks();

    // The slow first response lands after the second selection: dropped.
    resolveFirst(A_LINE_RESPONSE);
    await flushMicrotasks();

    expect(buttonsOf(container).get('A-Line')!.disabled).toBe(true);
  });

  it('applies a conversion and blocks re-entrant clicks while busy', async () => {
    let resolveConvert!: (r: { success: boolean }) => void;
    const api: FakeApi = {
      fetchSegmentConversions: vi.fn().mockResolvedValue(A_LINE_RESPONSE),
      convertSegment: vi.fn().mockImplementation(() => new Promise((r) => { resolveConvert = r; })),
    };
    const { service, container } = makeService(api);

    service.selectionChanged(handlerWith(['s1']));
    await flushMicrotasks();

    const aLine = buttonsOf(container).get('A-Line')!;
    aLine.click();
    aLine.click();
    await flushMicrotasks();

    expect(api.convertSegment).toHaveBeenCalledTimes(1);
    expect(api.convertSegment).toHaveBeenCalledWith('s1', 'aLine', 'line(100, 100)');

    resolveConvert({ success: true });
    await flushMicrotasks();
  });

  it('surfaces an apply refusal through the toast callback', async () => {
    const api: FakeApi = {
      fetchSegmentConversions: vi.fn().mockResolvedValue(A_LINE_RESPONSE),
      convertSegment: vi.fn().mockResolvedValue({ success: false, reason: 'the statement changed' }),
    };
    const { service, container, messages } = makeService(api);

    service.selectionChanged(handlerWith(['s1']));
    await flushMicrotasks();
    buttonsOf(container).get('A-Line')!.click();
    await flushMicrotasks();

    expect(messages).toEqual(['the statement changed']);
  });

  it('re-selects the converted segment by statement line on the next update', async () => {
    const api: FakeApi = {
      fetchSegmentConversions: vi.fn().mockResolvedValue(A_LINE_RESPONSE),
      convertSegment: vi.fn().mockResolvedValue({ success: true, newStatement: 'aLine(45, 141.42)' }),
    };
    const { service, container } = makeService(api);

    service.selectionChanged(handlerWith(['s1']));
    await flushMicrotasks();
    buttonsOf(container).get('A-Line')!.click();
    await flushMicrotasks();

    // The re-render arrives with all-new ids; the segment at line 7 is now s9.
    const handler = handlerWith([]);
    const sceneObjects: any[] = [
      {
        parentId: 'sk1',
        sourceLocation: { filePath: '/w/a.fluid.js', line: 7, column: 3 },
        sceneShapes: [
          { shapeId: 'meta', isMetaShape: true, meshes: [] },
          { shapeId: 's9', meshes: [] },
        ],
      },
    ];
    service.sketchUpdated(sceneObjects, 'sk1', handler);
    expect(handler.selectShape).toHaveBeenCalledWith('s9');

    // One-shot: the following update must not re-select again.
    handler.selectShape.mockClear();
    service.sketchUpdated(sceneObjects, 'sk1', handler);
    expect(handler.selectShape).not.toHaveBeenCalled();
  });
});

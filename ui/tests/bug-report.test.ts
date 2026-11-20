// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BugReport, BugReportEnvironment, type BugReportDraft } from '../src/ui/bug-report/bug-report';
import { BugReportPanel, type BugReportFile } from '../src/ui/bug-report/bug-report-panel';
import { LeftSlot } from '../src/ui/left-slot';
import type { DeliveryResult } from '../src/desktop';
import { settle } from './fixtures/fake-packages-client';

// The bug report: what the GitHub link carries (a title and a text, never a
// picture or a file), and the panel that hands the rest to the user — the
// screenshot on the clipboard, the ticked files in one saved zip — and says
// so before and after.

const draft = (over: Partial<BugReportDraft> = {}): BugReportDraft => ({
  title: 'Fillet fails',
  description: 'It breaks.',
  screenshots: 0,
  files: [],
  environment: [],
  ...over,
});

describe('the issue a report turns into', () => {
  it('carries the description alone when nothing else goes with it', () => {
    expect(BugReport.body(draft())).toBe('It breaks.');
  });

  it('asks for the screenshot and the archive by name, and lists the environment', () => {
    const body = BugReport.body(draft({
      screenshots: 1,
      files: ['box.part.js', 'lib/util.js'],
      environment: ['FluidCAD 1.2.3', 'In a browser'],
    }));
    expect(body).toBe([
      'It breaks.',
      '### Screenshot\n\n_Paste or drop the screenshot here._',
      '### Files\n\n_Drop `fluidcad-bug-report.zip` here._ It holds `box.part.js` and `lib/util.js`.',
      '### Environment\n\n- FluidCAD 1.2.3\n- In a browser',
    ].join('\n\n'));
  });

  it('asks for several screenshots by their count', () => {
    expect(BugReport.body(draft({ screenshots: 3 })))
      .toBe('It breaks.\n\n### Screenshots\n\n_Paste or drop the 3 screenshots here._');
    expect(BugReport.screenshotName(0, 1)).toBe('fluidcad-bug-report.png');
    expect(BugReport.screenshotName(1, 3)).toBe('fluidcad-bug-report-2.png');
  });

  it('counts the files past the first twelve rather than naming them', () => {
    const files = Array.from({ length: 15 }, (_, i) => `f${i}.js`);
    expect(BugReport.body(draft({ files }))).toContain('`f11.js` and 3 more.');
  });

  it('opens the new-issue page with the title and the text in the query', () => {
    const url = new URL(BugReport.url(draft({ title: '  Fillet & chamfer  ', description: 'a\nb' })));
    expect(url.origin + url.pathname).toBe('https://github.com/Fluid-CAD/FluidCAD/issues/new');
    expect(url.searchParams.get('title')).toBe('Fillet & chamfer');
    expect(url.searchParams.get('body')).toBe('a\nb');
  });

  it('measures a text too long for a link', () => {
    expect(BugReport.overflow(draft())).toBe(0);
    expect(BugReport.overflow(draft({ description: 'x'.repeat(9000) }))).toBeGreaterThan(1000);
  });

  it('names where the page runs', () => {
    const base = { version: '1.2.3', desktopPlatform: null, framed: false, userAgent: 'UA' };
    expect(BugReportEnvironment.lines(base)).toEqual(['FluidCAD 1.2.3', 'In a browser', 'UA']);
    expect(BugReportEnvironment.lines({ ...base, desktopPlatform: 'darwin' })[1]).toBe('Desktop app on macOS');
    expect(BugReportEnvironment.lines({ ...base, framed: true, version: null }).slice(0, 2))
      .toEqual(['FluidCAD (version unknown)', 'In an editor (VS Code webview)']);
  });
});

const panels: BugReportPanel[] = [];

afterEach(() => {
  for (const panel of panels.splice(0)) {
    panel.destroy();
  }
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty('--fluidcad-editor-width');
  document.body.innerHTML = '';
});

const FILES: BugReportFile[] = [
  { path: 'lib/util.js', absPath: '/w/lib/util.js', size: 300 },
  { path: 'box.part.js', absPath: '/w/box.part.js', size: 1200 },
];

function mount(options: { copy?: boolean; deliver?: DeliveryResult } = {}) {
  vi.stubGlobal('innerWidth', 1440);
  URL.createObjectURL ??= () => 'blob:shot';
  URL.revokeObjectURL ??= () => undefined;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const calls: string[] = [];
  let captured = 0;
  const archived: string[][] = [];
  const opened: string[] = [];
  const panel = new BugReportPanel({
    container,
    slot: new LeftSlot({ width: 420 }),
    listFiles: async () => FILES,
    readFile: async (file) => new Blob([file.path]),
    currentFile: () => '/w/box.part.js',
    capture: async () => new Blob([`shot${++captured}`], { type: 'image/png' }),
    environment: async () => ['FluidCAD 1.2.3'],
    copyImage: async (image) => {
      calls.push(`copy ${await image.text()}`);
      return options.copy ?? true;
    },
    archive: async (files) => {
      archived.push(files.map((file) => file.fileName));
      return new Blob(['zip']);
    },
    deliver: async (_blob, name) => {
      calls.push(`deliver ${name}`);
      return options.deliver ?? 'downloaded';
    },
    openExternal: (url) => {
      calls.push('open');
      opened.push(url);
    },
  });
  panels.push(panel);
  const $ = <T extends HTMLElement = HTMLElement>(ref: string) => panel.el.querySelector<T>(`[data-ref="${ref}"]`)!;
  const type = (ref: string, value: string) => {
    const field = $<HTMLInputElement>(ref);
    field.value = value;
    field.dispatchEvent(new Event('input'));
  };
  const tick = (path: string) => {
    const box = panel.el.querySelector<HTMLInputElement>(`[data-file="${path}"] input`)!;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
  };
  const body = () => new URL(opened[opened.length - 1]).searchParams.get('body');
  return { panel, calls, archived, opened, $, type, tick, body };
}

describe('the bug report panel', () => {
  it('lists the project files with the open one first and none ticked', async () => {
    const h = mount();
    h.panel.show();
    await settle();
    const rows = [...h.$('files').querySelectorAll<HTMLElement>('[data-file]')];
    expect(rows.map((row) => row.dataset.file)).toEqual(['box.part.js', 'lib/util.js']);
    expect(rows[0].textContent).toContain('open');
    expect(rows.every((row) => !row.querySelector('input')!.checked)).toBe(true);
    expect(h.$('files-count').textContent).toBe('None ticked');
    expect(h.panel.draft.files).toEqual([]);
  });

  it('shows the issue text as the link will carry it', async () => {
    const h = mount();
    h.panel.show();
    await settle();
    h.type('title', 'Fillet fails');
    h.type('description', 'It breaks.');
    h.tick('box.part.js');
    expect(h.$('preview').textContent).toBe(`Fillet fails\n\n${BugReport.body(h.panel.draft)}`);
    expect(h.$('preview').textContent).toContain('`box.part.js`');
    expect(h.$('files-count').textContent).toBe('1 ticked, 1.2 kB');
    // The environment can be left out, and the text says what is left.
    const environment = h.$<HTMLInputElement>('environment');
    environment.checked = false;
    environment.dispatchEvent(new Event('change'));
    expect(h.$('preview').textContent).not.toContain('FluidCAD 1.2.3');
  });

  it('refuses a report with no title, and opens nothing', async () => {
    const h = mount();
    h.panel.show();
    await settle();
    await h.panel.submit();
    expect(h.$('notice').textContent).toBe('Give the report a title.');
    expect(h.calls).toEqual([]);
  });

  it('stops a text too long for a link before the click', async () => {
    const h = mount();
    h.panel.show();
    await settle();
    h.type('title', 'Long');
    h.type('description', 'x'.repeat(9000));
    expect(h.$<HTMLButtonElement>('submit').disabled).toBe(true);
    expect(h.$('notice').textContent).toContain('too long for a GitHub link');
    h.type('description', 'short');
    expect(h.$<HTMLButtonElement>('submit').disabled).toBe(false);
    expect(h.$('notice').classList.contains('hidden')).toBe(true);
  });

  it('copies the screenshot, saves the ticked files, then opens GitHub and says what is left', async () => {
    const h = mount();
    h.panel.show();
    await settle();
    h.type('title', 'Fillet fails');
    await h.panel.captureScreenshot();
    expect(h.$('screenshots').querySelectorAll('img')).toHaveLength(1);
    h.tick('lib/util.js');
    await h.panel.submit();
    expect(h.calls).toEqual(['copy shot1', 'deliver fluidcad-bug-report.zip', 'open']);
    expect(h.archived).toEqual([['lib/util.js']]);
    expect(h.body()).toContain('### Screenshot');
    expect(h.body()).toContain('It holds `lib/util.js`.');
    expect(h.$('form').classList.contains('hidden')).toBe(true);
    const done = h.$('done').textContent!;
    expect(done).toContain('The screenshot is on the clipboard');
    expect(done).toContain('The file you ticked is in fluidcad-bug-report.zip');
    // Back to the report keeps the draft; a new report empties it.
    h.$('back').click();
    expect(h.$<HTMLInputElement>('title').value).toBe('Fillet fails');
    await h.panel.submit();
    h.$('new-report').click();
    expect(h.$<HTMLInputElement>('title').value).toBe('');
    expect(h.panel.draft).toMatchObject({ screenshots: 0, files: [] });
  });

  it('opens nothing when the files were not saved', async () => {
    const h = mount({ deliver: 'cancelled' });
    h.panel.show();
    await settle();
    h.type('title', 'Fillet fails');
    h.tick('box.part.js');
    await h.panel.submit();
    expect(h.calls).toEqual(['deliver fluidcad-bug-report.zip']);
    expect(h.$('notice').textContent).toContain('nothing was opened');
    expect(h.$('done').classList.contains('hidden')).toBe(true);
  });

  it('saves the screenshot as a file when the clipboard refuses it', async () => {
    const h = mount({ copy: false });
    h.panel.show();
    await settle();
    h.type('title', 'Fillet fails');
    await h.panel.captureScreenshot();
    await h.panel.submit();
    expect(h.calls).toEqual(['copy shot1', 'deliver fluidcad-bug-report.png', 'open']);
    expect(h.$('done').textContent).toContain('saved as fluidcad-bug-report.png');
  });

  it('takes several screenshots, copies the first, and hands the others over one at a time', async () => {
    const h = mount();
    h.panel.show();
    await settle();
    h.type('title', 'Fillet fails');
    await h.panel.captureScreenshot();
    await h.panel.captureScreenshot();
    await h.panel.captureScreenshot();
    expect(h.$('screenshots').querySelectorAll('img')).toHaveLength(3);
    expect(h.$('capture').textContent!.trim()).toBe('Capture another');
    // The second one goes: the third takes its place.
    h.$('screenshots').querySelectorAll<HTMLElement>('[data-ref="remove-screenshot"]')[1].click();
    expect(h.panel.draft.screenshots).toBe(2);
    expect(h.$('preview').textContent).toContain('_Paste or drop the 2 screenshots here._');

    await h.panel.submit();
    expect(h.calls).toEqual(['copy shot1', 'open']);
    const rows = () => [...h.$('handed-screenshots').querySelectorAll<HTMLElement>('[data-shot]')];
    expect(rows().map((row) => row.textContent)).toEqual([
      'Screenshot 1On the clipboardCopy againSave',
      'Screenshot 2CopySave',
    ]);
    expect(h.$('done').textContent).toContain('Screenshot 1 is on it now');
    // Copying the next one moves the clipboard to it.
    rows()[1].querySelector<HTMLElement>('[data-ref="copy-screenshot"]')!.click();
    await settle();
    expect(h.calls).toEqual(['copy shot1', 'open', 'copy shot3']);
    expect(rows().map((row) => row.textContent)).toEqual([
      'Screenshot 1CopySave',
      'Screenshot 2On the clipboardCopy againSave',
    ]);
    expect(h.$('done').textContent).toContain('Screenshot 2 is on it now');
  });

  it('saves every screenshot as a numbered file when the clipboard refuses them', async () => {
    const h = mount({ copy: false });
    h.panel.show();
    await settle();
    h.type('title', 'Fillet fails');
    await h.panel.captureScreenshot();
    await h.panel.captureScreenshot();
    await h.panel.submit();
    expect(h.calls).toEqual(['copy shot1', 'deliver fluidcad-bug-report-1.png', 'deliver fluidcad-bug-report-2.png', 'open']);
    expect(h.$('done').textContent).toContain('they were saved as files');
  });

  it('pictures the whole window in the desktop app, stepping out of the way for it', async () => {
    const h = mount();
    const seen: string[] = [];
    const deps = (h.panel as unknown as { deps: Record<string, unknown> }).deps;
    deps.layoutSettled = async () => { seen.push(`settled, panel ${h.panel.isOpen() ? 'open' : 'closed'}`); };
    deps.captureWindow = async () => {
      seen.push(`window, panel ${h.panel.isOpen() ? 'open' : 'closed'}`);
      return new Blob(['window'], { type: 'image/png' });
    };
    h.panel.show();
    await settle();
    expect(h.$('capture').textContent!.trim()).toBe('Capture the scene');
    await h.panel.captureScreenshot();
    expect(seen).toEqual(['settled, panel closed', 'window, panel closed']);
    expect(h.panel.isOpen()).toBe(true);
    h.type('title', 'Fillet fails');
    await h.panel.submit();
    expect(h.calls).toEqual(['copy window', 'open']);
    // A window that could not be pictured falls back to the scene.
    deps.captureWindow = async () => null;
    h.$('back').click();
    await h.panel.captureScreenshot();
    await h.panel.submit();
    expect(h.calls.slice(2)).toEqual(['copy window', 'open']);
    expect(h.panel.draft.screenshots).toBe(2);
  });

  it('stops at eight screenshots', async () => {
    const h = mount();
    h.panel.show();
    await settle();
    for (let i = 0; i < 10; i++) {
      await h.panel.captureScreenshot();
    }
    expect(h.panel.draft.screenshots).toBe(8);
    expect(h.$<HTMLButtonElement>('capture').disabled).toBe(true);
  });

  it('ticks every file from the All box', async () => {
    const h = mount();
    h.panel.show();
    await settle();
    const all = h.$<HTMLInputElement>('all-files');
    all.checked = true;
    all.dispatchEvent(new Event('change'));
    expect(h.panel.draft.files).toEqual(['box.part.js', 'lib/util.js']);
    expect(h.$('files-count').textContent).toBe('2 ticked, 1.5 kB');
  });
});

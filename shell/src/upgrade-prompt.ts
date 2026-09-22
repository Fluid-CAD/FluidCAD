import { EngineUpgrade, type UpgradeCandidate } from './engine-upgrade';
import type { UpgradeDiff } from './engine/upgrade-diff';
import type { ProjectWindow } from './project-window';
import { rememberUpgradeChoice } from './state';

/**
 * The prompt a project window shows when the app carries a newer engine than
 * the project pins: a small card at the bottom of the viewport, injected into
 * the live engine page the way the crash banner is. Injected rather than a
 * second window because the answer belongs next to the model it is about —
 * and never a navigation, so nothing in the editor is disturbed.
 *
 * Every button routes back here through `window.fluidcadDesktop.engineUpgrade`
 * — the page itself decides nothing about engines; it is only the surface
 * the shell draws on.
 */

export type UpgradeChoice = 'upgrade' | 'preview' | 'keep' | 'never' | 'dismiss';

type PanelState =
  | { phase: 'ask'; from: string; to: string }
  | { phase: 'working'; from: string; to: string; message: string }
  | { phase: 'diff'; from: string; to: string; diff: UpgradeDiff }
  | { phase: 'error'; from: string; to: string; message: string };

export type UpgradePromptDeps = {
  openProject: (target: string) => Promise<unknown>;
};

export class UpgradePrompt {
  private static deps: UpgradePromptDeps | null = null;

  private static readonly PANEL_ID = 'fluidcad-engine-upgrade';

  private candidate: UpgradeCandidate | null = null;
  private busy = false;

  constructor(private readonly window: ProjectWindow) {}

  /** Wired once from `main.ts`; `apply` reopens the project through it. */
  static configure(deps: UpgradePromptDeps): void {
    UpgradePrompt.deps = deps;
  }

  /** Show the prompt if this project has an upgrade it hasn't declined. */
  async offer(): Promise<void> {
    const candidate = EngineUpgrade.promptFor(this.window.workspacePath);
    if (!candidate) {
      return;
    }
    this.candidate = candidate;
    await this.render({ phase: 'ask', ...candidate });
  }

  async respond(choice: UpgradeChoice): Promise<void> {
    const candidate = this.candidate;
    if (!candidate || this.busy) {
      return;
    }
    switch (choice) {
      case 'dismiss': {
        this.candidate = null;
        await this.clear();
        return;
      }
      case 'keep': {
        rememberUpgradeChoice(this.window.workspacePath, { declinedUpgradeTo: candidate.to });
        this.candidate = null;
        await this.clear();
        return;
      }
      case 'never': {
        rememberUpgradeChoice(this.window.workspacePath, { muted: true });
        this.candidate = null;
        await this.clear();
        return;
      }
      case 'preview': {
        await this.preview(candidate);
        return;
      }
      case 'upgrade': {
        await this.upgrade(candidate);
        return;
      }
    }
  }

  private async preview(candidate: UpgradeCandidate): Promise<void> {
    this.busy = true;
    try {
      await this.render({ phase: 'working', ...candidate, message: 'Preparing…' });
      const result = await EngineUpgrade.preview(this.window.workspacePath, candidate.to, (message) => {
        if (message) {
          void this.render({ phase: 'working', ...candidate, message });
        }
      });
      if (result.diff) {
        await this.render({ phase: 'diff', ...candidate, diff: result.diff });
      } else {
        await this.render({ phase: 'error', ...candidate, message: result.error ?? 'The comparison failed.' });
      }
    } finally {
      this.busy = false;
    }
  }

  private async upgrade(candidate: UpgradeCandidate): Promise<void> {
    const deps = UpgradePrompt.deps;
    if (!deps) {
      return;
    }
    this.busy = true;
    await this.render({ phase: 'working', ...candidate, message: `Switching to engine ${candidate.to}…` });
    const result = await EngineUpgrade.apply(this.window.workspacePath, candidate.to, {
      openWindow: this.window,
      openProject: deps.openProject,
    });
    // On success this window is gone and the project is back up on the new
    // engine; only a failure has anything left to draw on.
    this.busy = false;
    if (!result.ok) {
      await this.render({ phase: 'error', ...candidate, message: result.error ?? 'The pin could not be changed.' });
    }
  }

  private async render(state: PanelState): Promise<void> {
    const browserWindow = this.window.browserWindow;
    if (browserWindow.isDestroyed()) {
      return;
    }
    try {
      await browserWindow.webContents.executeJavaScript(
        `(${UpgradePrompt.PANEL_SCRIPT})(${JSON.stringify(UpgradePrompt.PANEL_ID)}, ${JSON.stringify(state)});`,
      );
    } catch {
      // Mid-navigation; the start screen's engine dialog offers the same move.
    }
  }

  private async clear(): Promise<void> {
    const browserWindow = this.window.browserWindow;
    if (browserWindow.isDestroyed()) {
      return;
    }
    await browserWindow.webContents
      .executeJavaScript(`document.getElementById(${JSON.stringify(UpgradePrompt.PANEL_ID)})?.remove();`)
      .catch(() => undefined);
  }

  /**
   * Runs inside the engine page. Plain DOM, styles set through the CSSOM (an
   * inline `style` attribute would trip the page's CSP; `cssText` does not),
   * and re-entrant: every state change rebuilds the card in place.
   */
  private static readonly PANEL_SCRIPT = String.raw`(id, state) => {
    document.getElementById(id)?.remove();
    const bridge = window.fluidcadDesktop && window.fluidcadDesktop.engineUpgrade;
    const respond = (choice) => { if (bridge) { void bridge.respond(choice); } };

    const card = document.createElement('div');
    card.id = id;
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Engine update');
    card.style.cssText =
      'position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:2147483646;' +
      'width:min(560px,calc(100vw - 32px));max-height:min(60vh,520px);display:flex;flex-direction:column;' +
      'gap:10px;padding:14px 16px;border-radius:12px;background:#242424;color:#e7e7e7;' +
      'border:1px solid #ffffff2e;box-shadow:0 12px 32px #00000099;' +
      'font:400 13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;';

    const el = (tag, css, text) => {
      const node = document.createElement(tag);
      if (css) { node.style.cssText = css; }
      if (text !== undefined) { node.textContent = text; }
      return node;
    };
    const button = (label, choice, primary) => {
      const node = el('button', '', label);
      node.type = 'button';
      node.style.cssText =
        'font:600 12px/1 system-ui,-apple-system,"Segoe UI",sans-serif;padding:0 12px;height:30px;' +
        'border-radius:4px;cursor:pointer;white-space:nowrap;' +
        (primary
          ? 'background:#4a9eff;color:#fff;border:1px solid #4a9eff;'
          : 'background:transparent;color:#d4d4d4;border:1px solid #ffffff40;');
      node.onclick = () => {
        for (const other of card.querySelectorAll('button')) { other.disabled = true; }
        respond(choice);
      };
      return node;
    };
    const textButton = (label, choice) => {
      const node = el('button', '', label);
      node.type = 'button';
      node.style.cssText =
        'font:500 12px/1 system-ui,-apple-system,"Segoe UI",sans-serif;padding:0 6px;height:30px;' +
        'background:none;border:0;color:#9a9a9a;cursor:pointer;white-space:nowrap;text-decoration:underline;' +
        'text-underline-offset:2px;';
      node.onclick = () => respond(choice);
      return node;
    };

    const head = el('div', 'display:flex;align-items:baseline;gap:10px;');
    const title = el('div', 'font-weight:600;font-size:14px;flex:1;');
    head.appendChild(title);
    if (state.phase !== 'working') {
      const close = el('button', '', '✕');
      close.type = 'button';
      close.title = 'Not now';
      close.setAttribute('aria-label', 'Dismiss');
      close.style.cssText =
        'background:none;border:0;color:#9a9a9a;cursor:pointer;font:inherit;font-size:12px;' +
        'width:24px;height:24px;border-radius:6px;margin:-4px -6px 0 0;';
      close.onclick = () => respond('dismiss');
      head.appendChild(close);
    }
    card.appendChild(head);

    const body = el('div', 'color:#c9c9c9;');
    card.appendChild(body);
    const actions = el('div', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;');

    if (state.phase === 'ask') {
      title.textContent = 'Engine ' + state.to + ' is available';
      body.textContent =
        'This project is pinned to engine ' + state.from + '. Upgrading rebuilds it with ' + state.to +
        ' — you can compare the two first.';
      actions.append(
        button('Upgrade to ' + state.to, 'upgrade', true),
        button('Preview changes', 'preview', false),
        button('Keep ' + state.from, 'keep', false),
      );
      const spacer = el('span', 'flex:1;');
      actions.append(spacer, textButton("Don't ask again for this project", 'never'));
    } else if (state.phase === 'working') {
      title.textContent = 'Engine ' + state.from + ' → ' + state.to;
      body.textContent = state.message;
      body.style.color = '#9a9a9a';
    } else if (state.phase === 'error') {
      title.textContent = 'Engine ' + state.from + ' → ' + state.to;
      body.textContent = state.message;
      body.style.color = '#ff8b8b';
      body.style.whiteSpace = 'pre-wrap';
      actions.append(button('Close', 'dismiss', false));
    } else {
      const diff = state.diff;
      title.textContent = 'Engine ' + diff.from + ' → ' + diff.to;
      body.textContent = diff.identical
        ? 'Every model builds to identical geometry on engine ' + diff.to + '.'
        : 'Engine ' + diff.to + ' changes this project. Review before upgrading.';
      const list = el('div', 'overflow:auto;display:grid;gap:6px;-webkit-user-select:text;user-select:text;');
      const colors = { identical: '#7bd88f', changed: '#f7b955', broken: '#ff8b8b', fixed: '#7bd88f' };
      for (const model of diff.models) {
        const row = el('div', 'border:1px solid ' + colors[model.status] + '55;border-radius:8px;padding:7px 10px;');
        const line = el('div', 'display:flex;gap:8px;align-items:baseline;');
        line.append(
          el('span', 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;flex:1;word-break:break-all;', model.file),
          el('span', 'font-size:11px;color:' + colors[model.status] + ';', model.status),
        );
        row.appendChild(line);
        if (model.notes.length > 0) {
          const notes = el('ul', 'margin:4px 0 0;padding-left:18px;color:#9a9a9a;font-size:12px;');
          for (const note of model.notes) { notes.appendChild(el('li', '', note)); }
          row.appendChild(notes);
        }
        list.appendChild(row);
      }
      if (diff.skipped.length > 0) {
        list.appendChild(el('div', 'color:#9a9a9a;font-size:12px;',
          diff.skipped.length + ' more model(s) were not compared: ' + diff.skipped.join(', ')));
      }
      card.appendChild(list);
      actions.append(button('Upgrade to ' + diff.to, 'upgrade', true), button('Keep ' + diff.from, 'keep', false));
    }

    if (actions.childNodes.length > 0) { card.appendChild(actions); }
    document.body.appendChild(card);
  }`;
}

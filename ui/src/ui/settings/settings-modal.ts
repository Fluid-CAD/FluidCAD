import type { UserPreferences } from '../../api';
import { ICON_CLOSE } from '../icons';
import { AdvancedTab } from './advanced-tab';
import { AppearanceTab } from './appearance-tab';
import { EditorTab } from './editor-tab';
import type { SettingsContext, SettingsTab } from './settings-tab';
import { SketchTab } from './sketch-tab';
import { TimelineTab } from './timeline-tab';
import { UnitsTab } from './units-tab';

export interface SettingsModalHandlers {
  /** Persist one preference. */
  savePreference<K extends keyof UserPreferences>(key: K, value: UserPreferences[K]): void;
  /** Reset the whole file on the server; resolves to the defaults it now holds, or null when it failed. */
  resetPreferences(): Promise<UserPreferences | null>;
  /** Apply a full preference set to the page — the same routine the page runs at startup. */
  applyPreferences(prefs: UserPreferences): void;
}

const TAB_BTN = 'flex items-center gap-2 w-full text-left px-3 py-1.5 rounded text-[13px] whitespace-nowrap';
const TAB_BTN_IDLE = `${TAB_BTN} text-base-content/70 hover:bg-base-content/[0.08]`;
const TAB_BTN_ACTIVE = `${TAB_BTN} bg-primary/15 text-base-content font-medium`;
/** The unsaved-changes mark on a tab. */
const TAB_DOT = 'size-1.5 rounded-full bg-primary shrink-0';

/**
 * The Settings dialog: the global preferences, one vertical tab per area,
 * opened from the gear in the top bar. Each tab edits a draft; Save applies
 * every tab's draft to the app and persists it through the preferences
 * file, Cancel (or Escape, or the backdrop) drops the drafts. A tab with an
 * unsaved edit carries a dot so the change is visible from any tab.
 *
 * It is part of the page, not a window of its own: the same dialog serves
 * the browser, the VS Code host and the desktop app. Project settings are
 * not here — those belong to the project's own UI.
 */
export class SettingsModal {
  private readonly overlay: HTMLDivElement;
  private readonly tabButtons = new Map<string, HTMLButtonElement>();
  private readonly tabDots = new Map<string, HTMLSpanElement>();
  private readonly tabPanels = new Map<string, HTMLDivElement>();
  private readonly saveBtn: HTMLButtonElement;
  private readonly tabs: SettingsTab[];
  private activeId: string;
  private readonly ctx: SettingsContext;

  constructor(container: HTMLElement, private readonly handlers: SettingsModalHandlers) {
    this.tabs = [new AppearanceTab(), new EditorTab(), new SketchTab(), new TimelineTab(), new UnitsTab(), new AdvancedTab()];
    this.activeId = this.tabs[0].id;
    this.ctx = {
      changed: () => this.refreshDirty(),
      resetAll: () => this.resetAll(),
    };

    this.overlay = document.createElement('div');
    this.overlay.className = 'fixed inset-0 z-[300] bg-black/50 flex items-center justify-center hidden';
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.setAttribute('aria-label', 'Settings');
    // A fixed height: the tallest tab does not decide it, so switching tabs
    // never moves the footer or resizes the box.
    this.overlay.innerHTML = `
      <div data-ref="box" class="w-[600px] max-w-[calc(100vw-2rem)] h-[480px] max-h-[85vh] flex flex-col bg-base-100 border border-base-content/10 rounded-lg shadow-[0_4px_24px_rgba(0,0,0,0.5)] overflow-hidden">
        <div class="flex items-center justify-between px-5 py-3 border-b border-base-content/10 shrink-0">
          <h3 class="text-sm font-medium text-base-content/90">Settings</h3>
          <button data-ref="close" class="btn btn-ghost btn-square btn-xs text-base-content/60" title="Close" aria-label="Close settings">
            <span class="[&>svg]:size-4">${ICON_CLOSE}</span>
          </button>
        </div>
        <div class="flex flex-col sm:flex-row min-h-0 flex-1">
          <nav data-ref="tabs" aria-label="Settings sections"
               class="flex sm:flex-col gap-1 p-2 sm:w-40 shrink-0 overflow-x-auto sm:overflow-x-visible border-b sm:border-b-0 sm:border-r border-base-content/10"></nav>
          <div data-ref="panels" class="flex-1 min-w-0 min-h-0 overflow-y-auto p-5"></div>
        </div>
        <div class="flex items-center justify-end gap-2 px-5 py-3 border-t border-base-content/10 shrink-0">
          <button data-ref="cancel" type="button" class="btn btn-sm btn-ghost">Cancel</button>
          <button data-ref="save" type="button" class="btn btn-sm btn-primary" disabled>Save</button>
        </div>
      </div>
    `;
    container.appendChild(this.overlay);

    const nav = this.overlay.querySelector<HTMLElement>('[data-ref="tabs"]')!;
    const panels = this.overlay.querySelector<HTMLElement>('[data-ref="panels"]')!;
    for (const tab of this.tabs) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.tab = tab.id;
      button.setAttribute('role', 'tab');
      const text = document.createElement('span');
      text.textContent = tab.label;
      button.appendChild(text);
      const dot = document.createElement('span');
      dot.dataset.dirty = '';
      dot.className = `${TAB_DOT} hidden`;
      dot.title = 'Unsaved changes';
      button.appendChild(dot);
      button.addEventListener('click', () => this.activate(tab.id));
      nav.appendChild(button);
      this.tabButtons.set(tab.id, button);
      this.tabDots.set(tab.id, dot);

      const panel = document.createElement('div');
      panel.dataset.panel = tab.id;
      panel.setAttribute('role', 'tabpanel');
      panel.className = 'hidden';
      tab.mount(panel, this.ctx);
      panels.appendChild(panel);
      this.tabPanels.set(tab.id, panel);
    }
    this.activate(this.activeId);

    this.saveBtn = this.overlay.querySelector<HTMLButtonElement>('[data-ref="save"]')!;
    this.saveBtn.addEventListener('click', () => this.save());
    this.overlay.querySelector('[data-ref="cancel"]')!.addEventListener('click', () => this.hide());
    this.overlay.querySelector('[data-ref="close"]')!.addEventListener('click', () => this.hide());
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) {
        this.hide();
      }
    });
    // Capture phase, like the other modals: the dialog is on top, so its
    // Escape must not reach the feature dialog or sketch underneath.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen()) {
        e.stopPropagation();
        this.hide();
      }
    }, true);
  }

  /** Open on `tabId`, or on the tab that was last showing, with every draft reloaded from the app. */
  show(tabId?: string): void {
    if (tabId && this.tabPanels.has(tabId)) {
      this.activate(tabId);
    }
    this.syncAll();
    this.overlay.classList.remove('hidden');
    this.tabButtons.get(this.activeId)?.focus();
  }

  /** Close and drop unsaved edits. */
  hide(): void {
    this.overlay.classList.add('hidden');
    this.syncAll();
  }

  isOpen(): boolean {
    return !this.overlay.classList.contains('hidden');
  }

  /** Whether any tab holds an unsaved edit. */
  hasUnsavedChanges(): boolean {
    return this.tabs.some((tab) => tab.isDirty());
  }

  /** Apply every tab's draft and persist what changed. */
  save(): void {
    for (const tab of this.tabs) {
      if (tab.isDirty()) {
        tab.save((key, value) => this.handlers.savePreference(key, value));
      }
    }
    this.refreshDirty();
  }

  private syncAll(): void {
    for (const tab of this.tabs) {
      tab.sync();
    }
    this.refreshDirty();
  }

  private refreshDirty(): void {
    let any = false;
    for (const tab of this.tabs) {
      const dirty = tab.isDirty();
      any = any || dirty;
      this.tabDots.get(tab.id)?.classList.toggle('hidden', !dirty);
    }
    this.saveBtn.disabled = !any;
  }

  private activate(tabId: string): void {
    this.activeId = tabId;
    for (const [id, button] of this.tabButtons) {
      const active = id === tabId;
      button.className = active ? TAB_BTN_ACTIVE : TAB_BTN_IDLE;
      button.setAttribute('aria-selected', String(active));
      if (active) {
        // On a phone the tabs are one scrolling row: keep the chosen one in view.
        button.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      }
    }
    for (const [id, panel] of this.tabPanels) {
      panel.classList.toggle('hidden', id !== tabId);
    }
  }

  private async resetAll(): Promise<boolean> {
    const prefs = await this.handlers.resetPreferences();
    if (!prefs) {
      return false;
    }
    this.handlers.applyPreferences(prefs);
    this.syncAll();
    return true;
  }
}

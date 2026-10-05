import { onThemeChange } from '../../scene/theme-colors';
import { FIELD_LABEL, type PersistPreference, type SettingsContext, type SettingsTab } from './settings-tab';

const DARK_THEME = 'fluidcad-dark';
const LIGHT_THEME = 'fluidcad-light';

// Each card previews its own theme — its background and text are that
// theme's, whichever theme the dialog itself is drawn in — and the chosen
// one carries the primary border.
const CARD = 'flex-1 flex flex-col items-center gap-2 rounded-lg border-2 px-3 py-3 cursor-pointer text-xs';
const CARD_IDLE = `${CARD} border-base-content/15 hover:border-base-content/40`;
const CARD_ACTIVE = `${CARD} border-primary`;

function currentTheme(): string {
  return document.documentElement.getAttribute('data-theme') || DARK_THEME;
}

/** Dark or light. Applied on Save; the top bar's toggle switches the same preference at once. */
export class AppearanceTab implements SettingsTab {
  readonly id = 'appearance';
  readonly label = 'Appearance';
  private cards = new Map<string, HTMLButtonElement>();
  private draft = currentTheme();

  mount(root: HTMLElement, ctx: SettingsContext): void {
    const label = document.createElement('p');
    label.className = `${FIELD_LABEL} mb-2`;
    label.textContent = 'Theme';
    root.appendChild(label);

    const row = document.createElement('div');
    row.className = 'flex gap-3';
    root.appendChild(row);

    for (const [theme, text, swatch] of [
      [DARK_THEME, 'Dark', 'bg-[#1d232a] border-[#3a4149]'],
      [LIGHT_THEME, 'Light', 'bg-[#f5f5f5] border-[#d0d0d0]'],
    ] as const) {
      const card = document.createElement('button');
      card.type = 'button';
      card.dataset.theme = theme;
      card.innerHTML = `<span class="w-full h-10 rounded border ${swatch}"></span><span>${text}</span>`;
      // The preview colours, fixed rather than tokens: a token would follow the page's theme.
      card.style.background = theme === DARK_THEME ? '#2a323c' : '#ffffff';
      card.style.color = theme === DARK_THEME ? '#d5d8dc' : '#333333';
      card.addEventListener('click', () => {
        this.draft = theme;
        this.paint();
        ctx.changed();
      });
      row.appendChild(card);
      this.cards.set(theme, card);
    }

    // The top-bar toggle can switch the theme while the dialog is open; a
    // draft that only mirrored the old value would then read as an edit.
    onThemeChange(() => {
      if (!this.isDirty()) {
        return;
      }
      this.paint();
    });
    this.sync();
  }

  sync(): void {
    this.draft = currentTheme();
    this.paint();
  }

  isDirty(): boolean {
    return this.draft !== currentTheme();
  }

  save(persist: PersistPreference): void {
    if (!this.isDirty()) {
      return;
    }
    document.documentElement.setAttribute('data-theme', this.draft);
    persist('theme', this.draft);
  }

  private paint(): void {
    for (const [theme, card] of this.cards) {
      card.className = theme === this.draft ? CARD_ACTIVE : CARD_IDLE;
      card.setAttribute('aria-pressed', String(theme === this.draft));
    }
  }
}

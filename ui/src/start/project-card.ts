import { ICON_CLOSE, ICON_CUBE, ICON_DOTS_VERTICAL, ICON_REFRESH, ICON_STOP } from '../ui/icons';
import { closePopupMenu, showPopupMenu } from '../ui/popup-menu';
import { engineChip } from './engine-chip';
import { openedAgo, shortenPath } from './format';
import type { StartProject } from './host';

export type ProjectCardHandlers = {
  open(project: StartProject): Promise<void>;
  changeEngine(project: StartProject): void;
  /** Close an open project: its engine stops, and its window goes back to the start screen or its tab closes. */
  close(project: StartProject): Promise<void>;
  forget(project: StartProject): Promise<void>;
};

export type ProjectCardContext = {
  home: string;
  /** Where the ⋯ menu mounts: the page's positioning context, so no card clips it. */
  menuHost: HTMLElement;
  /** The card lists a project in the launcher's projects folder, not a recent: it cannot be removed from the list. */
  rooted: boolean;
};

const CARD =
  'group relative flex flex-col min-w-0 bg-base-200 border border-base-content/10 rounded-lg overflow-hidden ' +
  'cursor-pointer outline-none transition-colors hover:border-base-content/25 ' +
  'focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/40';

/** Square: a preview is an iso render cropped to the model, as often tall as it is wide. */
export const PREVIEW_BOX = 'relative aspect-square bg-base-300/50 border-b border-base-content/10 overflow-hidden';

/**
 * Absolute against the box on purpose: a percentage height inside a box whose
 * height comes from `aspect-ratio` does not resolve, and the picture would run
 * at its natural size with the box clipping it.
 */
export const PREVIEW_IMAGE = 'absolute inset-0 w-full h-full object-contain';

const MORE_BUTTON =
  'absolute top-2 right-2 btn btn-square btn-xs bg-base-100/85 border-base-content/15 text-base-content/80 ' +
  'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-[open]:opacity-100';

/** The ⋯ button whose menu is showing, so a second press closes it instead of reopening it. */
let menuAnchor: { button: HTMLElement; menu: HTMLElement } | null = null;

export function previewPlaceholder(caption: string | null): HTMLElement {
  const placeholder = document.createElement('div');
  placeholder.className =
    'absolute inset-0 grid place-content-center justify-items-center gap-1.5 text-xs text-base-content/35';
  placeholder.innerHTML = `<span class="[&>svg]:size-8">${ICON_CUBE}</span>`;
  if (caption) {
    const text = document.createElement('span');
    text.textContent = caption;
    placeholder.appendChild(text);
  }
  return placeholder;
}

function preview(project: StartProject): HTMLElement {
  const box = document.createElement('div');
  box.className = PREVIEW_BOX;
  if (project.thumbnail) {
    const img = document.createElement('img');
    img.className = `${PREVIEW_IMAGE} p-3`;
    img.src = project.thumbnail;
    img.alt = '';
    img.draggable = false;
    box.appendChild(img);
  } else {
    box.appendChild(previewPlaceholder('No preview yet'));
  }
  return box;
}

function meta(project: StartProject, context: ProjectCardContext, onUpgrade: () => void): HTMLElement {
  const body = document.createElement('div');
  body.className = 'px-3 pt-2.5 pb-3 grid gap-0.5 min-w-0';

  const name = document.createElement('div');
  name.className = 'font-semibold text-sm text-base-content truncate';
  name.textContent = project.name;

  // Right-to-left with an isolated left-to-right run: a long path loses its
  // start, not the folder name at its end.
  const where = document.createElement('div');
  where.className = 'font-mono text-[11px] text-base-content/55 truncate [direction:rtl] text-left';
  const bdi = document.createElement('bdi');
  bdi.className = '[direction:ltr] [unicode-bidi:isolate]';
  bdi.textContent = shortenPath(project.path, context.home);
  where.appendChild(bdi);

  const footer = document.createElement('div');
  footer.className = 'flex items-center justify-between gap-2 mt-2 min-w-0';
  const when = document.createElement('span');
  when.className = 'text-[11px] leading-[18px] text-base-content/45 truncate';
  when.textContent = openedAgo(project.lastOpenedAt);
  footer.append(when, engineChip(project, onUpgrade));

  body.append(name, where, footer);
  return body;
}

function moreButton(project: StartProject, context: ProjectCardContext, handlers: ProjectCardHandlers): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = MORE_BUTTON;
  button.title = 'More';
  button.setAttribute('aria-label', `More actions for ${project.name}`);
  button.setAttribute('aria-haspopup', 'menu');
  button.innerHTML = `<span class="[&>svg]:size-3.5">${ICON_DOTS_VERTICAL}</span>`;

  // The menu closes itself on any press outside it — including a press on
  // this button — before the click lands; remember that it was showing.
  let wasOpen = false;
  button.addEventListener('pointerdown', () => {
    wasOpen = menuAnchor?.button === button && menuAnchor.menu.isConnected;
  });
  button.addEventListener('keydown', (event) => event.stopPropagation());
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (wasOpen) {
      wasOpen = false;
      closePopupMenu();
      return;
    }
    const own = project.engineSource === 'own';
    const rect = button.getBoundingClientRect();
    const menu = showPopupMenu(
      context.menuHost,
      { clientX: rect.right, clientY: rect.bottom + 4 },
      [
        {
          icon: ICON_REFRESH,
          label: 'Change engine version…',
          disabled: own,
          title: own ? "This project runs the engine from its own node_modules; its lockfile decides." : undefined,
          onSelect: () => handlers.changeEngine(project),
        },
        ...(project.open ? [{ icon: ICON_STOP, label: 'Close project', onSelect: () => void handlers.close(project) }] : []),
        ...(context.rooted ? [] : [{ icon: ICON_CLOSE, label: 'Remove from recent', onSelect: () => void handlers.forget(project) }]),
      ],
      { align: 'end', focusFirst: true },
    );
    button.dataset.open = '';
    menuAnchor = { button, menu };
    // Cleared when the menu goes, however it goes.
    const observer = new MutationObserver(() => {
      if (!menu.isConnected) {
        delete button.dataset.open;
        observer.disconnect();
      }
    });
    observer.observe(context.menuHost, { childList: true });
  });
  return button;
}

/** One recent project: preview, name, path, when it was opened, its engine, and a ⋯ menu. */
export function projectCard(project: StartProject, context: ProjectCardContext, handlers: ProjectCardHandlers): HTMLElement {
  const card = document.createElement('div');
  card.className = CARD;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.title = project.path;
  card.dataset.projectPath = project.path;

  const open = async () => {
    if (card.dataset.busy !== undefined) {
      return;
    }
    card.dataset.busy = '';
    card.classList.add('opacity-60', 'pointer-events-none');
    try {
      await handlers.open(project);
    } finally {
      delete card.dataset.busy;
      card.classList.remove('opacity-60', 'pointer-events-none');
    }
  };
  card.addEventListener('click', () => void open());
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      void open();
    }
  });

  card.append(
    preview(project),
    meta(project, context, () => handlers.changeEngine(project)),
    moreButton(project, context, handlers),
  );
  return card;
}

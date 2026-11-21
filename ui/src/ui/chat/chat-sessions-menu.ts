import { MENU_CLASS, MENU_ROW_CLASS } from '../menu-styles';
import { ChatIcons } from './chat-icons';
import type { SessionStatus, SessionSummary } from './chat-types';
import { relativeTime } from './time-format';

/** The most chats the menu lists. */
export const MAX_LISTED_SESSIONS = 50;
/** Keep the menu clear of the window's edges by at least this much. */
const EDGE_MARGIN = 8;

export type ChatSessionsMenuDeps = {
  /** The page's positioning context the menu mounts in (`#fluidcad-viewer`). */
  host: HTMLElement;
  /** The chats, newest first, and the one on screen (null: a new chat). */
  sessions(): readonly SessionSummary[];
  current(): string | null;
  /** How the chat's agent is named: the program, or for the `api` agent its provider. */
  agentName(session: SessionSummary): string;
  onNewChat(): void;
  onOpen(id: string): void;
  /** Rename `id`; resolves to an error to show, or null once renamed. */
  onRename(id: string, title: string): Promise<string | null>;
  /** Ask, then delete `id` (the menu has closed by then). */
  onDelete(id: string): void;
  now?(): Date;
};

/**
 * The chats menu under the panel's title (§7.1, phase 7): New chat, then
 * every chat of the project, newest first, each with its title, the agent,
 * when it last changed and what it is doing (working, waiting, interrupted,
 * stopped on an error). A row opens its chat; its pencil renames it in place
 * (Enter keeps, Escape leaves it as it was) and its bin deletes it, after
 * the panel asks. Closes on a press outside, on Escape, and once a row is
 * picked.
 */
export class ChatSessionsMenu {
  private el: HTMLDivElement | null = null;
  private renaming: string | null = null;
  private readonly onPointerDown = (event: PointerEvent) => {
    if (this.el && !this.el.contains(event.target as Node)) {
      this.close();
    }
  };
  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && this.el && !this.renaming) {
      event.stopPropagation();
      this.close();
    }
  };

  constructor(private readonly deps: ChatSessionsMenuDeps) {}

  get isOpen(): boolean {
    return this.el !== null;
  }

  /** The menu's element while it shows (tests). */
  get element(): HTMLDivElement | null {
    return this.el;
  }

  /** Show it under `anchor` (the title button's rectangle). */
  show(anchor: { left: number; bottom: number }): void {
    this.close();
    const el = document.createElement('div');
    el.className = `${MENU_CLASS} chat-sessions-menu`;
    el.dataset.ref = 'session-menu';
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-label', 'Chats');
    this.el = el;
    this.paint();
    const hostRect = this.deps.host.getBoundingClientRect();
    el.style.left = `${anchor.left - hostRect.left}px`;
    el.style.top = `${anchor.bottom + 4 - hostRect.top}px`;
    this.deps.host.appendChild(el);
    const rect = el.getBoundingClientRect();
    const overflowX = rect.right - (window.innerWidth - EDGE_MARGIN);
    if (overflowX > 0) {
      el.style.left = `${anchor.left - hostRect.left - overflowX}px`;
    }
    // After the click that opened it, so that click is not a press outside.
    setTimeout(() => {
      if (this.el === el) {
        document.addEventListener('pointerdown', this.onPointerDown, true);
        document.addEventListener('keydown', this.onKeyDown, true);
      }
    }, 0);
    el.querySelector<HTMLButtonElement>('button')?.focus();
  }

  /** The chats changed (the list was read again, a title or status moved): repaint if open. */
  refresh(): void {
    if (this.el && !this.renaming) {
      this.paint();
    }
  }

  close(): void {
    if (!this.el) {
      return;
    }
    document.removeEventListener('pointerdown', this.onPointerDown, true);
    document.removeEventListener('keydown', this.onKeyDown, true);
    this.el.remove();
    this.el = null;
    this.renaming = null;
  }

  // ---------------------------------------------------------------------------

  private paint(): void {
    const el = this.el;
    if (!el) {
      return;
    }
    el.replaceChildren();
    const newChat = document.createElement('button');
    newChat.type = 'button';
    newChat.className = MENU_ROW_CLASS;
    newChat.dataset.ref = 'menu-new-chat';
    newChat.setAttribute('role', 'menuitem');
    newChat.append(ChatIcons.span(ChatIcons.NEW, '[&>svg]:size-4 text-base-content/60'), document.createTextNode('New chat'));
    newChat.addEventListener('click', () => {
      this.close();
      this.deps.onNewChat();
    });
    el.append(newChat);

    const sessions = this.deps.sessions().slice(0, MAX_LISTED_SESSIONS);
    if (sessions.length === 0) {
      return;
    }
    const rule = document.createElement('div');
    rule.className = 'my-1 border-t border-base-content/10';
    el.append(rule);
    const list = document.createElement('div');
    list.className = 'chat-sessions-list';
    list.dataset.ref = 'session-list';
    for (const session of sessions) {
      list.append(this.row(session));
    }
    el.append(list);
  }

  private row(session: SessionSummary): HTMLElement {
    const current = session.id === this.deps.current();
    const row = document.createElement('div');
    row.className = 'chat-session-row';
    row.dataset.sessionId = session.id;
    if (current) {
      row.dataset.current = 'true';
    }

    if (this.renaming === session.id) {
      row.append(this.renameField(session));
      return row;
    }

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'chat-session-open';
    open.dataset.ref = 'open-session';
    open.setAttribute('role', 'menuitem');
    if (current) {
      open.setAttribute('aria-current', 'true');
    }
    const title = document.createElement('span');
    title.className = 'chat-session-title';
    title.dataset.ref = 'session-title';
    title.textContent = session.title;
    const meta = document.createElement('span');
    meta.className = 'chat-session-meta';
    meta.dataset.ref = 'session-meta';
    const status = statusLabel(session.status);
    const time = relativeTime(session.updatedAt, this.deps.now?.() ?? new Date());
    meta.textContent = [this.deps.agentName(session), time].filter(Boolean).join(' · ');
    if (status) {
      const badge = document.createElement('span');
      badge.className = `chat-session-status chat-session-status-${status.tone}`;
      badge.dataset.ref = 'session-status';
      badge.textContent = status.text;
      meta.append(document.createTextNode(' · '), badge);
    }
    open.title = `${session.title}\n${this.deps.agentName(session)} · ${new Date(session.updatedAt).toLocaleString()}`;
    open.append(
      ChatIcons.span(current ? ChatIcons.CHECK : ChatIcons.SESSION, `[&>svg]:size-4 mt-0.5 ${current ? 'text-primary' : 'text-base-content/50'}`),
      column(title, meta),
    );
    open.addEventListener('click', () => {
      this.close();
      if (!current) {
        this.deps.onOpen(session.id);
      }
    });

    const rename = actionButton(ChatIcons.RENAME, `Rename “${session.title}”`, 'rename-session');
    rename.addEventListener('click', (event) => {
      event.stopPropagation();
      this.renaming = session.id;
      this.paint();
    });
    const remove = actionButton(ChatIcons.DELETE, `Delete “${session.title}”`, 'delete-session');
    remove.classList.add('chat-session-delete');
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      this.close();
      this.deps.onDelete(session.id);
    });
    const actions = document.createElement('span');
    actions.className = 'chat-session-actions';
    actions.append(rename, remove);
    row.append(open, actions);
    return row;
  }

  private renameField(session: SessionSummary): HTMLElement {
    const form = document.createElement('div');
    form.className = 'chat-session-rename';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'input input-xs w-full';
    input.dataset.ref = 'rename-input';
    input.value = session.title;
    input.maxLength = 200;
    input.setAttribute('aria-label', 'Chat title');
    const error = document.createElement('div');
    error.className = 'text-hub-xs text-error hidden';
    error.dataset.ref = 'rename-error';
    let busy = false;
    const commit = async () => {
      const title = input.value.trim();
      if (busy) {
        return;
      }
      if (title === '' || title === session.title) {
        this.stopRenaming();
        return;
      }
      busy = true;
      input.disabled = true;
      const failure = await this.deps.onRename(session.id, title);
      busy = false;
      if (this.renaming !== session.id) {
        return;
      }
      if (failure) {
        input.disabled = false;
        error.textContent = failure;
        error.classList.remove('hidden');
        input.focus();
        return;
      }
      this.stopRenaming();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void commit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.stopRenaming();
      }
    });
    form.append(input, error);
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
    return form;
  }

  private stopRenaming(): void {
    this.renaming = null;
    this.paint();
    this.el?.querySelector<HTMLButtonElement>('[data-current="true"] [data-ref="open-session"]')?.focus();
  }
}

/** What a chat's row says it is doing; null when it is idle. */
export function statusLabel(status: SessionStatus): { text: string; tone: 'busy' | 'warning' | 'error' } | null {
  switch (status.state) {
    case 'starting':
    case 'running':
      return { text: 'Working', tone: 'busy' };
    case 'awaiting-approval':
    case 'awaiting-answer':
      return { text: 'Waiting for you', tone: 'warning' };
    case 'interrupted':
      return { text: 'Interrupted', tone: 'warning' };
    case 'error':
      switch (status.kind) {
        case 'rate-limit':
          return { text: 'Limit reached', tone: 'warning' };
        case 'auth':
          return { text: 'Not signed in', tone: 'error' };
        default:
          return { text: 'Error', tone: 'error' };
      }
    default:
      return null;
  }
}

function column(...children: HTMLElement[]): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'flex flex-col min-w-0 flex-1 text-left';
  span.append(...children);
  return span;
}

function actionButton(svg: string, label: string, ref: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chat-session-action';
  button.dataset.ref = ref;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(ChatIcons.span(svg, '[&>svg]:size-3.5'));
  return button;
}

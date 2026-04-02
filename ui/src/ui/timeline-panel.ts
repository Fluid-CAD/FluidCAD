import { ICON_LIST_TREE } from './icons';
import type { SceneObjectRender } from '../types';

const BTN_BASE = 'btn btn-ghost btn-square btn-sm text-base-content/60';
const BTN_ACTIVE = 'btn-active !bg-primary/20 !text-primary !border-primary/40';

export class TimelinePanel {
  private el: HTMLDivElement;
  private toggleBtn: HTMLButtonElement;
  private panel: HTMLDivElement;
  private treeContainer: HTMLDivElement;
  private isOpen = true;
  private loaded = false;
  private sceneObjects: SceneObjectRender[] = [];
  private rollbackStop = -1;
  private headerLabel: HTMLSpanElement;
  private collapsedIds = new Set<string>();

  constructor(container: HTMLElement) {
    // Toggle button — hidden until first scene load
    this.toggleBtn = document.createElement('button');
    this.toggleBtn.className = `${BTN_BASE} ${BTN_ACTIVE} absolute left-6 top-6 z-[100] glass-dark border border-white/10 hidden`;
    this.toggleBtn.title = 'Toggle Timeline';
    this.toggleBtn.innerHTML = `<span class="[&>svg]:size-5">${ICON_LIST_TREE}</span>`;
    container.appendChild(this.toggleBtn);

    // Panel — hidden until first scene load
    this.panel = document.createElement('div');
    this.panel.className = 'absolute left-6 top-16 bottom-6 w-[220px] z-[99] overflow-hidden flex flex-col select-none hidden';
    this.panel.innerHTML = `
      <div class="flex items-center justify-between px-3 py-2 border-b border-white/[0.07]">
        <span data-ref="header" class="text-sm font-medium text-base-content/50 truncate"></span>
      </div>
      <div data-ref="tree" class="flex-1 overflow-y-auto py-1"></div>
    `;
    container.appendChild(this.panel);

    this.headerLabel = this.panel.querySelector('[data-ref="header"]')!;

    this.treeContainer = this.panel.querySelector('[data-ref="tree"]')!;

    // Wrapper div for external API
    this.el = document.createElement('div');

    this.toggleBtn.addEventListener('click', () => this.toggle());
  }

  private toggle(): void {
    this.isOpen = !this.isOpen;
    this.panel.classList.toggle('hidden', !this.isOpen);
    this.toggleBtn.classList.toggle(BTN_ACTIVE.split(' ')[0], this.isOpen);
    this.toggleBtn.classList.toggle('!bg-primary/20', this.isOpen);
    this.toggleBtn.classList.toggle('!text-primary', this.isOpen);
    this.toggleBtn.classList.toggle('!border-primary/40', this.isOpen);
  }

  update(sceneObjects: SceneObjectRender[], rollbackStop: number, absPath?: string): void {
    this.sceneObjects = sceneObjects;
    this.rollbackStop = rollbackStop;
    if (absPath) {
      const fileName = absPath.split('/').pop() || absPath;
      this.headerLabel.textContent = fileName;
    }
    if (!this.loaded) {
      this.loaded = true;
      this.toggleBtn.classList.remove('hidden');
      if (this.isOpen) {
        this.panel.classList.remove('hidden');
      }
    }
    this.renderTree();
  }

  private renderTree(): void {
    const items = this.sceneObjects;
    const rollbackStop = this.rollbackStop;

    // Build a set of parent ids that have children
    const parentIds = new Set<string>();
    for (const obj of items) {
      if (obj.parentId) {
        parentIds.add(obj.parentId);
      }
    }

    let html = '';

    for (let i = 0; i < items.length; i++) {
      const obj = items[i];
      if (obj.parentId) {
        continue;
      }

      const hasChildren = obj.id != null && parentIds.has(obj.id);
      const isCollapsed = obj.id != null && this.collapsedIds.has(obj.id);

      html += this.renderItem(obj, i, rollbackStop, false, hasChildren, isCollapsed);

      // Render children if expanded
      if (hasChildren && !isCollapsed) {
        for (let j = 0; j < items.length; j++) {
          if (items[j].parentId === obj.id) {
            html += this.renderItem(items[j], j, rollbackStop, true, false, false);
          }
        }
      }
    }

    this.treeContainer.innerHTML = html;

    // Bind click handlers for rollback
    this.treeContainer.querySelectorAll<HTMLElement>('[data-index]').forEach((el) => {
      el.addEventListener('click', (e) => {
        // Don't rollback if the chevron was clicked
        if ((e.target as HTMLElement).closest('[data-toggle]')) {
          return;
        }
        const index = parseInt(el.dataset.index!, 10);
        const isContainer = el.dataset.container === 'true';
        this.rollbackTo(index, isContainer);
      });
    });

    // Bind toggle handlers for expand/collapse
    this.treeContainer.querySelectorAll<HTMLElement>('[data-toggle]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = el.dataset.toggle!;
        if (this.collapsedIds.has(id)) {
          this.collapsedIds.delete(id);
        } else {
          this.collapsedIds.add(id);
        }
        this.renderTree();
      });
    });

    // Scroll the current rollback item into view
    const currentEl = this.treeContainer.querySelector<HTMLElement>('[data-current="true"]');
    if (currentEl) {
      currentEl.scrollIntoView({ block: 'nearest' });
    }
  }

  private renderItem(obj: SceneObjectRender, index: number, rollbackStop: number, isChild: boolean, hasChildren: boolean, isCollapsed: boolean): string {
    const isCurrent = index === rollbackStop;
    const isPast = index > rollbackStop;
    const isInvisible = obj.visible === false;
    const hasError = obj.hasError === true;
    const name = obj.name
      ? obj.name.charAt(0).toUpperCase() + obj.name.slice(1)
      : obj.type || 'Unknown';
    const iconSrc = `/icons/${obj.type || 'solid'}.png`;

    let itemClass = 'flex items-center gap-1 px-3 py-1.5 cursor-pointer hover:bg-white/[0.06] text-sm';

    if (isChild) {
      itemClass += ' pl-7';
    }

    if (isCurrent) {
      itemClass += ' border-l-2 border-primary bg-primary/10 text-primary';
    } else if (hasError) {
      itemClass += ' text-error';
    } else if (isPast || isInvisible) {
      itemClass += ' opacity-60';
    } else {
      itemClass += ' text-base-content/80';
    }

    const imgClass = isInvisible ? 'w-4 h-4 object-contain grayscale opacity-60' : 'w-4 h-4 object-contain';

    let chevron = '';
    if (hasChildren) {
      const rotation = isCollapsed ? '' : 'rotate-90';
      chevron = `<span data-toggle="${obj.id}" class="flex items-center justify-center w-5 h-5 opacity-50 hover:opacity-100 transition-transform ${rotation}">
        <svg width="14" height="14" viewBox="0 0 10 10" fill="currentColor"><path d="M3 1l5 4-5 4z"/></svg>
      </span>`;
    } else {
      chevron = '<span class="w-4"></span>';
    }

    return `
      <div class="${itemClass}" data-index="${index}" data-container="${obj.isContainer ?? false}" data-current="${isCurrent}">
        ${chevron}
        <img src="${iconSrc}" class="${imgClass}" alt="" />
        <span class="truncate">${name}</span>
      </div>
    `;
  }

  private async rollbackTo(index: number, isContainer: boolean): Promise<void> {
    const actualIndex = isContainer ? index + 1 : index;
    try {
      await fetch('/api/rollback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index: actualIndex }),
      });
    } catch (err) {
      console.error('Rollback failed:', err);
    }
  }
}

import type { ModelDiffStatus, UpgradeDiff } from './host';

/**
 * What a comparison between two engines found, model by model: identical,
 * changed (with what moved), broken, or fixed. Selectable text, so a note
 * can be copied into an issue.
 */

const STATUS_TONE: Record<ModelDiffStatus, { border: string; text: string }> = {
  identical: { border: 'border-success/30', text: 'text-success' },
  fixed: { border: 'border-success/30', text: 'text-success' },
  changed: { border: 'border-warning/40', text: 'text-warning' },
  broken: { border: 'border-error/40', text: 'text-error' },
};

export function renderUpgradeDiff(diff: UpgradeDiff): HTMLElement {
  const view = document.createElement('div');
  view.className = 'grid gap-2 select-text';
  view.dataset.diff = diff.identical ? 'identical' : 'changed';

  const summary = document.createElement('p');
  summary.className = 'text-sm text-base-content/70';
  summary.textContent = diff.identical
    ? `Every model builds to identical geometry on engine ${diff.to}.`
    : `Engine ${diff.to} changes this project. Review before switching.`;

  const list = document.createElement('div');
  list.className = 'grid gap-1.5';
  for (const model of diff.models) {
    const tone = STATUS_TONE[model.status];
    const row = document.createElement('div');
    row.className = `border ${tone.border} rounded-md px-2.5 py-1.5`;
    row.dataset.status = model.status;
    const line = document.createElement('div');
    line.className = 'flex items-baseline gap-2';
    const file = document.createElement('span');
    file.className = 'flex-1 font-mono text-xs break-all text-base-content';
    file.textContent = model.file;
    const status = document.createElement('span');
    status.className = `text-[11px] ${tone.text}`;
    status.textContent = model.status;
    line.append(file, status);
    row.appendChild(line);
    if (model.notes.length > 0) {
      const notes = document.createElement('ul');
      notes.className = 'mt-1 pl-4 list-disc text-xs text-base-content/60';
      for (const note of model.notes) {
        const item = document.createElement('li');
        item.textContent = note;
        notes.appendChild(item);
      }
      row.appendChild(notes);
    }
    list.appendChild(row);
  }
  if (diff.skipped.length > 0) {
    const skipped = document.createElement('p');
    skipped.className = 'text-xs text-base-content/60';
    skipped.textContent = `${diff.skipped.length} more model(s) were not compared: ${diff.skipped.join(', ')}`;
    list.appendChild(skipped);
  }

  view.append(summary, list);
  return view;
}

/** A progress line or an error in the diff's place. */
export function diffMessage(text: string, tone: 'progress' | 'error'): HTMLElement {
  const message = document.createElement('p');
  message.className =
    tone === 'error' ? 'text-sm text-error whitespace-pre-wrap select-text' : 'text-sm text-base-content/60';
  message.dataset.tone = tone;
  message.textContent = text;
  return message;
}

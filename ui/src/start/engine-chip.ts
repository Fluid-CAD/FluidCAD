import type { StartProject } from './host';

/**
 * The small pill in a project card's corner: which engine the project runs
 * on, or that it is open right now. One state per project, in this order:
 *
 *   open      the project is open in a window
 *   unpinned  no pin yet; it opens with the engine that ships with the app
 *   own       it runs its own `node_modules` install
 *   update    the pin lags the app's engine — the chip is the upgrade button
 *   latest    pinned to the engine that ships with the app
 *   pinned    pinned to some other version
 */
export type EngineChipState = 'open' | 'unpinned' | 'own' | 'update' | 'latest' | 'pinned';

const BASE = 'badge badge-sm badge-outline font-normal tabular-nums whitespace-nowrap shrink-0';
const NEUTRAL = `${BASE} text-base-content/60 border-base-content/20`;

export function engineChipState(project: StartProject): EngineChipState {
  if (project.open) {
    return 'open';
  }
  if (!project.engine) {
    return 'unpinned';
  }
  if (project.engineSource === 'own') {
    return 'own';
  }
  if (project.upgradeTo) {
    return 'update';
  }
  return project.latest ? 'latest' : 'pinned';
}

/** The chip for `project`; `onUpgrade` runs when the update chip is pressed. */
export function engineChip(project: StartProject, onUpgrade: () => void): HTMLElement {
  const state = engineChipState(project);
  const chip = document.createElement(state === 'update' ? 'button' : 'span');
  chip.dataset.chip = state;
  switch (state) {
    case 'open':
      chip.className = `${BASE} badge-success`;
      chip.textContent = 'open';
      chip.title = 'Open in a window.';
      break;
    case 'unpinned':
      chip.className = NEUTRAL;
      chip.textContent = 'unpinned';
      chip.title = 'This project has no engine pin yet; it opens with the engine that ships with the app.';
      break;
    case 'own':
      chip.className = `${BASE} badge-primary`;
      chip.textContent = project.engine!;
      chip.title = "Runs the engine from the project's own node_modules.";
      break;
    case 'update':
      chip.className = `${BASE} badge-warning cursor-pointer hover:bg-warning/10`;
      chip.textContent = `${project.engine} · update`;
      chip.title = `Engine ${project.upgradeTo} is available. Click to compare and switch.`;
      (chip as HTMLButtonElement).type = 'button';
      chip.addEventListener('click', (event) => {
        event.stopPropagation();
        onUpgrade();
      });
      // Enter and Space press the chip, not the card around it.
      chip.addEventListener('keydown', (event) => event.stopPropagation());
      break;
    case 'latest':
      chip.className = NEUTRAL;
      chip.textContent = `latest (${project.engine})`;
      chip.title = 'Pinned in fluidcad.json to the engine that ships with the app.';
      break;
    case 'pinned':
      chip.className = NEUTRAL;
      chip.textContent = project.engine!;
      chip.title = 'Pinned in fluidcad.json.';
      break;
  }
  return chip;
}

import { ChatIcons } from './chat-icons';
import type { AgentReadiness } from './chat-state';
import type { AgentInstall, AgentKind } from './chat-types';

/**
 * What each CLI is called and how it is installed, updated and signed in
 * (§9.1). The names are plain text naming what runs (§4.2): no logos.
 */
export const AGENT_INFO: Record<AgentKind, { name: string; installUrl: string; login: string; update: string }> = {
  claude: {
    name: 'Claude Code',
    installUrl: 'https://code.claude.com/docs/en/setup',
    login: 'claude auth login',
    update: 'claude update',
  },
  codex: {
    name: 'Codex',
    installUrl: 'https://github.com/openai/codex',
    login: 'codex login',
    update: 'npm install -g @openai/codex',
  },
};

export type AgentSetupDeps = {
  openLink(url: string): void;
  /** Settings → Agent; absent where the page has no Settings. */
  openSettings?(): void;
  /** Detect again ("Check again"). */
  recheck(): Promise<void>;
};

/** How Claude Code will authenticate, in the user's words; null when it cannot be told. */
export function authDescription(install: AgentInstall | null): { short: string; long: string; apiKey: boolean } | null {
  if (!install || install.kind !== 'claude') {
    return null;
  }
  switch (install.authMethod) {
    case 'claude.ai':
      return { short: 'Subscription', long: 'Claude Code runs on your Claude subscription.', apiKey: false };
    case 'api_key':
      return {
        short: 'API key',
        long: 'Claude Code runs on the API key in ANTHROPIC_API_KEY, and its use is billed to that key.',
        apiKey: true,
      };
    default:
      return null;
  }
}

/**
 * The panel when the agent cannot run yet (§9.1): not found (with the
 * install page and the path setting), too old (the version found and the
 * one needed), not signed in (the command to run, a copy button and Check
 * again), or detection itself failing.
 */
export function renderAgentSetup(readiness: AgentReadiness, deps: AgentSetupDeps): HTMLElement {
  const el = document.createElement('div');
  el.className = 'chat-setup';
  el.dataset.ref = 'setup';
  el.dataset.state = readiness.state;

  if (readiness.state === 'loading') {
    const row = document.createElement('div');
    row.className = 'flex items-center gap-2 text-base-content/60';
    const spinner = document.createElement('span');
    spinner.className = 'loading loading-spinner loading-xs';
    row.append(spinner, document.createTextNode('Looking for the agent on this computer…'));
    el.append(row);
    return el;
  }
  if (readiness.state === 'unavailable') {
    el.append(heading('The agent is not available'), paragraph(readiness.error), checkAgain(deps));
    return el;
  }

  const install = readiness.install;
  const info = AGENT_INFO[install.kind];
  switch (readiness.state) {
    case 'not-found': {
      el.append(
        heading(`The Agent needs ${info.name}`),
        paragraph(
          `The Agent runs ${info.name}, installed on this computer and signed in with your own account. ` +
            'FluidCAD does not include it.',
        ),
      );
      const install = document.createElement('button');
      install.type = 'button';
      install.dataset.ref = 'install-link';
      install.className = 'btn btn-sm btn-primary gap-1.5 self-start';
      install.append(document.createTextNode(`Install ${info.name}`), ChatIcons.span(ChatIcons.EXTERNAL, '[&>svg]:size-3.5'));
      install.addEventListener('click', () => deps.openLink(info.installUrl));
      el.append(install);
      if (readiness.install.path && readiness.install.problem) {
        // A path set in Settings that is not the program.
        el.append(paragraph(readiness.install.problem, 'text-warning'));
      }
      const pathHint = paragraph(`Installed somewhere FluidCAD did not look? Set the path to ${info.name} in Settings → Agent.`);
      el.append(pathHint);
      const actions = row();
      if (deps.openSettings) {
        actions.append(settingsButton(deps));
      }
      actions.append(checkAgain(deps));
      el.append(actions);
      return el;
    }
    case 'too-old':
      el.append(
        heading(`${info.name} needs an update`),
        paragraph(`${info.name} ${install.version} is installed; the Agent needs ${install.minVersion} or later. Run this in a terminal, then check again:`),
        command(info.update),
        checkAgain(deps),
      );
      return el;
    case 'signed-out':
      el.append(
        heading(`Sign in to ${info.name}`),
        paragraph(`${info.name} is installed but not signed in. Run this in a terminal, sign in with your own account, then check again:`),
        command(info.login),
        checkAgain(deps),
      );
      return el;
    case 'ready':
      return el;
  }
}

/** The welcome of a new chat: what the agent can do, and how it is paid for. */
export function renderWelcome(install: AgentInstall | null, deps: AgentSetupDeps): HTMLElement {
  const el = document.createElement('div');
  el.className = 'chat-welcome';
  el.dataset.ref = 'welcome';
  el.append(ChatIcons.span(ChatIcons.AGENT, '[&>svg]:size-6 text-primary/80'));
  el.append(heading('Ask about this model'));
  el.append(
    paragraph(
      `${install ? AGENT_INFO[install.kind].name : 'The agent'} reads the project through FluidCAD's tools: the scene, the code, measurements, screenshots. ` +
        'Changing the project from the chat comes in a later version.',
    ),
  );
  const auth = authDescription(install);
  if (auth) {
    const line = paragraph(auth.long, auth.apiKey ? 'text-warning' : undefined);
    line.dataset.ref = 'auth';
    el.append(line);
    if (auth.apiKey) {
      el.append(
        paragraph('To use your Claude subscription instead, turn on “Use my Claude subscription even if ANTHROPIC_API_KEY is set” in Settings → Agent.'),
      );
      if (deps.openSettings) {
        el.append(settingsButton(deps));
      }
    }
  }
  return el;
}

function heading(text: string): HTMLElement {
  const h = document.createElement('h3');
  h.className = 'text-hub-md font-medium text-base-content/90';
  h.textContent = text;
  return h;
}

function paragraph(text: string, extra?: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.className = `text-hub-sm text-base-content/70 ${extra ?? ''}`.trim();
  p.textContent = text;
  return p;
}

function row(): HTMLDivElement {
  const div = document.createElement('div');
  div.className = 'flex flex-wrap items-center gap-2';
  return div;
}

/** A shell command to copy into a terminal. */
function command(text: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'chat-command';
  wrap.dataset.ref = 'command';
  const code = document.createElement('code');
  code.textContent = text;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.dataset.ref = 'copy-command';
  copy.className = 'btn btn-ghost btn-xs btn-square text-base-content/60 [&>svg]:size-3.5';
  copy.title = 'Copy';
  copy.setAttribute('aria-label', `Copy “${text}”`);
  copy.innerHTML = ChatIcons.COPY;
  copy.addEventListener('click', () => {
    void navigator.clipboard?.writeText(text).then(() => {
      copy.innerHTML = ChatIcons.CHECK;
      setTimeout(() => (copy.innerHTML = ChatIcons.COPY), 1200);
    }).catch(() => undefined);
  });
  wrap.append(ChatIcons.span(ChatIcons.TERMINAL, '[&>svg]:size-3.5 text-base-content/50'), code, copy);
  return wrap;
}

function checkAgain(deps: AgentSetupDeps): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.ref = 'check-again';
  button.className = 'btn btn-sm btn-ghost border border-base-content/15 gap-1.5 self-start';
  button.append(ChatIcons.span(ChatIcons.REFRESH, '[&>svg]:size-3.5'), document.createTextNode('Check again'));
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await deps.recheck();
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

function settingsButton(deps: AgentSetupDeps): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.ref = 'open-settings';
  button.className = 'btn btn-sm btn-ghost border border-base-content/15 gap-1.5 self-start';
  button.append(ChatIcons.span(ChatIcons.SETTINGS, '[&>svg]:size-3.5'), document.createTextNode('Settings'));
  button.addEventListener('click', () => deps.openSettings?.());
  return button;
}

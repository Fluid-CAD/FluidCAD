import { ChatIcons } from './chat-icons';
import type { AgentReadiness, InstallReadiness, SignIn } from './chat-state';
import type { AgentInstall, AgentKind } from './chat-types';

/**
 * What each CLI is called and how it is installed, updated and signed in
 * (§9.1). The names are plain text naming what runs (§4.2): no logos.
 * `label` is the short name on the agent chip and in its menu. The `api`
 * agent has no program: its chip names the provider, and its setup is a key
 * in Settings → Agent (§20.1).
 */
export const AGENT_INFO: Record<AgentKind, { name: string; label: string; installUrl: string; login: string; update: string; signInFromApp: boolean }> = {
  claude: {
    name: 'Claude Code',
    label: 'Claude Code',
    installUrl: 'https://code.claude.com/docs/en/setup',
    login: 'claude auth login',
    update: 'claude update',
    signInFromApp: false,
  },
  codex: {
    name: 'Codex',
    label: 'Codex',
    installUrl: 'https://github.com/openai/codex',
    login: 'codex login',
    update: 'npm install -g @openai/codex',
    // Codex's app server runs the ChatGPT sign-in (§5.2, account/login/start).
    signInFromApp: true,
  },
  api: {
    name: 'API',
    label: 'API',
    installUrl: '',
    login: '',
    update: '',
    signInFromApp: false,
  },
};

export type AgentSetupDeps = {
  openLink(url: string): void;
  /** Settings → Agent; absent where the page has no Settings. */
  openSettings?(): void;
  /** Detect again ("Check again"). */
  recheck(): Promise<void>;
  /** Signing in from the app, for an agent that offers it (Codex); absent: the terminal command only. */
  signIn?: SignInControls;
  /**
   * No CLI is installed and the engine has the `api` agent: the not-found
   * screen also offers running on an API key or a local model.
   */
  apiOption?: boolean;
};

export type SignInControls = {
  /** The sign-in in progress or the last one that failed, if any. */
  current: SignIn | null;
  /** Start it, and open the page it answers in the browser. */
  start(): void;
  /** Open the sign-in page again (the browser blocked or lost it). */
  reopen(): void;
  cancel(): void;
};

/**
 * How Claude Code authenticates, in the user's words: on the Claude
 * subscription, the only way FluidCAD runs it; null for the other agents
 * and when it is not signed in.
 */
export function authDescription(install: AgentInstall | null): string | null {
  if (!install || install.kind !== 'claude' || !install.loggedIn || install.authMethod !== 'claude.ai') {
    return null;
  }
  return install.account ? `Claude Code runs on your Claude subscription (${install.account}).` : 'Claude Code runs on your Claude subscription.';
}

/**
 * The agent chip's text: the CLI with the account it is signed in with
 * ("Claude Code (someone@example.com)", "Codex (someone@example.com)"),
 * else the bare name; for the `api` agent the provider's label
 * ("Anthropic API", "Ollama").
 */
export function agentChipLabel(install: AgentInstall | null, kind: AgentKind, providerId?: string | null): string {
  if (kind === 'api') {
    return providerLabel(install, providerId);
  }
  const name = AGENT_INFO[kind].label;
  return install?.account ? `${name} (${install.account})` : name;
}

/** A provider of the `api` agent as the pickers name it: its label, else its id. */
export function providerLabel(install: AgentInstall | null, providerId: string | null | undefined): string {
  if (!providerId) {
    return AGENT_INFO.api.label;
  }
  return install?.providers?.find((p) => p.id === providerId)?.label ?? providerId;
}

/**
 * The panel when the agent cannot run yet (§9.1): not found (with the
 * install page and where FluidCAD looks), too old (the version found and the
 * one needed), not signed in (the command to run, a copy button and Check
 * again), or detection itself failing. For the `api` agent, by its kind: no
 * provider ready, or the chat's provider not ready (§20.1).
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
  if (install.kind === 'api') {
    return apiSetup(el, readiness, deps);
  }
  const info = AGENT_INFO[install.kind];
  switch (readiness.state) {
    case 'not-found': {
      el.append(
        heading(deps.apiOption ? `The Agent needs ${info.name} or an API key` : `The Agent needs ${info.name}`),
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
      if (deps.apiOption) {
        const option = paragraph(
          deps.openSettings
            ? 'Or run it on your own API key or a local model, such as Ollama:'
            : 'Or run it on your own API key or a local model, such as Ollama, set up in Settings → Agent.',
        );
        option.dataset.ref = 'api-option';
        el.append(option);
        if (deps.openSettings) {
          el.append(addKeyButton(deps, false));
        }
      }
      if (readiness.install.path && readiness.install.problem) {
        // A stored path (`claudePath`, `codexPath`) that is not the program.
        el.append(paragraph(readiness.install.problem, 'text-warning'));
      }
      const where = paragraph(
        `FluidCAD looks for ${info.name} on your PATH and in the usual install folders. Once it is installed, check again.`,
      );
      where.dataset.ref = 'where';
      el.append(where, checkAgain(deps));
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
      el.append(heading(`Sign in to ${info.name}`));
      if (info.signInFromApp && deps.signIn) {
        el.append(...signInFromApp(info.name, deps.signIn));
        el.append(
          paragraph('Or run this in a terminal, then check again:'),
          command(info.login),
          checkAgain(deps),
        );
        return el;
      }
      el.append(
        paragraph(`${info.name} is installed but not signed in. Run this in a terminal, sign in with your own account, then check again:`),
        command(info.login),
        checkAgain(deps),
      );
      return el;
    case 'ready':
      return el;
  }
}

/**
 * The `api` agent's setup: with no provider ready, "Add an API key"
 * (Settings → Agent); for a chat whose provider stopped being ready, which
 * one and why.
 */
function apiSetup(el: HTMLElement, readiness: InstallReadiness, deps: AgentSetupDeps): HTMLElement {
  const providerId = readiness.state === 'signed-out' ? readiness.providerId : undefined;
  if (providerId) {
    const provider = readiness.install.providers?.find((p) => p.id === providerId);
    el.append(
      heading(`${provider?.label ?? providerId} is not ready`),
      paragraph(provider ? provider.problem ?? 'Check its key in Settings → Agent.' : 'It is no longer set up in Settings → Agent.'),
    );
  } else {
    el.append(
      heading('Add an API key'),
      paragraph(
        'The Agent can run on your own Anthropic, OpenAI or OpenRouter API key, or on a local model, such as Ollama' +
          (deps.openSettings ? '.' : ', set up in Settings → Agent.'),
      ),
    );
  }
  if (deps.openSettings) {
    el.append(addKeyButton(deps, true));
  }
  el.append(checkAgain(deps));
  return el;
}

/** The welcome of a new chat: what the agent can do, and how it is paid for. */
export function renderWelcome(install: AgentInstall | null, deps: AgentSetupDeps): HTMLElement {
  const el = document.createElement('div');
  el.className = 'chat-welcome';
  el.dataset.ref = 'welcome';
  el.append(ChatIcons.span(ChatIcons.AGENT, '[&>svg]:size-6 text-primary/80'));
  el.append(heading('What do you want to build?'));
  el.append(
    paragraph(
      `${install && install.kind !== 'api' ? AGENT_INFO[install.kind].name : 'The agent'} can model, edit and inspect your project.`,
    ),
  );
  const auth = authDescription(install);
  if (auth) {
    const line = paragraph(auth);
    line.dataset.ref = 'auth';
    el.append(line);
  }
  return el;
}

/**
 * Sign in without a terminal (Codex): the ChatGPT sign-in page opens in the
 * browser; the panel waits for it and then detects again. Nothing about the
 * account is shown.
 */
function signInFromApp(name: string, controls: SignInControls): HTMLElement[] {
  const current = controls.current;
  if (current && (current.state === 'starting' || current.state === 'waiting')) {
    const waiting = document.createElement('div');
    waiting.className = 'flex items-center gap-2 text-hub-sm text-base-content/80';
    waiting.dataset.ref = 'sign-in-waiting';
    const spinner = document.createElement('span');
    spinner.className = 'loading loading-spinner loading-xs';
    waiting.append(
      spinner,
      document.createTextNode(current.state === 'starting' ? 'Opening the sign-in page…' : 'Finish signing in in your browser. This updates by itself.'),
    );
    const actions = row();
    if (current.state === 'waiting') {
      const reopen = document.createElement('button');
      reopen.type = 'button';
      reopen.dataset.ref = 'sign-in-reopen';
      reopen.className = 'btn btn-sm btn-ghost border border-base-content/15 gap-1.5';
      reopen.append(document.createTextNode('Open the page again'), ChatIcons.span(ChatIcons.EXTERNAL, '[&>svg]:size-3.5'));
      reopen.addEventListener('click', () => controls.reopen());
      actions.append(reopen);
    }
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.dataset.ref = 'sign-in-cancel';
    cancel.className = 'btn btn-sm btn-ghost';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => controls.cancel());
    actions.append(cancel);
    return [waiting, actions];
  }
  const out: HTMLElement[] = [
    paragraph(`${name} is installed but not signed in. Sign in with your ChatGPT account in the browser; FluidCAD never sees the account.`),
  ];
  if (current?.state === 'failed') {
    const failed = paragraph(`Signing in did not finish: ${current.error ?? 'no reason given.'}`, 'text-warning');
    failed.dataset.ref = 'sign-in-error';
    out.push(failed);
  }
  const start = document.createElement('button');
  start.type = 'button';
  start.dataset.ref = 'sign-in';
  start.className = 'btn btn-sm btn-primary gap-1.5 self-start';
  start.append(ChatIcons.span(ChatIcons.SIGN_IN, '[&>svg]:size-3.5'), document.createTextNode(`Sign in to ${name}`));
  start.addEventListener('click', () => controls.start());
  out.push(start);
  return out;
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

/** "Add an API key": Settings → Agent, where the keys and local models are. */
function addKeyButton(deps: AgentSetupDeps, primary: boolean): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.ref = 'add-api-key';
  button.className = primary
    ? 'btn btn-sm btn-primary gap-1.5 self-start'
    : 'btn btn-sm btn-ghost border border-base-content/15 gap-1.5 self-start';
  button.append(ChatIcons.span(ChatIcons.SETTINGS, '[&>svg]:size-3.5'), document.createTextNode('Add an API key'));
  button.addEventListener('click', () => deps.openSettings?.());
  return button;
}

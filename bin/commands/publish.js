import { resolve } from 'path';
import { getHubUrl, readCredentials } from '../lib/config.js';
import { HubClient } from '../lib/api-client.js';
import { findEntry, readPackageVersion, readWorkspacePackage } from '../lib/workspace.js';
import { readModelIdentity, writeModelConfig } from '../lib/model-config.js';
import { isInteractive, select } from '../lib/prompt.js';
import { openBrowser } from '../lib/browser.js';

async function runPublish(opts) {
  const creds = readCredentials();
  if (!creds) {
    throw new Error('Not logged in. Run `fluidcad login` first.');
  }
  const hubUrl = getHubUrl(opts.hub || creds.hubUrl);

  const workspace = resolve(opts.workspace ?? process.cwd());
  const entry = findEntry(workspace, opts.entry);

  // Prefills from the model's own package.json + the stable identity from
  // fluidcad.json (null on the first publish → the hub mints one).
  const pkg = readWorkspacePackage(workspace);
  const name = opts.name ?? pkg.name;
  const description = opts.description ?? pkg.description;
  const { modelId: priorModelId, name: priorName } = readModelIdentity(workspace);

  // Surface who we are and where this is going *before* any bytes leave the
  // machine, so a wrong account or hub is caught before the upload starts.
  // (The model's own page URL is minted by the hub and printed afterwards.)
  console.log('Publishing to the FluidCAD hub:');
  console.log(`  account: ${creds.email || '(unknown account)'}`);
  console.log(`  url:     ${hubUrl}`);
  console.log('');

  // Decide new-model vs new-version BEFORE the heavy build, so the user makes
  // the call (and we do any model-list lookup) without first waiting ~110ms for
  // the engine to load. A null target ⇒ the hub mints a fresh model.
  const targetModelId = await resolveTargetModel({
    opts,
    hubUrl,
    token: creds.token,
    priorModelId,
    priorName,
  });
  console.log(
    targetModelId
      ? `Publishing a new version${priorName ? ` of ${priorName}` : ''}.\n`
      : 'Publishing as a new model.\n',
  );

  // Render once to capture the full param schema for the manifest. This also
  // acts as a build gate — a compile/runtime error fails the publish here,
  // before anything is uploaded.
  //
  // Dynamic import is deliberate (and necessary): this pulls in the whole
  // engine — Vite + OC wasm, ~40MB / ~110ms. bin/fluidcad.js eagerly loads
  // every command module at startup, so a top-level import here would make
  // `init`, `serve`, `login`, `--help` etc. pay that cost too. Loading it only
  // when `publish` actually runs is the justified exception to "no inline
  // imports".
  console.log('Building model…');
  const { captureParamDefinitions } = await import(
    '../../server/dist/model-package/capture-params.js'
  );
  let paramDefinitions;
  try {
    paramDefinitions = await captureParamDefinitions(entry, workspace);
  } catch (err) {
    throw new Error(`Model failed to build — fix the error and retry:\n${err?.message ?? err}`);
  }

  // Pack the whole workspace (Pack v2), embedding the captured params. Lazy
  // import for the same reason (keeps esbuild/jszip off the startup path of
  // non-publish commands), consistent with how `pack` loads it.
  const { packModel } = await import('../../server/dist/model-package/pack.js');
  const { manifest, zip } = await packModel({
    entryPath: entry,
    workspacePath: workspace,
    fluidcadVersion: readPackageVersion(),
    name,
    description,
    paramDefinitions,
  });

  // Show exactly what's going up so stray files/secrets get caught before they
  // leave the machine (the .gitignore guard plus an always-exclude list).
  const files = manifest.files ?? [];
  console.log(`\nUploading ${files.length} file${files.length === 1 ? '' : 's'} (${(zip.length / 1024).toFixed(1)} KB):`);
  for (const f of files) {
    console.log(`  ${f}`);
  }

  const form = new FormData();
  form.append('fluidpkg', new Blob([zip], { type: 'application/zip' }), 'model.fluidpkg');
  if (targetModelId) {
    form.append('modelId', targetModelId);
  }
  if (name) {
    form.append('name', name);
  }
  if (opts.visibility) {
    form.append('visibility', opts.visibility);
  }

  const { status, body } = await new HubClient(hubUrl, creds.token).postForm('/api/publish', form);
  if (status === 401) {
    throw new Error('Your session has expired. Run `fluidcad login` again.');
  }
  if (status === 403) {
    throw new Error(body.error || 'That model belongs to another account.');
  }
  if (status === 422) {
    throw new Error(body.error || 'That FluidCAD version is not hosted yet.');
  }
  if (status !== 200 && status !== 201) {
    throw new Error(body.error || `Publish failed (HTTP ${status})`);
  }

  // Persist the hub-authoritative id (and the name we used) whenever it changed
  // or the workspace had no config — covers the first publish, a deliberate new
  // model, and re-attaching a deleted fluidcad.json (the user picked an existing
  // model from the list). An owned-match with an unchanged name is a no-op.
  if (body.modelId && (body.modelId !== priorModelId || (name && name !== priorName))) {
    writeModelConfig(workspace, { modelId: body.modelId, name });
  }

  console.log('');
  if (body.isNewVersion) {
    console.log(`A new version (v${body.version}) will be published — add details in your browser.`);
  } else {
    console.log('Created model — finish setup in your browser.');
  }

  if (body.formUrl) {
    const formUrl = body.formUrl.startsWith('http') ? body.formUrl : hubUrl + body.formUrl;
    console.log(`\n  ${formUrl}\n`);
    await openBrowser(formUrl);
  } else if (body.shareUrl) {
    // Fallback for a pre-v2 hub that deployed synchronously and has no form.
    console.log(`\n  ${body.shareUrl}\n`);
  }
}

/**
 * Decide which model this publish targets: an existing model id (→ a new
 * version) or null (→ the hub mints a new model). Honors --new-model /
 * --new-version; otherwise asks when interactive; and with no TTY falls back to
 * today's behavior (a saved fluidcad.json id ⇒ a version, else a new model).
 */
async function resolveTargetModel({ opts, hubUrl, token, priorModelId, priorName }) {
  if (opts.newModel && opts.newVersion) {
    throw new Error('Pass only one of --new-model / --new-version.');
  }
  if (opts.newModel) return null;
  if (opts.newVersion) {
    if (priorModelId) return priorModelId;
    if (isInteractive()) return pickExistingModel(hubUrl, token);
    throw new Error(
      'No fluidcad.json here, so there is no model to version. Drop --new-version to ' +
        'publish a new model, or run interactively to pick an existing one.',
    );
  }

  // No explicit flag.
  if (!isInteractive()) {
    // Non-interactive (CI, piped input): keep the historical default.
    return priorModelId;
  }
  if (priorModelId) {
    const label = priorName ? `${priorName} (${priorModelId})` : priorModelId;
    return select('How should this publish go up?', [
      { label: `Publish a new version of ${label}`, value: priorModelId },
      { label: 'Publish as a new model', value: null },
    ]);
  }
  const choice = await select('How should this publish go up?', [
    { label: 'Publish a new version of an existing model', value: '__existing__' },
    { label: 'Publish as a new model', value: null },
  ]);
  return choice === '__existing__' ? pickExistingModel(hubUrl, token) : null;
}

/**
 * Fetch the user's own models from the hub and let them pick which one this is a
 * new version of. Returns the chosen model id, or null when they have none yet
 * (the caller then mints a new model).
 */
async function pickExistingModel(hubUrl, token) {
  const { status, body } = await new HubClient(hubUrl, token).getJson('/api/cli/models');
  if (status === 401) {
    throw new Error('Your session has expired. Run `fluidcad login` again.');
  }
  if (status !== 200) {
    throw new Error(body.error || `Could not list your models (HTTP ${status})`);
  }
  const models = Array.isArray(body.models) ? body.models : [];
  if (models.length === 0) {
    console.log('\nYou have no models on the hub yet — publishing this as a new model.\n');
    return null;
  }
  return select(
    'Which model is this a new version of?',
    models.map((m) => ({
      label: `${m.name} · ${m.latestVersion ? 'v' + m.latestVersion : 'no versions yet'}`,
      value: m.id,
    })),
  );
}

export function registerPublishCommand(program) {
  program
    .command('publish')
    .description('Pack the current model and publish it to the FluidCAD hub')
    .option('-w, --workspace <path>', 'Workspace directory (defaults to cwd)')
    .option('-e, --entry <file>', 'Entry .fluid.js file (auto-detected if only one exists)')
    .option('-n, --name <name>', 'Model name (defaults to the package name)')
    .option('-d, --description <text>', 'Optional human description')
    .option('--new-model', 'Publish as a new model, ignoring any saved model id')
    .option('--new-version', 'Publish a new version of the saved (or chosen) model')
    .option('--visibility <visibility>', 'public | unlisted | private (default: unlisted)')
    .option('--hub <url>', 'Hub base URL (default: the hub you logged into)')
    .action((opts) => {
      runPublish(opts)
        // The render spins up engine + Vite handles; exit explicitly so a
        // successful publish doesn't hang waiting for the loop to drain.
        .then(() => process.exit(0))
        .catch((err) => {
          console.error(err?.message ?? err);
          process.exit(1);
        });
    });
}

// Enforces that every public Feature, Filter, and Constraint listed in
// website/scripts/api-doc-config.ts is documented under llm-docs/api/. The
// authoritative symbol set comes from that config, so adding a new symbol
// there automatically opts it into the gate.
//
// Reasoning behind the design:
//
//   - Types (interfaces) are exempt by default — interfaces don't need their
//     own llm-doc page.
//   - The allowlist (llm-docs/.coverage-allowlist.txt) is committed so opt-outs
//     show up in code review.
//   - Stale claims (a symbol listed in some doc's frontmatter but no longer in
//     api-doc-config.ts) are also fatal — they're how renames slip through.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildManifests } from './build-llm-docs.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DOCS_ROOT = path.join(REPO_ROOT, 'llm-docs');
const ALLOWLIST_FILE = path.join(DOCS_ROOT, '.coverage-allowlist.txt');

// `website/` is a CommonJS workspace, so tsx loads its modules with a CJS
// shim that hides the named exports. Pulling them off `.default` (or the raw
// namespace, for native ESM contexts) keeps the script runnable both ways.
type ApiDocConfig = {
  features: Array<{ name: string }>;
  filters: Array<{ factoryName: string }>;
  constraints: Array<{ functionName: string }>;
};

async function loadApiDocConfig(): Promise<ApiDocConfig> {
  const mod = await import('../website/scripts/api-doc-config.ts');
  const ns = (mod as any).default ?? mod;
  return {
    features: ns.features,
    filters: ns.filters,
    constraints: ns.constraints,
  };
}

function loadAllowlist(): Set<string> {
  if (!fs.existsSync(ALLOWLIST_FILE)) {
    return new Set();
  }
  const out = new Set<string>();
  for (const raw of fs.readFileSync(ALLOWLIST_FILE, 'utf8').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line.length > 0) {
      out.add(line);
    }
  }
  return out;
}

function expectedSymbols(config: ApiDocConfig): Set<string> {
  const out = new Set<string>();
  for (const f of config.features) {
    out.add(f.name);
  }
  for (const f of config.filters) {
    out.add(f.factoryName);
  }
  for (const c of config.constraints) {
    out.add(c.functionName);
  }
  return out;
}

async function main(): Promise<void> {
  const config = await loadApiDocConfig();
  const expected = expectedSymbols(config);
  const allowlist = loadAllowlist();
  const { apiIndex } = buildManifests(DOCS_ROOT);
  const covered = new Set(Object.keys(apiIndex.symbols));

  const missing: string[] = [];
  for (const symbol of expected) {
    if (covered.has(symbol)) {
      continue;
    }
    if (allowlist.has(symbol)) {
      continue;
    }
    missing.push(symbol);
  }
  missing.sort();

  const stale: string[] = [];
  for (const symbol of covered) {
    if (!expected.has(symbol)) {
      stale.push(symbol);
    }
  }
  stale.sort();

  const unusedAllowlist: string[] = [];
  for (const symbol of allowlist) {
    if (covered.has(symbol) || !expected.has(symbol)) {
      unusedAllowlist.push(symbol);
    }
  }
  unusedAllowlist.sort();

  let failed = false;

  if (missing.length > 0) {
    failed = true;
    console.error(
      `\n${missing.length} symbol(s) lack llm-docs coverage:\n` +
        missing.map((s) => `  - ${s}`).join('\n') +
        `\n\nFix by either:\n` +
        `  • adding a doc under llm-docs/api/<symbol>.md that lists the symbol in its frontmatter, or\n` +
        `  • adding the symbol to llm-docs/.coverage-allowlist.txt with a "# reason" comment.`,
    );
  }

  if (stale.length > 0) {
    failed = true;
    console.error(
      `\n${stale.length} symbol claim(s) in llm-docs no longer match website/scripts/api-doc-config.ts:\n` +
        stale.map((s) => `  - ${s}`).join('\n') +
        `\n\nA doc is claiming a symbol that doesn't exist (renamed? removed?). Update the doc's frontmatter or the config.`,
    );
  }

  if (unusedAllowlist.length > 0) {
    failed = true;
    console.error(
      `\n${unusedAllowlist.length} allowlist entry(s) are no longer needed:\n` +
        unusedAllowlist.map((s) => `  - ${s}`).join('\n') +
        `\n\nRemove them from llm-docs/.coverage-allowlist.txt — either the symbol is now documented, or it's no longer exported.`,
    );
  }

  if (failed) {
    process.exit(1);
  }

  console.log(
    `llm-docs coverage OK — ${covered.size} symbol(s) documented, ` +
      `${allowlist.size} allowlisted, out of ${expected.size} expected.`,
  );
}

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});

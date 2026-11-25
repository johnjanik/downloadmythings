// Static checks that need no browser:
//   - every first-party script parses
//   - every file a manifest or HTML page refers to exists in src/
//   - nothing loads code or styles from another origin
//
//   node scripts/check.mjs

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGETS, buildManifest } from './manifest.mjs';
import { prepareTranslations } from './i18n.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const problems = [];

async function listFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(full));
    else files.push(full);
  }
  return files;
}

const allFiles = await listFiles(srcDir);
const rel = (file) => path.relative(root, file);

// 1. Syntax
for (const file of allFiles) {
  if (!file.endsWith('.js') || file.includes(`${path.sep}vendor${path.sep}`)) continue;
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    problems.push(`Syntax error in ${rel(file)}:\n${error.stderr}`);
  }
}

// 2. Files named by the manifests
function manifestFiles(manifest) {
  const toolbar = manifest.action || manifest.browser_action;
  return [
    ...Object.values(manifest.icons),
    ...Object.values(toolbar.default_icon),
    toolbar.default_popup,
    ...manifest.content_scripts.flatMap((entry) => [...entry.js, ...(entry.css || [])]),
    manifest.background.service_worker,
    ...(manifest.background.scripts || []),
    manifest.options_page,
    manifest.options_ui && manifest.options_ui.page,
    manifest.side_panel && manifest.side_panel.default_path,
    manifest.sidebar_action && manifest.sidebar_action.default_panel,
  ].filter(Boolean);
}

for (const target of TARGETS) {
  for (const file of manifestFiles(buildManifest(target, '0.0.0'))) {
    if (!existsSync(path.join(srcDir, file))) {
      problems.push(`${target} manifest refers to a missing file: ${file}`);
    }
  }
}

// 3. Scripts and stylesheets named by the HTML pages
for (const file of allFiles) {
  if (!file.endsWith('.html')) continue;
  const html = await readFile(file, 'utf8');
  const refs = [...html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  for (const ref of refs) {
    if (/^[a-z]+:|^\/\//i.test(ref)) {
      problems.push(`${rel(file)} loads a remote resource: ${ref}`);
    } else if (!existsSync(path.join(path.dirname(file), ref))) {
      problems.push(`${rel(file)} refers to a missing file: ${ref}`);
    }
  }
}

// 4. Translations: every t() call can be found, and every translation keeps its {markers}
const translations = await prepareTranslations();
problems.push(...translations.problems);
const incomplete = Object.entries(translations.report)
  .filter(([, result]) => result.missing.length > 0 || result.unused.length > 0)
  .map(([lang, result]) => `${lang} (${result.missing.length} missing, ${result.unused.length} unused)`);

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`OK: ${allFiles.length} source files checked for ${TARGETS.join(' and ')}`);
console.log(`OK: ${translations.total} strings, ${Object.keys(translations.report).length} translations`);
// Untranslated strings fall back to English; they are worth knowing about but break nothing
if (incomplete.length > 0) console.log(`Note: translations to bring up to date (npm run i18n -- --verbose): ${incomplete.join(', ')}`);

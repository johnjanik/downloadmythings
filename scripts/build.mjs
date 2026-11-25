// Build the extension for each browser from the single source tree in src/.
//
//   node scripts/build.mjs          -> dist/chrome/ and dist/firefox/ (load these unpacked)
//   node scripts/build.mjs --zip    -> also dist/downloadmythings-<browser>-v<version>.zip
//
// No bundler and no dependencies: files are copied as they are and the
// manifest is generated. The ZIPs are reproducible: the same commit always
// produces byte-identical archives, so a store build can be checked against
// the source.

import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGETS, buildManifest } from './manifest.mjs';
import { prepareTranslations } from './i18n.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const distDir = path.join(root, 'dist');
const wantZip = process.argv.includes('--zip');

// Fixed timestamp for every ZIP entry (ZIP stores local time; pin the zone too)
process.env.TZ = 'UTC';
const ZIP_ENTRY_DATE = new Date(Date.UTC(2020, 0, 1));

async function listFiles(dir, base = dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(full, base));
    else files.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return files.sort();
}

async function zipDirectory(dir, zipPath) {
  // JSZip is already vendored for the extension itself; reuse it here.
  const JSZip = createRequire(import.meta.url)(path.join(srcDir, 'vendor', 'jszip.min.js'));
  const zip = new JSZip();
  for (const file of await listFiles(dir)) {
    zip.file(file, await readFile(path.join(dir, file)), {
      date: ZIP_ENTRY_DATE,
      unixPermissions: 0o644,
      createFolders: false,
    });
  }
  const data = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    platform: 'UNIX',
  });
  await writeFile(zipPath, data);
}

const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

// Every string in the interface, in every language (see scripts/i18n.mjs)
const translations = await prepareTranslations();
if (translations.problems.length > 0) {
  console.error(translations.problems.join('\n'));
  process.exit(1);
}

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

for (const target of TARGETS) {
  const outDir = path.join(distDir, target);
  await cp(srcDir, outDir, { recursive: true });
  await writeFile(
    path.join(outDir, 'manifest.json'),
    JSON.stringify(buildManifest(target, version), null, 2) + '\n'
  );
  for (const [file, messages] of Object.entries(translations.files)) {
    await mkdir(path.dirname(path.join(outDir, file)), { recursive: true });
    await writeFile(path.join(outDir, file), JSON.stringify(messages, null, 1) + '\n');
  }
  console.log(`dist/${target}/  (v${version}, ${Object.keys(translations.messages).length} languages)`);

  if (wantZip) {
    const zipName = `downloadmythings-${target}-v${version}.zip`;
    await zipDirectory(outDir, path.join(distDir, zipName));
    console.log(`dist/${zipName}`);
  }
}

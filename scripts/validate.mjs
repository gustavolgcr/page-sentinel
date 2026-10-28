// Validates the extension before packaging: manifest fields, referenced
// files and JavaScript syntax. Exits with an error if anything is wrong.
// Usage: node scripts/validate.mjs

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const fail = (msg) => errors.push(msg);

// 1. Manifest
let manifest;
try {
  manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
} catch (e) {
  console.error(`manifest.json is not valid JSON: ${e.message}`);
  process.exit(1);
}

if (manifest.manifest_version !== 3) fail('manifest_version must be 3.');
for (const key of ['name', 'version', 'description']) {
  if (!manifest[key]) fail(`manifest.json is missing "${key}".`);
}
if (manifest.version && !/^\d+(\.\d+){0,3}$/.test(manifest.version)) {
  fail(`Invalid version "${manifest.version}" (use 1 to 4 dot-separated numbers).`);
}
if (manifest.description && manifest.description.length > 132) {
  fail('The description is longer than the 132 characters the Chrome Web Store allows.');
}

// 2. Every file the manifest points to must exist
const referenced = [
  manifest.background && manifest.background.service_worker,
  manifest.action && manifest.action.default_popup,
  ...Object.values((manifest.action && manifest.action.default_icon) || {}),
  ...Object.values(manifest.icons || {}),
  ...(manifest.content_scripts || []).flatMap((cs) => [...(cs.js || []), ...(cs.css || [])]),
  'offscreen.html',
].filter(Boolean);

for (const file of referenced) {
  if (!existsSync(join(root, file))) fail(`Missing file referenced by the extension: ${file}`);
}

// 3. JavaScript syntax
const jsFiles = readdirSync(root).filter((f) => f.endsWith('.js'));
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'pipe' });
  } catch (e) {
    fail(`Syntax error in ${file}:\n${e.stderr.toString().trim()}`);
  }
}

if (errors.length) {
  console.error(errors.map((e) => `✗ ${e}`).join('\n'));
  process.exit(1);
}
console.log(`✓ ${manifest.name} ${manifest.version}: manifest, ${referenced.length} referenced files and ${jsFiles.length} scripts are valid.`);

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(join(root, path), 'utf8');
const packages = new Map();
function visit(name, from = root) {
  let folder = from;
  let packageFile;
  while (folder !== dirname(folder)) {
    const candidate = join(folder, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) { packageFile = candidate; break; }
    folder = dirname(folder);
  }
  if (!packageFile) throw new Error('Missing dependency manifest: ' + name);
  if (packages.has(packageFile)) return;
  const info = JSON.parse(readFileSync(packageFile, 'utf8'));
  const packageDir = dirname(packageFile);
  const licenseFile = readdirSync(packageDir).find(file => /^licen[sc]e(?:\.(?:md|txt))?$/i.test(file));
  const licenseText = licenseFile ? readFileSync(join(packageDir, licenseFile), 'utf8') : name.startsWith('@radix-ui/') && info.license === 'MIT' ? read('node_modules/@radix-ui/react-slot/LICENSE') : name === 'react-remove-scroll-bar' && info.license === 'MIT' ? read('licenses/react-remove-scroll-bar-MIT.txt') : null;
  if (!licenseText) throw new Error('Missing dependency license: ' + name);
  packages.set(packageFile, name + ' ' + info.version + ' — ' + info.license + '\n\n' + licenseText);
  for (const dependency of Object.keys(info.dependencies ?? {})) visit(dependency, packageDir);
}
const manifest = JSON.parse(read('package.json'));
for (const name of Object.keys(manifest.dependencies)) visit(name);
const sections = ['CC Switch Android — third-party notices\n\nUpstream CC Switch 4.0.33, commit fc3eb797c72e054d554eea6a2e7a8b93933c6ac5.\nCopied/adapted: Sidebar, AppPageHeader, UI controls, PromptListItem, Chinese locale, stylesheet, icons, Codex template and text normalization. Codex configuration projection semantics ported from Rust.\n\n' + read('LICENSE'), ...packages.values()];
sections.push('AndroidX libraries (including WebKit), Kotlin standard library, JetBrains annotations and JSpecify\nCopyright their respective authors, Android Open Source Project contributors, JetBrains and JSpecify contributors.\nDistributed under Apache License 2.0. Resolved versions: see docs/android-dependencies.txt.\n\n' + read('licenses/Apache-2.0.txt'));
writeFileSync(join(root, 'THIRD_PARTY_NOTICES.txt'), sections.join('\n\n' + '='.repeat(72) + '\n\n'), 'utf8');
console.log('Included licenses for ' + packages.size + ' runtime dependencies.');

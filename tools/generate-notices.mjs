import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(join(root, path), 'utf8');
const packages = ['react', 'react-dom', 'scheduler', 'lucide-react', 'smol-toml', 'loose-envify', 'js-tokens'];
const sections = ['CC Switch Android — third-party notices\n\nUpstream CC Switch 4.0.33, commit fc3eb797c72e054d554eea6a2e7a8b93933c6ac5.\nCopied/adapted: Codex template, text normalization, design tokens, logos; Codex projection semantics ported to TypeScript.\n\n' + read('LICENSE')];
for (const name of packages) {
  const info = JSON.parse(read(`node_modules/${name}/package.json`));
  sections.push(`${name} ${info.version} — ${info.license}\n\n${read(`node_modules/${name}/LICENSE`)}`);
}
sections.push('AndroidX libraries (including WebKit), Kotlin standard library, JetBrains annotations and JSpecify\nCopyright their respective authors, Android Open Source Project contributors, JetBrains and JSpecify contributors.\nDistributed under Apache License 2.0. Resolved versions: see docs/android-dependencies.txt.\n\n' + read('licenses/Apache-2.0.txt'));
writeFileSync(join(root, 'THIRD_PARTY_NOTICES.txt'), sections.join('\n\n' + '='.repeat(72) + '\n\n'), 'utf8');

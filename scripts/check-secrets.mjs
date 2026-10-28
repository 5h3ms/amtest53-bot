import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const skipped = new Set(['node_modules', '.git', 'lib', '.local', '.firebase', '.emulator-data', 'coverage', 'private-materials']);
function walk(path = '.') {
  return readdirSync(path).flatMap(name => {
    if (skipped.has(name) || (name.startsWith('.env') && name !== '.env.example') || name === '.secret.local' || name.endsWith('.log')) return [];
    const file = join(path, name);
    return statSync(file).isDirectory() ? walk(file) : [file];
  });
}
let files;
try { files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean); }
catch { files = walk(); }
const patterns = [
  ['Telegram token', /\b\d{6,12}:[A-Za-z0-9_-]{25,}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/],
  ['Google API credential', /\bAIza[A-Za-z0-9_-]{30,}\b/],
  ['Private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['Service account credentials', /"type"\s*:\s*"service_account"/],
];
let failed = false;
for (const file of [...new Set(files)]) {
  if (/(?:^|\/)(?:\.local|\.emulator-data|private-materials)(?:\/|$)|\.(?:xlsx|xls|pem|key)$/i.test(file)) {
    console.error(`Private data or credential file must not be tracked: ${file}`); failed = true; continue;
  }
  if (/(?:^|\/)(?:\.env(?:\..*)?|\.secret\.local|credentials[^/]*\.json|[^/]*service[-_]?account[^/]*\.json)$/i.test(file) && file !== '.env.example') {
    console.error(`Forbidden tracked file: ${file}`); failed = true; continue;
  }
  if (statSync(file).size > 2_000_000) continue;
  const text = readFileSync(file, 'utf8');
  for (const [label, pattern] of patterns) {
    const match = pattern.exec(text);
    if (match) { console.error(`${label}: ${file}:${text.slice(0, match.index).split('\n').length} (value hidden)`); failed = true; }
  }
}
if (failed) process.exitCode = 1;
else console.log('Secret-pattern and tracked-file checks passed. This is an additional check, not a guarantee.');

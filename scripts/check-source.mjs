import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

let count = 0;
for (const root of ['src', 'scripts', 'tests', 'prototypes']) {
  const entries = await readdir(root, { recursive: true });
  for (const entry of entries.filter(name => name.endsWith('.mjs'))) {
    const result = spawnSync(process.execPath, ['--check', `${root}/${entry}`], { encoding: 'utf8' });
    if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(1); }
    count++;
  }
}
console.log(`PASS: syntax checked ${count} JavaScript modules`);

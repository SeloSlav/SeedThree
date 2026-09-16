import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const suites = readdirSync(scriptDirectory)
  .filter((fileName) => /^test-.*\.mjs$/i.test(fileName))
  .sort();

if (suites.length === 0) {
  throw new Error('No SeedThree test-*.mjs suites were discovered.');
}

let failures = 0;
for (const suite of suites) {
  console.log(`\n==> SeedThree ${suite}`);
  const result = spawnSync(process.execPath, [join(scriptDirectory, suite)], {
    stdio: 'inherit',
  });
  if (result.status !== 0) failures += 1;
}

if (failures > 0) {
  throw new Error(`${failures} SeedThree renderer suite(s) failed.`);
}

console.log(`\nAll ${suites.length} SeedThree renderer suites passed.`);

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Third-party code is vendored byte for byte from its npm release, so anyone
// can check it against the published package. A change to these files must be
// a deliberate version bump, with the new hash recorded here.
const VENDORED = {
  // jszip@3.10.1, dist/jszip.min.js
  'jszip.min.js': 'acc7e41455a80765b5fd9c7ee1b8078a6d160bbbca455aeae854de65c947d59e',
  // marked@18.3.0, lib/marked.umd.js
  'marked.umd.js': 'f8c7f128939415995e2219e8a84bec42fab27f5980d22e361339e6901da5eadf',
};

describe('vendored libraries', () => {
  const vendorDir = path.resolve(import.meta.dirname, '..', 'src', 'vendor');

  for (const [file, expected] of Object.entries(VENDORED)) {
    it(`${file} matches its published release`, () => {
      const actual = createHash('sha256').update(readFileSync(path.join(vendorDir, file))).digest('hex');
      expect(actual).toBe(expected);
    });
  }
});

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { EXTENSION_RUNTIME_ASSETS, EXTENSION_RUNTIME_DIR } from './extension-runtime';

const extension = join(import.meta.dir, '..', 'extension', EXTENSION_RUNTIME_DIR);
const output = join(import.meta.dir, '..', 'dist', 'extension', EXTENSION_RUNTIME_DIR);

await mkdir(output, { recursive: true });
await Promise.all(EXTENSION_RUNTIME_ASSETS.map(name => rm(join(import.meta.dir, '..', 'dist', 'extension', name), { force: true })));
for (const name of EXTENSION_RUNTIME_ASSETS) {
  await Bun.write(join(output, name), Bun.file(join(extension, name)));
}
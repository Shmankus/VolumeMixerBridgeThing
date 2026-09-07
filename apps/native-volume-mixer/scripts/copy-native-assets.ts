import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const extension = join(import.meta.dir, '..', 'extension');
const output = join(import.meta.dir, '..', 'dist', 'extension');

await mkdir(output, { recursive: true });
for (const name of ['mixer-helper.cjs', 'mixer-worker.cjs', 'win-sound-mixer.node']) {
  await Bun.write(join(output, name), Bun.file(join(extension, name)));
}
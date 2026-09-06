import { createWriteStream } from 'node:fs';
import { readdir, rename } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { cwd } from 'node:process';
import yazl from 'yazl';

const root = join(cwd(), 'dist');
const outputPath = join(cwd(), 'volume-mixer-bridgething.zip');
const temporaryPath = join(cwd(), `volume-mixer-${process.pid}-${Date.now()}.tmp.zip`);
const archive = new yazl.ZipFile();

async function addDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await addDirectory(path);
    else archive.addFile(path, relative(root, path).replaceAll('\\', '/'));
  }
}

await addDirectory(root);
const output = createWriteStream(temporaryPath);
archive.outputStream.pipe(output);
archive.end();
await new Promise((resolve, reject) => {
  output.on('close', resolve);
  archive.outputStream.on('error', reject);
  output.on('error', reject);
});

try {
  await rename(temporaryPath, outputPath);
  console.log(`Created ${outputPath}`);
} catch (error) {
  if (error?.code !== 'EBUSY' && error?.code !== 'EPERM') throw error;
  const fallbackPath = join(cwd(), `volume-mixer-bridgething-${Date.now()}.zip`);
  await rename(temporaryPath, fallbackPath);
  console.warn(`The default ZIP is locked. Created ${fallbackPath} instead.`);
}

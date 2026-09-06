import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

await mkdir('dist/extension', { recursive: true });
await build({
  entryPoints: ['extension/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
  outfile: 'dist/extension/desktop.mjs',
  external: ['node:module'],
});
await cp('public/win-sound-mixer.node', 'dist/extension/win-sound-mixer.node');
await cp('extension/mixer-helper.cjs', 'dist/extension/mixer-helper.cjs');

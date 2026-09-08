// Node-side bridge: delegates Windows mixer work to a fresh worker.
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

/** Runs one fresh native-mixer worker so endpoint changes cannot leave stale state. */
function handle(request) {
  // A new process forces native-sound-mixer to enumerate the current Windows devices.
  const worker = spawnSync(process.execPath, [path.join(__dirname, 'mixer-worker.cjs')], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    windowsHide: true,
  });
  if (worker.error) throw worker.error;
  const response = JSON.parse(worker.stdout || '{}');
  if (response.error) throw new Error(response.error);
  return { id: request.id, apps: response.apps };
}

const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  let request;
  try {
    request = JSON.parse(line);
    process.stdout.write(`${JSON.stringify(handle(request))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ id: request?.id ?? null, error: String(error) })}\n`);
  }
});

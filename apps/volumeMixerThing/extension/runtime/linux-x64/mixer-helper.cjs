// Node-side bridge: delegates Windows mixer work to a fresh worker.
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

function handle(request) {
  const worker = spawnSync(process.execPath, [path.join(__dirname, 'mixer-worker.cjs')], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'inherit'] // <-- FORWARD WORKER ERRORS TO TERMINAL
  });
  
  if (worker.error) throw worker.error;
  if (worker.status !== 0) throw new Error(`Worker exited with code ${worker.status}`);

  const response = JSON.parse(worker.stdout || '{}');
  if (response.error) throw new Error(response.error);
  return { id: request.id, apps: response.apps };
}

const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  let requestId = null;
  try {
    const request = JSON.parse(line);
    requestId = request?.id;
    const result = handle(request);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    // Safely write the error back to Deno without breaking stdout structure
    process.stdout.write(`${JSON.stringify({ id: requestId, error: error.message || String(error) })}\n`);
  }
});

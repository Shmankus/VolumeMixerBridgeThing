// Node-side bridge: runs Windows media keys and delegates mixer work to a fresh worker.
const readline = require('node:readline');
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');

/** Sends a Windows media-key press without opening a visible PowerShell window. */
function sendMediaKey(key) {
  const script = `Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NativeMethods {
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extraInfo);
}
'@
[NativeMethods]::keybd_event(${key}, 0, 0, [UIntPtr]::Zero)
[NativeMethods]::keybd_event(${key}, 0, 2, [UIntPtr]::Zero)`;
  execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { windowsHide: true, stdio: 'ignore' });
}

/** Runs one fresh native-mixer worker so endpoint changes cannot leave stale state. */
function handle(request) {
  if (request.type === 'playback:previous') sendMediaKey(0xB1);
  if (request.type === 'playback:playPause') sendMediaKey(0xB3);
  if (request.type === 'playback:next') sendMediaKey(0xB0);
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
  try {
    process.stdout.write(`${JSON.stringify(handle(JSON.parse(line)))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ id: null, error: String(error) })}\n`);
  }
});

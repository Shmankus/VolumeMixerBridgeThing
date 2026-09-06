const readline = require('node:readline');
const { execFileSync } = require('node:child_process');
const mixerModule = require('./win-sound-mixer.node');
const mixer = mixerModule.SoundMixer ?? mixerModule.default ?? mixerModule;

const watchedApps = [
  { id: 'Discord', names: ['discord'] },
  { id: 'Firefox', names: ['firefox', 'mozilla firefox'] },
  { id: 'AMPLibraryAgent', names: ['amplibraryagent'] },
];

function cleanName(value) {
  return value.split(/[\\/]/).at(-1)?.replace(/\.exe$/i, '').toLowerCase() ?? '';
}

function sessions() {
  return (mixer.devices ?? []).flatMap(device => device.sessions ?? []);
}

function snapshot() {
  return Object.fromEntries(watchedApps.map(app => {
    const session = sessions().find(item => app.names.includes(cleanName(item.appName ?? item.name ?? '')));
    return [app.id, {
      volume: session ? Math.round((session.volume ?? 0) * 100) : -1,
      muted: Boolean(session?.mute),
    }];
  }));
}

function findSessions(appName) {
  const app = watchedApps.find(item => item.id === appName);
  return sessions().filter(item => app?.names.includes(cleanName(item.appName ?? item.name ?? '')));
}

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

function handle(request) {
  if (request.type === 'playback:previous') sendMediaKey(0xB1);
  if (request.type === 'playback:playPause') sendMediaKey(0xB3);
  if (request.type === 'playback:next') sendMediaKey(0xB0);
  if (request.type === 'volume:set' && Number.isFinite(request.volume)) {
    for (const session of findSessions(request.appName)) {
      session.volume = Math.max(0, Math.min(100, request.volume)) / 100;
    }
  }
  if (request.type === 'volume:toggleMute') {
    for (const session of findSessions(request.appName)) session.mute = !session.mute;
  }
  return { id: request.id, apps: snapshot() };
}

const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  try {
    process.stdout.write(`${JSON.stringify(handle(JSON.parse(line)))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ id: null, error: String(error) })}\n`);
  }
});

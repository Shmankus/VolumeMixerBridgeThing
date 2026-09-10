// Short-lived native mixer worker: reloads the addon to discover current audio sessions.
const readline = require('node:readline');
const mixerModule = require('./win-sound-mixer.node');
const mixer = mixerModule.SoundMixer ?? mixerModule.default ?? mixerModule;

// global state for the worker: the list of apps to watch for volume changes.
let watchedApps = [];



function cleanName(value) {
  return value.split(/[\\/]/).at(-1)?.replace(/\.exe$/i, '').toLowerCase() ?? '';
}

/** Enumerates sessions from a newly loaded native addon instance. */
function sessions() {
  return (mixer.devices ?? []).flatMap(device => device.sessions ?? []);
}

/** Converts native session objects into the small JSON shape sent to the UI. */
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

/** Applies one volume operation before returning a fresh snapshot. */
function handle(request) {
  if (request.type === 'volume:set' && Number.isFinite(request.volume)) {
    for (const session of findSessions(request.appName)) {
      session.volume = Math.max(0, Math.min(100, request.volume)) / 100;
    }
  }
  if (request.type === 'volume:toggleMute') {
    for (const session of findSessions(request.appName)) session.mute = !session.mute;
  }
  return snapshot();
}

// Single stdin reader for processing worker request
let appsinput = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { appsinput += chunk; });
process.stdin.on('end', () => {
  try {
    const parsedRequest = JSON.parse(appsinput);

    //mixer-helper -> watchedApps (global) -> back to UI
    if (parsedRequest.watchedAppsConfig) {
      watchedApps = parsedRequest.watchedAppsConfig;
    }

    // handles needed info then -> mixer-helper
    process.stdout.write(JSON.stringify({ apps: handle(parsedRequest) }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: String(error) }));
    process.exitCode = 1;
  }
});


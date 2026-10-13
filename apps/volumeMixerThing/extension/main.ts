/**
 * @fileoverview This file handles the server side of the volume mixer extension. It picks the audio backend for the
 * desktop's OS, matches its sessions against the apps the user tracks, and relays state to and from the webapp.
 *
 * @module main
 * @requires bridgething-extension
 *
 */

import { asJson, defineExtension, json } from '@bridgething/extension';
import { linuxBackend } from './backends/linux';
import { macosBackend } from './backends/macos';
import { cleanName, Deno, type MixerBackend, type Session } from './backends/shared';
import { windowsBackend } from './backends/windows';

// The webapp can send messages to the extension to request mixer state or change volume.
type MixerMessage =
  | { type: 'volume:refresh' }
  | { type: 'volume:set'; appName: string; volume: number }
  | { type: 'volume:toggleMute'; appName: string };
// The webapp can send log messages to the extension log for debugging purposes.
type AppMessage =
  | { type: 'app:log'; message: string }
  | { type: 'apps_settings:update'; message: string }
  | MixerMessage;

type AppState = Record<string, { volume: number; muted: boolean }>;
type TrackedApp = { id: string; names: string[] };

let trackedApps: TrackedApp[] = [];

// turn Firefox|{firefox,mozilla firefox} into {id: "Firefox", names: ["firefox", "mozilla firefox"]}
function readSettingsFromString(settings: string): TrackedApp[] {
  const apps: TrackedApp[] = [];
  for (const entry of settings.split(/,(?![^{]*\})/)) {
    const [id, names] = entry.split('|');
    if (!id || !names) continue;
    const namesArray = names.replace(/^\s*\{|\}\s*$/g, '').split(',').map(cleanName).filter(Boolean);
    if (namesArray.length > 0) apps.push({ id: id.trim(), names: namesArray });
  }
  return apps;
}

function sessionsFor(app: TrackedApp | undefined, sessions: Session[]): Session[] {
  if (!app) return [];
  return sessions.filter(session => session.names.some(name => app.names.includes(cleanName(name))));
}

/** Converts backend sessions into the small JSON shape sent to the UI. -1 means the app is not playing audio. */
function snapshot(sessions: Session[]): AppState {
  return Object.fromEntries(trackedApps.map(app => {
    const session = sessionsFor(app, sessions)[0];
    return [app.id, { volume: session ? session.volume : -1, muted: Boolean(session?.muted) }];
  }));
}

function createBackend(): MixerBackend {
  const os = Deno?.build?.os;
  if (os === 'windows') return windowsBackend();
  if (os === 'linux') return linuxBackend();
  if (os === 'darwin') return macosBackend();
  throw new Error(os ? `no volume mixer backend for ${os}` : 'The desktop extension requires Deno');
}

let backend: MixerBackend | undefined;
let poll: ReturnType<typeof setInterval> | undefined;
let backendError: unknown;
try {
  backend = createBackend();
} catch (error) {
  backendError = error;
}

/** Applies one webapp request, then returns the fresh state. */
async function handle(mixer: MixerBackend, message: MixerMessage): Promise<AppState> {
  if (message.type === 'volume:set' || message.type === 'volume:toggleMute') {
    const matching = sessionsFor(trackedApps.find(app => app.id === message.appName), await mixer.list());
    const keys = [...new Set(matching.map(session => session.key))];
    if (keys.length > 0 && message.type === 'volume:set' && Number.isFinite(message.volume)) {
      await mixer.setVolume(keys, Math.max(0, Math.min(100, message.volume)));
    }
    if (keys.length > 0 && message.type === 'volume:toggleMute') {
      await mixer.setMuted(keys, !matching[0].muted);
    }
  }
  return snapshot(await mixer.list());
}

defineExtension({
  start(ctx) {
    let apps: AppState = {};
    let lastSetTime = 0; // Track the last time a user changed volume
    let lastError = '';
    const sendState = () => ctx.broadcast(json({ type: 'volume:state', apps }));

    // the poll fails every 2s while a backend is broken, so only log when the reason changes
    const reportError = (error: unknown) => {
      const text = String(error);
      if (text !== lastError) ctx.log.error('Volume mixer failed:', text);
      lastError = text;
    };

    if (backendError) {
      ctx.log.error('Volume mixer unavailable:', backendError);
      ctx.broadcast(json({ type: 'volume:error', message: `Volume mixer unavailable: ${String(backendError)}` }));
    }

    const request = (message: MixerMessage) => {
      if (!backend) return sendState();
      if (message.type === 'volume:set') lastSetTime = Date.now();
      handle(backend, message).then(next => {
        // a poll that raced a drag would snap the slider back to the old value
        if (message.type === 'volume:refresh' && Date.now() - lastSetTime < 3000) return;
        apps = next;
        lastError = '';
        sendState();
      }).catch(reportError);
    };

    ctx.on('device', event => {
      if (event.type === 'connected' || event.type === 'active') request({ type: 'volume:refresh' });
    });

    ctx.on('message', (_device, message) => {
      const payload = asJson<AppMessage>(message);
      if (!payload) return;

      if (payload.type === 'app:log') {
        ctx.log.info('webapp log:', payload.message);
        return;
      }

      // client -> extension -> global state update for tracked apps
      if (payload.type === 'apps_settings:update') {
        trackedApps = readSettingsFromString(payload.message);
        ctx.log.info('new apps settings received:', JSON.stringify(trackedApps));
        request({ type: 'volume:refresh' });
        return;
      }

      request(payload);
    });

    request({ type: 'volume:refresh' });
    poll = setInterval(() => request({ type: 'volume:refresh' }), 2_000);

    ctx.log.info('Volume mixer extension ready');
  },
  stop() {
    clearInterval(poll);
    backend?.stop?.();
  },
});

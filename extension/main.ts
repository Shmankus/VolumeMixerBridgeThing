import { asJson, defineExtension, json } from '@bridgething/extension';

type MixerMessage =
  | { type: 'volume:refresh' }
  | { type: 'volume:set'; appName: string; volume: number }
  | { type: 'volume:toggleMute'; appName: string }
  | { type: 'playback:previous' }
  | { type: 'playback:playPause' }
  | { type: 'playback:next' };

type AppState = Record<string, { volume: number; muted: boolean }>;
type MixerClient = { request(message: MixerMessage): Promise<AppState> };

type Mixer = { devices?: any[] };
let mixer: Mixer = { devices: [] };
let mixerClient: MixerClient | undefined;
let nativeLoadError: unknown;

function fileUrlToWindowsPath(url: URL): string {
  const path = decodeURIComponent(url.pathname);
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1).replaceAll('/', '\\') : path;
}

function createMixerClient(deno: any): MixerClient {
  const helperPath = fileUrlToWindowsPath(new URL('./mixer-helper.cjs', import.meta.url));
  const process = new deno.Command('C:\\Program Files\\nodejs\\node.exe', {
    args: [helperPath],
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
    windowsHide: true,
  }).spawn();
  const writer = process.stdin.getWriter();
  const reader = process.stdout.pipeThrough(new TextDecoderStream()).getReader();
  const errorReader = process.stderr.pipeThrough(new TextDecoderStream()).getReader();
  const pending = new Map<number, { resolve: (apps: AppState) => void; reject: (error: unknown) => void }>();
  let nextId = 1;

  void (async () => {
    let error = '';
    while (true) {
      const { done, value } = await errorReader.read();
      if (done) break;
      error += value;
    }
    if (error.trim()) console.error(`Mixer helper: ${error.trim()}`);
  })();

  void (async () => {
    let buffered = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += value;
      for (let cut = buffered.indexOf('\n'); cut >= 0; cut = buffered.indexOf('\n')) {
        const line = buffered.slice(0, cut);
        buffered = buffered.slice(cut + 1);
        try {
          const response = JSON.parse(line) as { id: number; apps?: AppState; error?: string };
          const waiting = pending.get(response.id);
          if (!waiting) continue;
          pending.delete(response.id);
          if (response.error || !response.apps) waiting.reject(new Error(response.error ?? 'Mixer helper returned no state'));
          else waiting.resolve(response.apps);
        } catch (error) {
          for (const waiting of pending.values()) waiting.reject(error);
          pending.clear();
        }
      }
    }
  })();

  return {
    request(message) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        writer.write(new TextEncoder().encode(`${JSON.stringify({ ...message, id })}\n`)).catch(reject);
      });
    },
  };
}

const deno = (globalThis as any).Deno;
if (deno) {
  try {
    mixerClient = createMixerClient(deno);
  } catch (error) {
    nativeLoadError = error;
  }
} else {
  try {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const addon = require('./win-sound-mixer.node');
    mixer = addon.SoundMixer ?? addon.default ?? addon;
  } catch (error) {
    nativeLoadError = error;
  }
}

const watchedApps = [
  { id: 'Discord', names: ['discord'] },
  { id: 'Firefox', names: ['firefox', 'mozilla firefox'] },
  { id: 'AMPLibraryAgent', names: ['amplibraryagent'] },
];

function cleanName(value: string): string {
  return value.split(/[\\/]/).at(-1)?.replace(/\.exe$/i, '').toLowerCase() ?? '';
}

function sessionName(session: any): string {
  return session.appName ?? session.name ?? '';
}

function sessions(): any[] {
  return (mixer.devices ?? []).flatMap(device => device.sessions ?? []);
}

function snapshot(): AppState {
  return Object.fromEntries(watchedApps.map(app => {
    const session = sessions().find(item => app.names.includes(cleanName(sessionName(item))));
    return [app.id, {
      volume: session ? Math.round((session.volume ?? 0) * 100) : -1,
      muted: Boolean(session?.mute),
    }];
  }));
}

function findSessions(appName: string): any[] {
  const app = watchedApps.find(item => item.id === appName);
  return sessions().filter(item => app?.names.includes(cleanName(sessionName(item))));
}

defineExtension({
  start(ctx) {
    if (nativeLoadError) ctx.log.error('Native mixer failed to load:', nativeLoadError);

    let apps: AppState = {};
    const sendState = () => ctx.broadcast(json({ type: 'volume:state', apps: mixerClient ? apps : snapshot() }));
    if (nativeLoadError) {
      ctx.broadcast(json({ type: 'volume:error', message: `Windows mixer unavailable: ${String(nativeLoadError)}` }));
    }
    const refreshState = () => mixerClient?.request({ type: 'volume:refresh' }).then(next => {
      apps = next;
      sendState();
    }).catch(error => {
      ctx.log.error('Mixer helper failed:', error);
      ctx.broadcast(json({ type: 'volume:error', message: `Windows mixer unavailable: ${String(error)}` }));
    });
    ctx.on('device', event => {
      if (event.type === 'connected' || event.type === 'active') refreshState() ?? sendState();
    });
    ctx.on('message', (_device, message) => {
      const payload = asJson<MixerMessage>(message);
      if (!payload) return;
      if (mixerClient) {
        void mixerClient.request(payload).then(next => {
          apps = next;
          sendState();
        }).catch(error => {
          ctx.log.error('Mixer helper failed:', error);
          ctx.broadcast(json({ type: 'volume:error', message: `Windows mixer unavailable: ${String(error)}` }));
        });
        return;
      }
      if (payload.type === 'volume:set' && Number.isFinite(payload.volume)) {
        for (const session of findSessions(payload.appName)) {
          session.volume = Math.max(0, Math.min(100, payload.volume)) / 100;
        }
      }
      if (payload.type === 'volume:toggleMute') {
        for (const session of findSessions(payload.appName)) session.mute = !session.mute;
      }
      sendState();
    });
    refreshState();
    setInterval(sendState, 2_000);
    ctx.log.info('Volume mixer extension ready');
  },
});

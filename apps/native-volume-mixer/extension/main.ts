// BridgeThing desktop extension: forwards webapp commands to the Windows mixer.
import { asJson, defineExtension, json } from '@bridgething/extension';

type MixerMessage =
  | { type: 'volume:refresh' }
  | { type: 'volume:set'; appName: string; volume: number }
  | { type: 'volume:toggleMute'; appName: string };

type AppState = Record<string, { volume: number; muted: boolean }>;
type MixerClient = { request(message: MixerMessage): Promise<AppState> };

let mixerClient: MixerClient | undefined;
let nativeLoadError: unknown;

function fileUrlToWindowsPath(url: URL): string {
  // BridgeThing's Deno build does not expose Deno.fromFileUrl, so convert the
  // helper URL without depending on a Deno-only utility.
  const path = decodeURIComponent(url.pathname);
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1).replaceAll('/', '\\') : path;
}

/** Starts the hidden Node bridge that can load the Windows-only native addon. */
function createMixerClient(deno: any): MixerClient {
  const helperPath = fileUrlToWindowsPath(new URL('./runtime/win32-x64/mixer-helper.cjs', import.meta.url));
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

  // Keep stderr separate from stdout: stdout is a line-delimited JSON protocol.
  void (async () => {
    let error = '';
    while (true) {
      const { done, value } = await errorReader.read();
      if (done) break;
      error += value;
    }
    if (error.trim()) console.error(`Mixer helper: ${error.trim()}`);
  })();

  // Responses are correlated locally because the helper is a fire-and-forget
  // process stream rather than a request/response API.
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
  nativeLoadError = new Error('The desktop extension requires Deno');
}

defineExtension({
  start(ctx) {
    if (nativeLoadError) ctx.log.error('Native mixer failed to load:', nativeLoadError);

    let apps: AppState = {};
    const sendState = () => ctx.broadcast(json({ type: 'volume:state', apps }));
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
      if (!mixerClient) return;
      void mixerClient.request(payload).then(next => {
        apps = next;
        sendState();
      }).catch(error => {
        ctx.log.error('Mixer helper failed:', error);
        ctx.broadcast(json({ type: 'volume:error', message: `Windows mixer unavailable: ${String(error)}` }));
      });
      sendState();
    });
    refreshState();
    setInterval(() => {
      if (mixerClient) refreshState();
      else sendState();
    }, 2_000);
    ctx.log.info('Volume mixer extension ready');
  },
});

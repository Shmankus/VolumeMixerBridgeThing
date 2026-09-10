
/**
 * @fileoverview This file handles the server side of the native volume mixer extension, 
 * including starting the hidden Node bridge and communicating with the Windows-only native addon.
 * 
 * @module main
 * @requires bridgething-extension
 * 
 */

import { asJson, defineExtension, json } from '@bridgething/extension';


// The webapp can send messages to the extension to request mixer state or change volume.
type MixerMessage =
  | { type: 'volume:refresh' }
  | { type: 'volume:set'; appName: string; volume: number }
  | { type: 'volume:toggleMute'; appName: string };
// The webapp can send log messages to the extension log for debugging purposes.
type AppMessage =
  | { type: 'app:log'; message: string }
  | MixerMessage;
type Apps_SettingsUpdateMessage = { type: 'apps_settings:update'; message: string };



type AppState = Record<string, { volume: number; muted: boolean }>;
// Update this type declaration at the top of your file:
type MixerClient = {
  request(message: MixerMessage): Promise<AppState>;
  send(message: any): void; // Add this line here
};


let mixerClient: MixerClient | undefined;
let nativeLoadError: unknown;

let trackedApps: { id: string; names: string[] }[] = [];



function fileUrlToWindowsPath(url: URL): string {
  // BridgeThing's Deno build does not expose Deno.fromFileUrl, so convert the
  // helper URL without depending on a Deno-only utility.
  const path = decodeURIComponent(url.pathname);
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1).replaceAll('/', '\\') : path;
}


// turn Firefox|{firefox,mozilla firefox} into {id: "Firefox", names: ["firefox", "mozilla firefox"]}
function readSettingsFromString(settings: string): { id: string; names: string[] }[] {
  const apps: { id: string; names: string[] }[] = [];
  for (const entry of settings.split(',')) {
    const [id, names] = entry.split('|');
    if (!id || !names) continue;
    const namesArray = names.replace(/^\{|\}$/g, '').split(',').map(name => name.trim()).filter(Boolean);
    if (namesArray.length > 0) apps.push({ id: id.trim(), names: namesArray });
  }
  return apps;
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
  // acts as a listener for the stdout stream of the mixer helper process, reading lines of JSON and resolving/rejecting promises based on the responses.
  void (async () => {
    let buffered = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += value;
      for (let cut = buffered.indexOf('\n'); cut >= 0; cut = buffered.indexOf('\n')) {
        const line = buffered.slice(0, cut).trim(); // Trim spaces/newlines
        buffered = buffered.slice(cut + 1);

        // Skip empty lines safely
        if (!line) continue;

        // If the line doesn't look like JSON, print it as a text log and skip it!
        if (!line.startsWith('{') || !line.endsWith('}')) {
          console.log(`[Mixer Worker Text Log]: ${line}`);
          continue;
        }
        try {
          const response = JSON.parse(line) as { id: number; apps?: AppState; error?: string };
          const waiting = pending.get(response.id);
          if (!waiting) continue;
          pending.delete(response.id);
          if (response.error || !response.apps) waiting.reject(new Error(response.error ?? 'Mixer helper returned no state'));

          // mixer-helper -> response (app info) -> client
          else waiting.resolve(response.apps);
        } catch (error) {
          // If a line still breaks, log it specifically without wiping out other pending requests
          console.error(`Failed to parse response line: "${line}"`, error);
        }
      }
    }
  })();

  return {
    // request method sends a message to the mixer helper and returns a promise that resolves with the updated app state or rejects with an error.
    request(message) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        writer.write(new TextEncoder().encode(`${JSON.stringify({ ...message, id })}\n`)).catch(reject);
      });
    },
    // send method sends a message to the mixer helper without expecting a response, useful for fire-and-forget actions.
    send(message) {
      const id = nextId++;
      void writer.write(new TextEncoder().encode(`${JSON.stringify({ ...message, id })}\n`));
    }
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
    let lastSetTime = 0; // Track the last time a user changed volume
    const sendState = () => ctx.broadcast(json({ type: 'volume:state', apps }));

    if (nativeLoadError) {
      ctx.broadcast(json({ type: 'volume:error', message: `Windows mixer unavailable: ${String(nativeLoadError)}` }));
    }

    const refreshState = () => {
      if (!mixerClient) return;

      // Pass the tracked apps along inside the native request payload
      mixerClient.request({
        type: 'volume:refresh',
        // @ts-ignore // secondary json arg read in worker
        watchedAppsConfig: trackedApps
      }).then(next => {
        if (Date.now() - lastSetTime < 3000) return;
        apps = next;
        sendState();
      }).catch(error => {
        ctx.log.error('Mixer helper failed:', error);
      });
    };


    ctx.on('device', event => {
      if (event.type === 'connected' || event.type === 'active') refreshState() ?? sendState();
    });

    ctx.on('message', async (_device, message) => {
      const payload = asJson<AppMessage | Apps_SettingsUpdateMessage>(message);
      if (!payload) return;

      if (payload.type === 'app:log') {
        ctx.log.info('webapp log:', payload.message);
        return;
      }

      // client -> extension -> global state update for tracked apps
      // will get updated with next interval tick or on next volume change request
      if (payload.type === 'apps_settings:update') {
        trackedApps = readSettingsFromString(payload.message);
        ctx.log.info('new apps settings received:', JSON.stringify(trackedApps));
        return;
      }


      if (!mixerClient) return;

      // Track whenever a volume update requested
      if (payload.type === 'volume:set') {
        lastSetTime = Date.now();
      }

      // Pass the current apps layout along with any active action request
      // global state apps -> mixer-helper
      const combinedPayload = { ...payload, watchedAppsConfig: trackedApps };

      void mixerClient.request(combinedPayload).then(next => {
        apps = next;
        sendState();
      }).catch(error => {
        ctx.log.error('Mixer helper failed:', error);
      });
    });

    refreshState();

    // Polling loop
    setInterval(() => {
      if (mixerClient) refreshState();
      else sendState();
    }, 2_000);

    ctx.log.info('Volume mixer extension ready');
  },
});
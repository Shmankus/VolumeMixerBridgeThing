// node_modules/@bridgething/extension/dist/host.js
var ExtensionError = class extends Error {
  kind;
  constructor(message, kind) {
    super(message);
    this.kind = kind;
    this.name = "ExtensionError";
  }
};
async function* readLines(reader) {
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done)
        break;
      buffered += decoder.decode(value, { stream: true });
      for (let cut = buffered.indexOf("\n"); cut >= 0; cut = buffered.indexOf("\n")) {
        const line = buffered.slice(0, cut);
        buffered = buffered.slice(cut + 1);
        if (line.trim().length > 0)
          yield line;
      }
    }
    buffered += decoder.decode();
    if (buffered.trim().length > 0)
      yield buffered;
  } finally {
    reader.releaseLock();
  }
}
var LineWriter = class {
  writer;
  encoder = new TextEncoder();
  tail = Promise.resolve();
  constructor(writable) {
    this.writer = writable.getWriter();
  }
  write(message) {
    const chunk = this.encoder.encode(`${JSON.stringify(message)}
`);
    const written = this.tail.then(() => this.writer.write(chunk));
    this.tail = written.catch(() => void 0);
    return written;
  }
  async close() {
    await this.tail;
    try {
      await this.writer.close();
    } catch {
      this.writer.releaseLock();
    }
  }
};

// node_modules/@bridgething/extension/dist/deno.js
function denoHost() {
  const runtime = globalThis.Deno;
  if (!runtime) {
    throw new ExtensionError("extensions run under deno; no Deno global in this process", "no-runtime");
  }
  return {
    readable: runtime.stdin.readable,
    writable: runtime.stdout.writable,
    exit: (code) => runtime.exit(code)
  };
}

// node_modules/@bridgething/extension/dist/message.js
function json(data) {
  return { encoding: "json", data };
}
function asJson(message) {
  return message.encoding === "json" ? message.data : void 0;
}
var CHUNK = 32768;
function toBase64(bytes) {
  let latin1 = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    latin1 += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(latin1);
}
function fromBase64(data) {
  const latin1 = atob(data);
  const bytes = new Uint8Array(latin1.length);
  for (let i = 0; i < latin1.length; i++)
    bytes[i] = latin1.charCodeAt(i);
  return bytes;
}
function intoWire(message) {
  if (typeof message === "string")
    return { encoding: "text", data: message };
  if (message instanceof Uint8Array)
    return { encoding: "binary", data: toBase64(message) };
  if (message.encoding === "binary")
    return { encoding: "binary", data: toBase64(message.data) };
  return message;
}
function fromWire(message) {
  if (message.encoding === "binary")
    return { encoding: "binary", data: fromBase64(message.data) };
  return message;
}

// node_modules/@bridgething/extension/dist/protocol.js
var EXTENSION_API_VERSION = 1;

// node_modules/@bridgething/extension/dist/runtime.js
function describe(value) {
  if (typeof value === "string")
    return value;
  if (value instanceof Error)
    return value.stack ?? `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
var DeviceImpl = class {
  id;
  runtime;
  name = "";
  active = false;
  connected = false;
  config = {};
  constructor(id, runtime) {
    this.id = id;
    this.runtime = runtime;
  }
  send(message) {
    this.runtime.forward(this.id, message);
  }
};
var ExtensionRuntime = class {
  spec;
  host;
  writer;
  devices_ = /* @__PURE__ */ new Map();
  pending = /* @__PURE__ */ new Map();
  onDevice = /* @__PURE__ */ new Set();
  onMessage = /* @__PURE__ */ new Set();
  onConfig = /* @__PURE__ */ new Set();
  nextRequestId = 1;
  started = false;
  finishing;
  settled;
  helloApi = EXTENSION_API_VERSION;
  helloWebapp = { id: "", name: "", version: "" };
  helloDataDir = "";
  reader;
  constructor(spec, host) {
    this.spec = spec;
    this.host = host;
    this.writer = new LineWriter(host.writable);
  }
  get api() {
    return this.helloApi;
  }
  get webapp() {
    return this.helloWebapp;
  }
  get dataDir() {
    return this.helloDataDir;
  }
  get devices() {
    return [...this.devices_.values()].filter((device) => device.connected);
  }
  device(id) {
    return this.ensure(id);
  }
  broadcast(message) {
    this.forward(void 0, message);
  }
  config(device) {
    const id = typeof device === "string" ? device : device.id;
    return this.devices_.get(id)?.config ?? {};
  }
  on(event, listener) {
    if (event === "device") {
      const fn2 = listener;
      this.onDevice.add(fn2);
      return () => this.onDevice.delete(fn2);
    }
    if (event === "message") {
      const fn2 = listener;
      this.onMessage.add(fn2);
      return () => this.onMessage.delete(fn2);
    }
    const fn = listener;
    this.onConfig.add(fn);
    return () => this.onConfig.delete(fn);
  }
  kv = {
    get: (key) => this.request((id) => ({ t: "kv.get", id, key })).then((value) => value === null ? void 0 : value),
    set: (key, value) => this.request((id) => ({ t: "kv.set", id, key, value })).then(() => void 0),
    delete: (key) => this.request((id) => ({ t: "kv.delete", id, key })).then(() => void 0),
    list: () => this.request((id) => ({ t: "kv.list", id })).then((value) => value ?? [])
  };
  auth = {
    authorize: (url) => this.request((id) => ({ t: "auth.authorize", id, url })).then((value) => String(value))
  };
  log = {
    debug: (...args) => this.log.log("debug", ...args),
    info: (...args) => this.log.log("info", ...args),
    warn: (...args) => this.log.log("warn", ...args),
    error: (...args) => this.log.log("error", ...args),
    log: (level, ...args) => {
      this.emit({ t: "log", level, message: args.map(describe).join(" ") });
    }
  };
  forward(device, message) {
    const wire = intoWire(message);
    this.emit(device === void 0 ? { t: "device.send", message: wire } : { t: "device.send", device, message: wire });
  }
  async run() {
    this.reader = this.host.readable.getReader();
    try {
      for await (const line of readLines(this.reader)) {
        const message = this.parse(line);
        if (!message)
          continue;
        if (message.t === "stop") {
          await this.finish(0);
          return;
        }
        this.dispatch(message);
      }
    } catch (err) {
      await this.finish(1, new ExtensionError(`stdin read failed: ${describe(err)}`, "disconnected"));
      return;
    }
    await this.finish(0);
  }
  ensure(id) {
    const existing = this.devices_.get(id);
    if (existing)
      return existing;
    const fresh = new DeviceImpl(id, this);
    this.devices_.set(id, fresh);
    return fresh;
  }
  parse(line) {
    try {
      return JSON.parse(line);
    } catch (err) {
      this.log.error(`unparseable line from host: ${describe(err)}`);
      return void 0;
    }
  }
  dispatch(message) {
    switch (message.t) {
      case "hello": {
        this.helloApi = message.api;
        this.helloWebapp = message.webapp;
        this.helloDataDir = message.dataDir;
        this.begin();
        return;
      }
      case "device.connected": {
        const device = this.ensure(message.device);
        device.name = message.name;
        device.config = { ...message.config };
        device.active = message.active;
        device.connected = true;
        this.announce({ type: "connected", device });
        return;
      }
      case "device.disconnected": {
        const device = this.devices_.get(message.device);
        if (!device)
          return;
        device.connected = false;
        device.active = false;
        this.announce({ type: "disconnected", device });
        return;
      }
      case "device.active": {
        const device = this.ensure(message.device);
        device.active = message.active;
        this.announce({ type: "active", device });
        return;
      }
      case "device.message": {
        const device = this.ensure(message.device);
        const forwarded = this.guard(() => fromWire(message.message));
        if (!forwarded)
          return;
        for (const listener of [...this.onMessage])
          this.guard(() => listener(device, forwarded));
        return;
      }
      case "config.changed": {
        const device = this.ensure(message.device);
        const next = { ...device.config };
        if (message.value === null)
          delete next[message.key];
        else
          next[message.key] = message.value;
        device.config = next;
        for (const listener of [...this.onConfig]) {
          this.guard(() => listener(device, message.key, message.value));
        }
        return;
      }
      case "reply": {
        const waiting = this.pending.get(message.id);
        if (!waiting)
          return;
        this.pending.delete(message.id);
        if (message.ok)
          waiting.resolve(message.value);
        else
          waiting.reject(new ExtensionError(message.error, "host-error"));
        return;
      }
    }
  }
  begin() {
    if (this.started)
      return;
    this.started = true;
    let starting;
    try {
      starting = this.spec.start(this);
    } catch (err) {
      this.abortStart(err);
      return;
    }
    void Promise.resolve(starting).then(() => this.emit({ t: "ready" }), (err) => this.abortStart(err));
  }
  abortStart(err) {
    this.log.error(`start failed: ${describe(err)}`);
    void this.finish(1, new ExtensionError(describe(err), "host-error"));
  }
  announce(event) {
    for (const listener of [...this.onDevice])
      this.guard(() => listener(event));
  }
  guard(run) {
    try {
      return run();
    } catch (err) {
      this.log.error(describe(err));
      return void 0;
    }
  }
  emit(message) {
    this.writer.write(message).catch((err) => {
      void this.finish(1, new ExtensionError(`stdout write failed: ${describe(err)}`, "write-failed"));
    });
  }
  request(build) {
    if (this.settled) {
      const advice = "kv and auth cannot be reached once shutdown has begun, so persist eagerly rather than from stop";
      return Promise.reject(new ExtensionError(`${this.settled.message}; ${advice}`, this.settled.kind));
    }
    const id = String(this.nextRequestId++);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.writer.write(build(id)).catch((err) => {
        if (!this.pending.delete(id))
          return;
        reject(new ExtensionError(`stdout write failed: ${describe(err)}`, "write-failed"));
      });
    });
  }
  finish(code, reason) {
    this.finishing ??= this.shutdown(code, reason);
    return this.finishing;
  }
  async shutdown(code, reason) {
    const failure = reason ?? new ExtensionError("the host closed the connection", "disconnected");
    this.settled = failure;
    await this.reader?.cancel().catch(() => void 0);
    for (const waiting of [...this.pending.values()])
      waiting.reject(failure);
    this.pending.clear();
    try {
      await this.spec.stop?.();
    } catch (err) {
      await this.writer.write({ t: "log", level: "error", message: `stop failed: ${describe(err)}` }).catch(() => void 0);
    }
    await this.writer.close();
    this.host.exit(code);
  }
};

// node_modules/@bridgething/extension/dist/index.js
function defineExtension(spec, host = denoHost()) {
  return new ExtensionRuntime(spec, host).run();
}

// extension/main.ts
var mixer = { devices: [] };
var mixerClient;
var nativeLoadError;
function fileUrlToWindowsPath(url) {
  const path = decodeURIComponent(url.pathname);
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1).replaceAll("/", "\\") : path;
}
function createMixerClient(deno2) {
  const helperPath = fileUrlToWindowsPath(new URL("./mixer-helper.cjs", import.meta.url));
  const process = new deno2.Command("C:\\Program Files\\nodejs\\node.exe", {
    args: [helperPath],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    windowsHide: true
  }).spawn();
  const writer = process.stdin.getWriter();
  const reader = process.stdout.pipeThrough(new TextDecoderStream()).getReader();
  const errorReader = process.stderr.pipeThrough(new TextDecoderStream()).getReader();
  const pending = /* @__PURE__ */ new Map();
  let nextId = 1;
  void (async () => {
    let error = "";
    while (true) {
      const { done, value } = await errorReader.read();
      if (done) break;
      error += value;
    }
    if (error.trim()) console.error(`Mixer helper: ${error.trim()}`);
  })();
  void (async () => {
    let buffered = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += value;
      for (let cut = buffered.indexOf("\n"); cut >= 0; cut = buffered.indexOf("\n")) {
        const line = buffered.slice(0, cut);
        buffered = buffered.slice(cut + 1);
        try {
          const response = JSON.parse(line);
          const waiting = pending.get(response.id);
          if (!waiting) continue;
          pending.delete(response.id);
          if (response.error || !response.apps) waiting.reject(new Error(response.error ?? "Mixer helper returned no state"));
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
        writer.write(new TextEncoder().encode(`${JSON.stringify({ ...message, id })}
`)).catch(reject);
      });
    }
  };
}
var deno = globalThis.Deno;
if (deno) {
  try {
    mixerClient = createMixerClient(deno);
  } catch (error) {
    nativeLoadError = error;
  }
} else {
  try {
    const { createRequire } = await import("node:module");
    const require2 = createRequire(import.meta.url);
    const addon = require2("./win-sound-mixer.node");
    mixer = addon.SoundMixer ?? addon.default ?? addon;
  } catch (error) {
    nativeLoadError = error;
  }
}
var watchedApps = [
  { id: "Discord", names: ["discord"] },
  { id: "Firefox", names: ["firefox", "mozilla firefox"] },
  { id: "AMPLibraryAgent", names: ["amplibraryagent"] }
];
function cleanName(value) {
  return value.split(/[\\/]/).at(-1)?.replace(/\.exe$/i, "").toLowerCase() ?? "";
}
function sessionName(session) {
  return session.appName ?? session.name ?? "";
}
function sessions() {
  return (mixer.devices ?? []).flatMap((device) => device.sessions ?? []);
}
function snapshot() {
  return Object.fromEntries(watchedApps.map((app) => {
    const session = sessions().find((item) => app.names.includes(cleanName(sessionName(item))));
    return [app.id, {
      volume: session ? Math.round((session.volume ?? 0) * 100) : -1,
      muted: Boolean(session?.mute)
    }];
  }));
}
function findSessions(appName) {
  const app = watchedApps.find((item) => item.id === appName);
  return sessions().filter((item) => app?.names.includes(cleanName(sessionName(item))));
}
defineExtension({
  start(ctx) {
    if (nativeLoadError) ctx.log.error("Native mixer failed to load:", nativeLoadError);
    let apps = {};
    const sendState = () => ctx.broadcast(json({ type: "volume:state", apps: mixerClient ? apps : snapshot() }));
    if (nativeLoadError) {
      ctx.broadcast(json({ type: "volume:error", message: `Windows mixer unavailable: ${String(nativeLoadError)}` }));
    }
    const refreshState = () => mixerClient?.request({ type: "volume:refresh" }).then((next) => {
      apps = next;
      sendState();
    }).catch((error) => {
      ctx.log.error("Mixer helper failed:", error);
      ctx.broadcast(json({ type: "volume:error", message: `Windows mixer unavailable: ${String(error)}` }));
    });
    ctx.on("device", (event) => {
      if (event.type === "connected" || event.type === "active") refreshState() ?? sendState();
    });
    ctx.on("message", (_device, message) => {
      const payload = asJson(message);
      if (!payload) return;
      if (mixerClient) {
        void mixerClient.request(payload).then((next) => {
          apps = next;
          sendState();
        }).catch((error) => {
          ctx.log.error("Mixer helper failed:", error);
          ctx.broadcast(json({ type: "volume:error", message: `Windows mixer unavailable: ${String(error)}` }));
        });
        return;
      }
      if (payload.type === "volume:set" && Number.isFinite(payload.volume)) {
        for (const session of findSessions(payload.appName)) {
          session.volume = Math.max(0, Math.min(100, payload.volume)) / 100;
        }
      }
      if (payload.type === "volume:toggleMute") {
        for (const session of findSessions(payload.appName)) session.mute = !session.mute;
      }
      sendState();
    });
    refreshState();
    setInterval(sendState, 2e3);
    ctx.log.info("Volume mixer extension ready");
  }
});

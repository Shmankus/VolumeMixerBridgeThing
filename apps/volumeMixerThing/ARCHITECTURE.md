# Volume Mixer Architecture & Data Flow

The mixer has two halves: the React webapp on the Car Thing (`src/`) and a Deno extension on the desktop
(`extension/`). They talk over BridgeThing's forward surface. The extension picks one audio backend for the
desktop's OS and does everything else, including matching sessions to the apps the user tracks, in shared code.

```
[React UI (App.tsx)] <──forward──> [Extension (main.ts)] <──> [Backend (backends/<os>.ts)] <──> [OS audio]
```

---

## Section 1: Backends

Each backend implements the same small interface from `backends/shared.ts`:

```typescript
type Session = { key: string; names: string[]; volume: number; muted: boolean }; // volume 0-100

type MixerBackend = {
  list(): Promise<Session[]>;
  setVolume(keys: string[], volume: number): Promise<void>;
  setMuted(keys: string[], muted: boolean): Promise<void>;
};
```

`key` is opaque outside the backend that produced it. `names` are what tracked-app names are matched against.

| OS | File | How | Key |
| :--- | :--- | :--- | :--- |
| Windows | `windows.ts` | One long-lived hidden `powershell.exe` that compiles a small C# Core Audio (WASAPI) shim at startup, then answers one line per request on stdin/stdout. | process id |
| Linux | `linux.ts` | Runs `pactl -f json list sink-inputs` and `pactl set-sink-input-volume/-mute` (PulseAudio or PipeWire). | sink-input index |
| macOS | `macos.ts` | Runs a JXA script through `osascript`: system output volume, plus Spotify and Music's own `sound volume`. | `system`, `spotify`, `music` |

### Why Windows works this way

- Every call re-enumerates the audio endpoints, so switching output devices never leaves stale sessions. That
  used to need a fresh Node process on every poll.
- The shim is passed with `-EncodedCommand`, so no script file ships and execution policy does not apply.
- It needs nothing installed beyond PowerShell 5.1, which every supported Windows has. Startup costs about a
  second once. After that a poll takes around 25 ms.
- If PowerShell dies, `lineProcess` fails the requests that were in flight and starts a new one on the next
  request.

### Why macOS is limited

CoreAudio has no API for one app's volume. Tools like SoundSource and Background Music install a virtual audio
driver to get it. Without one, the only per-app controls are apps that expose a volume over Apple Events.
Players have no mute of their own, so muting parks them at 0 and restores the previous level.

---

## Section 2: Request Flow

1. **UI action (`App.tsx`)**: `client.forward.json({ type: "volume:set", appName: "Firefox", volume: 80 })`.
2. **Extension (`main.ts`)**: `handle()` lists sessions, finds the ones whose names match the tracked app, and
   calls `setVolume` or `setMuted` on their keys. Mute toggles relative to the first matching session, which
   is the one the UI shows.
3. **Snapshot**: it lists again and builds `{ [appId]: { volume, muted } }` for every tracked app. `volume` is
   `-1` for an app that is not currently playing audio.
4. **Broadcast**: `ctx.broadcast(json({ type: 'volume:state', apps }))` reaches the webapp's `onJson` listener,
   which calls `setApps` unless the user is mid-scroll.

A poll sends `volume:refresh` every 2 seconds. A refresh that lands within 3 seconds of a `volume:set` is dropped
so it cannot snap a slider back to its old value.

---

## Section 3: Tracked Apps

The `tracked_apps` setting is `Id|{name,name},Id|{name}`, for example
`Firefox|{firefox,mozilla firefox},Discord|{discord}`. The webapp sends it as `apps_settings:update`. Names are
compared case-insensitively, with any path and `.exe` removed, against each session's `names`.

---

## Section 4: App Lifecycle & Capability Handshake

| Purpose | Mechanism | Description |
| :--- | :--- | :--- |
| **Initial Boot Check** | `client.capabilities.get()` | Queries system status *once* on mount to render the correct UI state. |
| **Initial Media Check** | `client.player.stateGet()` | Requests current media state *once* on mount. |
| **Live Reconnection Listener** | `client.capabilities.onSnapshot()` | Tracks forward availability and sends `volume:refresh` when the connection comes back. |
| **Live Media Listener** | `client.player.onSnapshot()` | Updates `setPlayer` on track and playback changes. |

---

## Section 5: Permissions

The manifest grants the extension `run:powershell.exe`, `run:pactl` and `run:osascript` and nothing else. Deno
prints an info line at startup for the two that do not exist on the current OS. That is expected.

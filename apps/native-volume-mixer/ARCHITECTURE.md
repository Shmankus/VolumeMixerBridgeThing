# Windows Volume Mixer Architecture & Data Flow

This document details the bidirectional communication pathways and step-by-step processing pipeline between the React Frontend, the Electron/Node IPC layer (`main.ts`), the process manager (`mixer-helper.cjs`), and the native volume controller (`mixer-worker.cjs`).

---

## Section 1: Downstream Pathway (Command / Request Flow)

When a user interacts with the UI (e.g., adjusting a volume slider or toggling mute), data flows downstream through four main stages:

`[React UI (App.tsx)]` ──> `[Main Extension / Server Side (main.ts)]` ──> `[Mixer Helper (mixer-helper.cjs)]` ──> `[Mixer Worker (mixer-worker.cjs)]`

### Step-by-Step Downstream Pipeline

1. **User Action in UI (`App.tsx`)**
   - User drags a slider or triggers a volume update.
   - `App.tsx` calls an async client method:
     ```typescript
     client.forward.json({ type: "volume:set", appName: "Firefox", volume: 80 });
     ```

2. **Promise Creation & Request Tracking (`main.ts`)**
   - Generates a unique request `id` (e.g., `16651`).
   - Stores the Promise's `resolve` and `reject` callbacks in a local `pending` Map:
     ```typescript
     pending.set(id, { resolve, reject });
     ```
   - Serializes the request payload (including `id`, command `type`, `appName`, `volume`, and `watchedAppsConfig`).
   - Writes the JSON string with a newline delimiter (`\n`) directly to `mixer-helper.cjs`'s `stdin`.

3. **Synchronous Process Execution (`mixer-helper.cjs`)**
   - Receives the request line on `stdin` via `readline`.
   - Passes `request` to `handle(request)`, which spawns the native worker using `child_process.spawnSync`:
     ```javascript
     const worker = spawnSync(process.execPath, [path.join(__dirname, 'mixer-worker.cjs')], {
       input: JSON.stringify(request),
       encoding: 'utf8',
       windowsHide: true,
     });
     ```

4. **Native Volume Execution (`mixer-worker.cjs`)**
   - Reads `JSON.parse(process.stdin)` synchronously.
   - Interfaces with native Windows Core Audio APIs (WASAPI) to set/get app session volumes or mute flags.
   - Generates an updated snapshot of all tracked apps and their volume states.

---

## Section 2: Upstream Pathway (Response & State Update Flow)

Once the worker completes its native audio operation, the updated state flows upstream back to the React UI:

`[Mixer Worker (mixer-worker.cjs)]` ──> `[Mixer Helper (mixer-helper.cjs)]` ──> `[Main Extension (main.ts)]` ──> `[React UI (App.tsx)]`

### Step-by-Step Upstream Pipeline

1. **Worker Output (`mixer-worker.cjs`)**
   - Writes the resultant state object directly to standard output:
     ```javascript
     process.stdout.write(JSON.stringify({ apps: handle(parsedRequest) }));
     ```

2. **Helper Relay (`mixer-helper.cjs`)**
   - Captures `worker.stdout` from `spawnSync`.
   - Formats the response into a newline-delimited JSON payload containing the original request ID:
     ```javascript
     const response = { id: request.id, apps: workerResponse.apps };
     process.stdout.write(`${JSON.stringify(response)}\n`);
     ```

3. **Line Reading & Promise Correlation (`main.ts`)**
   - An asynchronous streaming reader (`reader.read()`) consumes `stdout` chunks from `mixer-helper.cjs`.
   - Buffers chunks and extracts full lines delimited by `\n`.
   - Parses the JSON payload:
     ```typescript
     const response = JSON.parse(line) as { id: number; apps?: AppState; error?: string };
     ```
   - Looks up `response.id` in the `pending` Map:
     ```typescript
     const waiting = pending.get(response.id);
     if (waiting) {
       pending.delete(response.id);
       if (response.apps) waiting.resolve(response.apps);
       else waiting.reject(new Error(response.error));
     }
     ```

4. **React State Sync (`App.tsx`)**
   - **On Direct Requests:** The resolved promise unblocks the `await` call in `App.tsx`.
   - **On Real-Time Event Streams (`onJson` listener):**
     ```typescript
     const onServerUpdate = client.forward.onJson((message) => {
       if (isVolumeState(message)) {
         if (isScrollActiveRef.current) return; // Prevent slider jump during active drag
         setApps(message.apps);                 // Triggers React re-render
       }
     });
     ```
   - `setApps(message.apps)` updates component state and refreshes the UI sliders and mute toggles.

---

## Section 3: App Lifecycle & Capability Handshake

To handle background process crashes, restarts, or initial load scenarios, `App.tsx` executes two parallel flows inside `useEffect`:

| Purpose | Mechanism | Description |
| :--- | :--- | :--- |
| **Initial Boot Check** | `client.capabilities.get()` | Queries system status *once* on component mount to immediately render correct UI state. |
| **Initial Media Check** | `client.player.stateGet()` | Requests current media state *once* on component mount (track details, play/pause state). |
| **Live Reconnection Listener** | `client.capabilities.onSnapshot()` | Listens continuously for dynamic service status changes. Calls `updateForwardAvailability()` to set `connected` state and send `{ type: "volume:refresh" }` when connection restores. |
| **Live Media Listener** | `client.player.onSnapshot()` | Listens continuously for live server-side track/playback state changes and updates `setPlayer`. |

---

## Section 4: Key Safety & Performance Mechanisms

1. **Scroll Lock Guard (`isScrollActiveRef`)**
   - Prevents incoming server snapshots from overwriting UI slider state while the user is actively dragging a volume control.

2. **Stderr Separation**
   - `main.ts` routes `stderr` from child processes into a separate reader stream so debug/error logs never pollute or corrupt the newline-delimited JSON protocol on `stdout`.

3. **Fire-and-Forget Request Identification**
   - Attaching unique `id` keys to every request allows the long-running stream handler in `main.ts` to operate completely asynchronously without blocking the Node.js event loop.
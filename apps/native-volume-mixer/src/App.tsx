/**
 * @fileoverview Main app, includes album cover, media controls, and volume mixer. Handles communication with the extension and player state.
 * 
 * @module App
 * @requires react
 * @requires framer-motion
 * @requires fast-average-color
 * @requires bridgething-client
 * @requires serverSenders
 * 
 * @requires daemon
 * @requires inputHandler
 */

import { useEffect, useState, useRef } from 'react';
import { BridgethingClient, type PlayerState } from '@bridgething/client';
import { motion } from 'framer-motion';
import { FastAverageColor } from 'fast-average-color';
import { daemonUrl } from './daemon';
import { scrollHandler, selectionHandler, muteHandler, useDebugHardwareEvents } from './inputHandler';

const isClientDevServer = import.meta.env.DEV;

type AppState = Record<string, { volume: number; muted: boolean }>;
type VolumeStateMessage = { type: 'volume:state'; apps: AppState };
type MixerErrorMessage = { type: 'volume:error'; message: string };

const client = new BridgethingClient({ url: daemonUrl() });
const defaultApps = "Firefox|{firefox,mozilla firefox},Apple Music|{amplibraryagent},Discord|{discord}";


// makes sure value is regarding volume states
function isVolumeState(value: unknown): value is VolumeStateMessage {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'volume:state';
}
// makes sure value is regarding mixer errors
function isMixerError(value: unknown): value is MixerErrorMessage {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'volume:error';
}

// fix for crypto.randomUUID() not being available in bun dev:device
function requestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const random = Math.random() * 16 | 0;
    const value = character === 'x' ? random : random & 0x3 | 0x8;
    return value.toString(16);
  });
}

// helper function that determines if color is dark based on YIQ Luma formula
function isDarkColor(hex: string): boolean {
  const cleanHex = hex.replace('#', '');
  const fullHex = cleanHex.length === 3
    ? cleanHex.split('').map(char => char + char).join('')
    : cleanHex;

  // hex string -> base-16 number and extract R, G, B
  const num = parseInt(fullHex, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;

  // YIQ Luma formula (human-eye perception algorithm)
  // Threshold is 128 out of 255
  const brightness = (r * 0.299) + (g * 0.587) + (b * 0.114);
  return brightness < 128;
}



export default function App() {

  // UI Color
  const [artworkBg, setArtworkBg] = useState<string>("#080000");
  const [highlight_color, set_highlight_color] = useState('#ff5269');
  const [media_bg_color, set_media_bg_color] = useState('#ff5269');
  const [is_bg_dark, set_is_bg_dark] = useState<Boolean>(false);
  const [media_text_color, set_media_text_color] = useState('#000000');
  const [mixer_bg_color, set_mixer_bg_color] = useState('#202322');
  const [mixer_text_color, set_mixer_text_color] = useState('#f4f1e8');

  // UI helpers
  const [useAlbumColor, setUseAlbumColor] = useState(false); // decides if album cover determines background color
  const [fullAlbum, setfullAlbum] = useState(false); // decides if media player is full screen or not

  // Mixer States and children
  const [apps, setApps] = useState<AppState>({}); // sets apps to show on mixer
  const [selectedApp, setSelectedApp] = useState<string>(""); // sets which app is selected for mixer
  const noAppsTracked = Object.keys(apps).length === 0;
  const send = (message: object) => client.forward.json(message).catch(() => undefined);

  //Player states and children
  const [player, setPlayer] = useState<PlayerState | null>(null); // player state (title, artist, album cover)
  const [playerDurPerc, setPlayerDurPerc] = useState(0);
  const playing = player?.playback.state === 'playing';
  const title = player?.track?.title ?? 'Nothing playing';
  const artist = player?.track?.artist ?? 'BridgeThing media controls';

  // App states
  const [artworkUrl, setArtworkUrl] = useState<string | null>(null); // album cover url that comes from player state
  const [mixerError, setMixerError] = useState<string | null>(null); // decides if mixer will show fake data
  const [connected, setConnected] = useState(false); // check for if webapp is connected to desktop app


  // Keeps track of whether a scroll action is currently active
  const [isScrollActive, setIsScrollActive] = useState(false); // prevents outgoing volume updates to server
  const isScrollActiveRef = useRef(isScrollActive); // blocks incoming volume updates while scrolling

  useEffect(() => {

    // on settings change
    const offConfig = client.config.onChanged(change => {
      if (change.key === 'tracked_apps') {
        const send = (message: object) =>
          client.forward.json(message).catch(() => undefined);

        // tracked apps from settings -> main mixer extension
        send({ type: 'apps_settings:update', message: change.value == "" ? defaultApps : change.value });
      }
      if (change.key === 'useArtworkColor') {
        setUseAlbumColor(change.value == "true" ? true : false);
      }
      if (change.key === 'highlight_color') {
        set_highlight_color(change.value || '#ff5269');
      }
      if (change.key === 'media_bg_color') {
        set_media_bg_color(change.value || '#ff5269');
      }
      if (change.key === 'media_text_color') {
        set_media_text_color(change.value || '#000000');
      }

      if (change.key === 'mixer_bg_color') {
        set_mixer_bg_color(change.value || '#202322');
      }
      if (change.key === 'mixer_text_color') {
        set_mixer_text_color(change.value || '#f4f1e8');
      }
    });

    // on mount
    client.config.get({ key: 'tracked_apps' }).then(result => {
      if (result.ok) {
        send({ type: 'apps_settings:update', message: result.response.value == "" ? defaultApps : result.response.value });
      }
    });
    client.config.get({ key: 'useArtworkColor' }).then(result => {
      if (result.ok) {
        setUseAlbumColor(result.response.value == 'true' ? true : false);
      }
    });
    client.config.get({ key: 'highlight_color' }).then(result => {
      if (result.ok) {
        set_highlight_color(result.response.value || '#ff5269');
      }
    });

    client.config.get({ key: 'media_bg_color' }).then(result => {
      if (result.ok) {
        set_media_bg_color(result.response.value || '#ff5269');
      }
    });
    client.config.get({ key: 'media_text_color' }).then(result => {
      if (result.ok) {
        set_media_text_color(result.response.value || '#000000');
      }
    });
    client.config.get({ key: 'mixer_bg_color' }).then(result => {
      if (result.ok) {
        set_mixer_bg_color(result.response.value || '#202322');
      }
    });
    client.config.get({ key: 'mixer_text_color' }).then(result => {
      if (result.ok) {
        set_mixer_text_color(result.response.value || '#f4f1e8');
      }
    });
    return offConfig;
  }, []);


  // helper to keep track of scroll state in a ref for use in event callbacks
  useEffect(() => {
    isScrollActiveRef.current = isScrollActive;
  }, [isScrollActive]);


  // Subscribes to real-time events (media player, volume updates, connection status) and syncs them to React state
  useEffect(() => {
    // sets connection status and triggers volume refresh with server if newly connected
    const updateForwardAvailability = (available: boolean) => {
      setConnected(available);
      if (available) client.forward.json({ type: "volume:refresh" }).catch(() => undefined);
    };
    // sees change in capabilities such as if server is reachable
    const onCapabilityUpdate = client.capabilities.onSnapshot((snapshot) => {
      updateForwardAvailability(snapshot.capabilities.available.forward);
    });
    // detects change in server player state and updates local player state
    const onPlayerUpdate = client.player.onSnapshot((reply) => setPlayer(reply.state));
    // detects incoming statuses such as volume and app changes
    const onServerUpdate = client.forward.onJson((message) => {
      // sees incoming updates on volume states
      if (isVolumeState(message)) {
        if (isScrollActiveRef.current) return; // Block incoming volume updates mid-scroll
        // main extension -> message -> global app state
        setApps(message.apps);
      }
      // sees incoming updates on mixer errors
      if (isMixerError(message)) setMixerError(message.message);
    });

    // initial player state fetch then updates local state
    client.player.stateGet().then((result) => result.ok && setPlayer(result.response.state));
    // initial capabilities state fetch then updates local state
    client.capabilities.get().then((result) => {
      updateForwardAvailability(result.ok && result.response.capabilities.available.forward);

    });
    return () => {
      onPlayerUpdate();
      onServerUpdate();
      onCapabilityUpdate();
    };
  }, []);



  // turns artwork into a workable URL for rendering, also sets artwork average color state
  useEffect(() => {
    const fetchArtworkInfo = async () => {
      const artworkId = player?.track?.artworkId;
      if (!artworkId) return;
      let cancelled = false;
      client.asset.get({ id: artworkId, requestId: requestId() }).then(async result => {
        if (cancelled || !result.ok) return;
        const bytes = new Uint8Array(result.response.bytes).slice();
        const url = URL.createObjectURL(new Blob([bytes.buffer], { type: result.response.mime ?? 'image/jpeg' }));

        if (url != artworkUrl) setArtworkUrl(url); // avoid reassign flicker

        if (!url) return artworkBg;
        if (useAlbumColor) {
          const fac = new FastAverageColor();
          await fac.getColorAsync(url, { algorithm: 'sqrt' })
            .then((color) => {
              setArtworkBg(color.hex)
              set_is_bg_dark(color.isDark);
              URL.revokeObjectURL(url);
            })
            .catch((err) => {
              console.error(err);
              URL.revokeObjectURL(url);
            });
        } else {
          set_is_bg_dark(isDarkColor(media_bg_color));
        }
      });
      return () => { cancelled = true; };
    }
    fetchArtworkInfo();
  }, [player?.track?.artworkId, useAlbumColor, media_bg_color]);


  // interval that gathers player duration information 
  useEffect(() => {
    // Set up the interval
    const interval = setInterval(() => {
      client.player.stateGet().then(result => result.ok
        && result?.response?.state?.track?.durationMs
        && setPlayerDurPerc((result.response.state.playback.positionMs / result.response.state.track?.durationMs) * 100));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  function renderAlbum() {
    return (
      <motion.section
        layout
        transition={{ type: 'tween', ease: [0.25, 1, 0.5, 1], duration: 0.4 }}
        className={`hero-panel ${fullAlbum ? "expanded" : ""}`}
      >
        <motion.div
          layout
          className={`artwork ${fullAlbum ? "expanded" : ""}`}
          onClick={() => (setfullAlbum((fullAlbum) => !fullAlbum))}
          style={artworkUrl ? { backgroundImage: `url(${artworkUrl})` } : undefined}
        >
          {!artworkUrl && <span>NO ARTWORK</span>}
        </motion.div>

        <motion.div layout className={`now-playing ${fullAlbum ? 'expanded' : ''}`}>
          <motion.div className="song-duration">
            <motion.div className="progress-bar">
              <motion.div className="progress" animate={{ width: `${playerDurPerc}%` }}></motion.div>
            </motion.div>
          </motion.div>
          <motion.div layout className={`transport ${fullAlbum ? 'expanded' : ''}`}>

            <motion.button
              layout
              onClick={() => client.player.skipPrev({ allowSeeking: false }).catch(() => undefined)}
              title="Previous track"
            >
              <motion.span layout>|&lt;</motion.span>
            </motion.button>

            <motion.button
              layout
              className="transport-main"
              onClick={() => (playing ? client.player.pause() : client.player.resume()).catch(() => undefined)}
              title={playing ? 'Pause' : 'Play'}
            >
              <motion.span layout>{playing ? '||' : '>'}</motion.span>
            </motion.button>

            <motion.button
              layout
              onClick={() => client.player.skipNext().catch(() => undefined)}
              title="Next track"
            >
              <motion.span layout>&gt;|</motion.span>
            </motion.button>

          </motion.div>
          <motion.div layout className={`music ${fullAlbum ? 'expanded' : ''}`}>
            <motion.strong layout className={`track-title ${fullAlbum ? 'expanded' : ''}`}>{title}</motion.strong>
            <motion.span layout className={`track-artist ${fullAlbum ? 'expanded' : ''}`}>{artist}</motion.span>
          </motion.div>
        </motion.div>
      </motion.section>
    )
  }

  // Renders right hand mixer in dual screen mode 
  function renderMixer() {
    return (
      <section className="mixer-panel">

        <header>
          <span>{!noAppsTracked ? selectedApp ?? 'None' : "No Apps Tracked | Check settings"}</span>
          <div className="mixer-meta">
            <small className="extension-status">
              <span className={connected ? 'status-dot live' : 'status-dot'} />{connected ? 'Mixer Working' : 'Mixer Down'}
            </small>
          </div>
        </header>

        {!noAppsTracked && !mixerError && (
          <div className="mixer-list">
            {/* Loops through displayApps */}
            {Object.entries(apps).map(([appName, state]) => {
              const isUnreachableApp = state.volume < 0;
              return <article className="mixer-row" key={appName} style={{ backgroundColor: selectedApp === appName ? 'rgba(255, 255, 255, 0.1)' : 'transparent' }} onClick={() => (setSelectedApp(prev => prev === appName ? "" : appName))}>
                <div className="row-top"><strong>{appName}</strong><span>{isUnreachableApp ? '--' : `${state.volume}%`}</span></div>
                <div className="row-bottom">
                  
                  <button
                    className={state.muted ? 'mute active' : 'mute'}
                    onClick={(e) => {
                      e.stopPropagation();
                      !noAppsTracked && !isUnreachableApp && send({ type: 'volume:toggleMute', appName });
                    }}
                    disabled={noAppsTracked || isUnreachableApp}
                    title="Toggle mute"
                  >
                    {state.muted ? 'MUTED' : 'MUTE'}
                  </button>

                  <input
                    id={`volume-${appName}`}
                    type="range"
                    min="0"
                    max="100"
                    value={isUnreachableApp ? 0 : state.volume}
                    disabled={noAppsTracked || isUnreachableApp}
                    onChange={(event) => {
                      const volume = Number(event.target.value);
                      setApps((previous) => ({
                        ...previous,
                        [appName]: { ...previous[appName], volume },
                      }));
                    }}
                  />
                </div>
              </article>;
            })}
          </div>
        )}

        {mixerError && <div className="empty">{mixerError}</div>}
      </section>)
  }

  isClientDevServer && useDebugHardwareEvents(client); // sets up event listeners for hardware events and sends them to the server for debugging
  scrollHandler(selectedApp, noAppsTracked, setApps, client, setIsScrollActive); // sets up event listeners for scroll events and sends volume updates to the server after a delay
  selectionHandler(client, apps, setSelectedApp); // sets up event listeners for key events to select apps in the mixer
  muteHandler(selectedApp, noAppsTracked, setApps, client);
  return (
    <main
      className="app-shell"
      style={{
        '--highlight_color': highlight_color,
        '--media_bg_color': useAlbumColor ? artworkBg : media_bg_color,
        '--media_text_color': media_text_color,
        '--mixer_bg_color': mixer_bg_color,
        '--mixer_text_color': mixer_text_color,

        // weights for determining if a background is light or dark
        '--dark_mix_weight': is_bg_dark ? '100%' : '0%',
        '--light_mix_weight': is_bg_dark ? '0%' : '100%',

        '--app_padding' :  Object.keys(apps).length <= 3 ? '33px':'15px'
      } as React.CSSProperties}>

      {renderAlbum && renderAlbum()}
      {!fullAlbum && renderMixer()}

    </main>
  );
}
 
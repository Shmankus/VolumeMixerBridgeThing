// Main webapp UI: displays media controls, artwork, and Windows app volumes.
import { useEffect, useState } from 'react';
import { BridgethingClient, type PlayerState } from '@bridgething/client';
import { motion } from 'framer-motion';
import { FastAverageColor } from 'fast-average-color';
type AppState = Record<string, { volume: number; muted: boolean }>;
type VolumeStateMessage = { type: 'volume:state'; apps: AppState };
type MixerErrorMessage = { type: 'volume:error'; message: string };

const client = new BridgethingClient();
const labels: Record<string, string> = { AMPLibraryAgent: 'Apple Music' };

// Demo app states
const demoApps: AppState = {
  App1: { volume: 72, muted: false },
  App2: { volume: 48, muted: false },
  App3: { volume: 86, muted: false },
};

// makes sure value is regarding volume states
function isVolumeState(value: unknown): value is VolumeStateMessage {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'volume:state';
}
// makes sure value is regarding mixer states
function isMixerError(value: unknown): value is MixerErrorMessage {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'volume:error';
}



export async function getAverageColorFromUrl(url: string): Promise<string> {
  if (!url) return '#ffffff';

  try {
    const fac = new FastAverageColor();
    const color = await fac.getColorAsync(url, { algorithm: 'sqrt' });
    return color.hex;
  } catch (error) {
    console.error("Error extracting color:", error);
    return '#ffffff'; // Fallback color on error
  }
}
export default function App() {

  // UI Color
  const [artworkBg, setArtworkBg] = useState<string>("#080000");
  const [highlight_color, set_highlight_color] = useState('#ff5269');
  const [media_bg_color, set_media_bg_color] = useState('#ff5269');
  const [media_text_color, set_media_text_color] = useState('#000000');
  const [mixer_bg_color, set_mixer_bg_color] = useState('#202322');
  const [mixer_text_color, set_mixer_text_color] = useState('#f4f1e8');

  // UI helpers
  const [useAlbumColor, setUseAlbumColor] = useState(false); // decides if album cover determines background color
  const [fullAlbum, setfullAlbum] = useState(false); // decides if media player is full screen or not

  // Mixer States and children
  const [apps, setApps] = useState<AppState>({}); // sets apps to show on mixer
  const displayedApps = Object.keys(apps).length > 0 ? apps : demoApps;
  const showingDemoApps = Object.keys(apps).length === 0;
  const send = (message: object) => client.forward.json(message).catch(() => undefined);

  //Player states and children
  const [player, setPlayer] = useState<PlayerState | null>(null); // player state (title, artist, album cover)
  const playing = player?.playback.state === 'playing';
  const title = player?.track?.title ?? 'Nothing playing';
  const artist = player?.track?.artist ?? 'BridgeThing media controls';

  // App states
  const [artworkUrl, setArtworkUrl] = useState<string | null>(null); // album cover url that comes from player state
  const [mixerError, setMixerError] = useState<string | null>(null); // decides if mixer will show fake data
  const [connected, setConnected] = useState(false); // check for if webapp is connected to desktop app









  useEffect(() => {

    // on settings change
    const offConfig = client.config.onChanged(change => {
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

  // handles album cover pointer event to toggle fullscreen
  const handleAlbumCoverTap = () => {
    setfullAlbum((fullAlbum) => !fullAlbum);
  };

  // handles media player info from serverand sets the states accordingly
  useEffect(() => {
    const offPlayer = client.player.onSnapshot(reply => setPlayer(reply.state));
    const offForward = client.forward.onJson(message => {
      if (isVolumeState(message)) setApps(message.apps);
      if (isMixerError(message)) setMixerError(message.message);
    });
    const updateForwardAvailability = (available: boolean) => {
      setConnected(available);
      if (available) client.forward.json({ type: 'volume:refresh' }).catch(() => undefined);
    };
    const offCapabilities = client.capabilities.onSnapshot(snapshot => {
      updateForwardAvailability(snapshot.capabilities.available.forward);
    });
    client.player.stateGet().then(result => result.ok && setPlayer(result.response.state));
    client.capabilities.get().then(result => {
      updateForwardAvailability(result.ok && result.response.capabilities.available.forward);
    });
    return () => { offPlayer(); offForward(); offCapabilities(); };
  }, []);

  // turns artwork into a workable URL for rendering, also sets artwork average color state
  useEffect(() => {
    const artworkId = player?.track?.artworkId;
    setArtworkUrl(null);
    if (!artworkId) return;
    let cancelled = false;
    client.asset.get({ id: artworkId, requestId: globalThis.crypto.randomUUID() }).then(result => {
      if (cancelled || !result.ok) return;
      const bytes = new Uint8Array(result.response.bytes).slice();
      const url = URL.createObjectURL(new Blob([bytes.buffer], { type: result.response.mime ?? 'image/jpeg' }));

      getAverageColorFromUrl(url)
        .then((hexColor) => {
          setArtworkBg(hexColor)
          URL.revokeObjectURL(url);
        })
        .catch((err) => {
          console.error(err);
          URL.revokeObjectURL(url);
        });
      setArtworkUrl(url);

    });
    return () => { cancelled = true; };
  }, [player?.track?.artworkId]);




  function renderAlbum() {
    return (
      <motion.section
        layout
        transition={{ type: 'spring', stiffness: 120, damping: 18 }}
        className={`hero-panel ${fullAlbum ? "expanded" : ""}`}
      >
        <motion.div
          layout
          className={`artwork ${fullAlbum ? "expanded" : ""}`}
          onClick={handleAlbumCoverTap}
          style={artworkUrl ? { backgroundImage: `url(${artworkUrl})` } : undefined}
        >
          {!artworkUrl && <span>NO ARTWORK</span>}
        </motion.div>

        <motion.div layout className={`now-playing ${fullAlbum ? 'expanded' : ''}`}>
          <motion.div layout className={`transport ${fullAlbum ? 'expanded' : ''}`}>
            <motion.button
              layout
              onClick={() => client.player.skipPrev({ allowSeeking: true }).catch(() => undefined)}
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
    return (<section className="mixer-panel">
      <header><span>hi</span><div className="mixer-meta"><small className="extension-status"><span className={connected ? 'status-dot live' : 'status-dot'} />{connected ? 'EXTENSION CONNECTED' : 'CONNECTING'}</small></div></header>
      <div className="mixer-list">
        {Object.entries(displayedApps).map(([appName, state]) => {
          const unavailable = state.volume < 0;
          return <article className="mixer-row" key={appName}>
            <div className="row-top"><strong>{labels[appName] ?? appName}</strong><span>{unavailable ? '--' : `${state.volume}%`}</span></div>
            <div className="row-bottom">
              <button className={state.muted ? 'mute active' : 'mute'} onClick={() => !showingDemoApps && !unavailable && send({ type: 'volume:toggleMute', appName })} disabled={showingDemoApps || unavailable} title="Toggle mute">{state.muted ? 'MUTED' : 'MUTE'}</button>
              <input type="range" min="0" max="100" value={unavailable ? 0 : state.volume} disabled={showingDemoApps || unavailable} onChange={event => {
                const volume = Number(event.target.value);
                setApps(previous => ({ ...previous, [appName]: { ...previous[appName], volume } }));
                send({ type: 'volume:set', appName, volume });
              }} />
              <span className="availability">{showingDemoApps ? 'DEMO' : unavailable ? 'NOT OPEN' : 'ACTIVE'}</span>
            </div>
          </article>;
        })}
        {mixerError && <div className="empty">{mixerError}</div>}
        {showingDemoApps && !mixerError && <div className="empty">Demo application data</div>}
      </div>
    </section>)

  }


  return (
    <main
      className="app-shell"
      style={{
        '--highlight_color': highlight_color,
        '--media_bg_color': useAlbumColor ? artworkBg : media_bg_color,
        '--media_text_color': media_text_color,
        '--mixer_bg_color': mixer_bg_color,
        '--mixer_text_color': mixer_text_color
      } as React.CSSProperties}>

      {renderAlbum && renderAlbum()}
      {!fullAlbum && renderMixer()}

    </main>
  );
}

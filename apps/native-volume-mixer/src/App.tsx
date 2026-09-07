// Main webapp UI: displays media controls, artwork, and Windows app volumes.
import { useEffect, useState } from 'react';
import { BridgethingClient, type PlayerState } from '@bridgething/client';
import { motion } from 'framer-motion';
type AppState = Record<string, { volume: number; muted: boolean }>;
type VolumeStateMessage = { type: 'volume:state'; apps: AppState };
type MixerErrorMessage = { type: 'volume:error'; message: string };

const client = new BridgethingClient();
const labels: Record<string, string> = { AMPLibraryAgent: 'Apple Music' };
const demoApps: AppState = {
  App1: { volume: 72, muted: false },
  App2: { volume: 48, muted: false },
  App3: { volume: 86, muted: false },
};

function isVolumeState(value: unknown): value is VolumeStateMessage {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'volume:state';
}

function isMixerError(value: unknown): value is MixerErrorMessage {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'volume:error';
}



export default function App() {
  const [apps, setApps] = useState<AppState>({});
  const [player, setPlayer] = useState<PlayerState | null>(null);
  const [artworkUrl, setArtworkUrl] = useState<string | null>(null);
  const [mixerError, setMixerError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [fullAlbum, setfullAlbum] = useState(false);

  const handleAlbumCoverTap = () => {
    setfullAlbum((fullAlbum) => !fullAlbum);
  };


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

  useEffect(() => {
    const artworkId = player?.track?.artworkId;
    setArtworkUrl(null);
    if (!artworkId) return;
    let cancelled = false;
    client.asset.get({ id: artworkId, requestId: crypto.randomUUID() }).then(result => {
      if (cancelled || !result.ok) return;
      const bytes = new Uint8Array(result.response.bytes).slice();
      const url = URL.createObjectURL(new Blob([bytes.buffer], { type: result.response.mime ?? 'image/jpeg' }));
      setArtworkUrl(url);
    });
    return () => { cancelled = true; };
  }, [player?.track?.artworkId]);

  const playing = player?.playback.state === 'playing';
  const send = (message: object) => client.forward.json(message).catch(() => undefined);
  const title = player?.track?.title ?? 'Nothing playing';
  const artist = player?.track?.artist ?? 'BridgeThing media controls';
  const displayedApps = Object.keys(apps).length > 0 ? apps : demoApps;
  const showingDemoApps = Object.keys(apps).length === 0;


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
              onClick={() => send({ type: 'playback:previous' })}
              title="Previous track"
            >
              <motion.span layout>|&lt;</motion.span>
            </motion.button>
            <motion.button
              layout
              className="transport-main"
              onClick={() => send({ type: 'playback:playPause' })}
              title={playing ? 'Pause' : 'Play'}
            >
              <motion.span layout>{playing ? '||' : '>'}</motion.span>
            </motion.button>

            <motion.button
              layout
              onClick={() => send({ type: 'playback:next' })}
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


  function renderMixer() {
    return (<section className="mixer-panel">
      <header><span>APPLICATION MIXER</span><div className="mixer-meta"><small className="extension-status"><span className={connected ? 'status-dot live' : 'status-dot'} />{connected ? 'EXTENSION CONNECTED' : 'CONNECTING'}</small></div></header>
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


  return <main className="app-shell">
    {renderAlbum && renderAlbum()}
    {!fullAlbum && renderMixer()}

  </main>;
}

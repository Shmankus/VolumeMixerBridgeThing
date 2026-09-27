import { run, type MixerBackend, type Session } from './shared';

// macos has no per-process volume without installing an audio driver, so this controls the system output
// plus the players that expose their own volume over apple events. jxa resolves apps at runtime, so a player
// that is not installed is skipped instead of failing the whole script the way applescript would.
const SCRIPT = `
function run(argv) {
  const [action, key, value] = argv;
  const system = Application.currentApplication();
  system.includeStandardAdditions = true;
  const players = { spotify: 'com.spotify.client', music: 'com.apple.Music' };
  if (action === 'set' && key === 'system') system.setVolume(null, { outputVolume: Number(value) });
  else if (action === 'mute' && key === 'system') system.setVolume(null, { outputMuted: value === '1' });
  else if (action === 'set') Application(players[key]).soundVolume = Number(value);
  if (action !== 'list') return '[]';

  const settings = system.getVolumeSettings();
  const sessions = [{ key: 'system', names: ['system', 'master'], volume: settings.outputVolume, muted: settings.outputMuted }];
  for (const key of Object.keys(players)) {
    try {
      const app = Application(players[key]);
      if (app.running()) sessions.push({ key, names: [key, app.name()], volume: app.soundVolume(), muted: false });
    } catch (error) {}
  }
  return JSON.stringify(sessions);
}
`;

const osascript = (...args: string[]) => run('osascript', ['-l', 'JavaScript', '-e', SCRIPT, ...args]);

export function macosBackend(): MixerBackend {
  // players have no mute of their own, so muting parks them at 0 and remembers where they were
  const parked = new Map<string, number>();

  return {
    async list() {
      const sessions = JSON.parse(await osascript('list')) as (Session & { volume: number | null })[];
      return sessions.map(session => {
        const volume = session.volume ?? -1;
        if (parked.has(session.key) && volume !== 0) parked.delete(session.key);
        return { ...session, volume, muted: session.muted || parked.has(session.key) };
      });
    },
    async setVolume(keys, volume) {
      for (const key of keys) {
        parked.delete(key);
        await osascript('set', key, String(Math.round(volume)));
      }
    },
    async setMuted(keys, muted) {
      for (const key of keys) {
        if (key === 'system') {
          await osascript('mute', key, muted ? '1' : '0');
          continue;
        }
        if (muted) {
          const current = (await this.list()).find(session => session.key === key);
          if (!current || current.volume <= 0) continue;
          await osascript('set', key, '0');
          parked.set(key, current.volume);
        } else {
          const restore = parked.get(key) ?? 50;
          parked.delete(key);
          await osascript('set', key, String(restore));
        }
      }
    },
  };
}

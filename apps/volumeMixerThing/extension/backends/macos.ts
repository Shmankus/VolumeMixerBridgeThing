import { run, runtimePath, type MixerBackend, type Session } from './shared';

// macos has no per-process volume without installing an audio driver, so runtime/macos/mixer.js controls the
// system output plus the players that expose their own volume over apple events
const osascript = (...args: string[]) => run('osascript', ['-l', 'JavaScript', runtimePath('macos/mixer.js'), ...args]);

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

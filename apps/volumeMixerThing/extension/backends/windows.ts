import { lineProcess, runtimePath, type MixerBackend, type Session } from './shared';

export function windowsBackend(): MixerBackend {
  // bypass only applies to this process, and is what lets an unsigned script from a downloaded zip run at all
  const helper = lineProcess('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Hidden',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    runtimePath('windows/mixer.ps1'),
  ]);

  const call = async (line: string) => {
    const reply = JSON.parse(await helper.request(line)) as {
      error?: string;
      sessions?: { pid: number; name: string; volume: number; muted: boolean }[];
    };
    if (reply.error) throw new Error(reply.error);
    return reply;
  };

  return {
    async list(): Promise<Session[]> {
      const { sessions = [] } = await call('list');
      return sessions.map(session => ({
        key: String(session.pid),
        names: [session.name],
        volume: session.volume,
        muted: session.muted,
      }));
    },
    async setVolume(keys, volume) {
      for (const key of keys) await call(`set\t${key}\t${Math.round(volume)}`);
    },
    async setMuted(keys, muted) {
      for (const key of keys) await call(`mute\t${key}\t${muted ? 1 : 0}`);
    },
    stop: helper.stop,
  };
}

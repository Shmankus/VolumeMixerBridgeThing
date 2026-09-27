import { run, type MixerBackend } from './shared';

type SinkInput = {
  index: number;
  mute: boolean;
  volume: Record<string, { value: number }>;
  properties: Record<string, string>;
};

// pactl talks to pulseaudio and to pipewire-pulse alike, which covers every mainstream desktop
export function linuxBackend(): MixerBackend {
  return {
    async list() {
      const inputs = JSON.parse(await run('pactl', ['-f', 'json', 'list', 'sink-inputs'])) as SinkInput[];
      return inputs.map(input => {
        const channels = Object.values(input.volume ?? {});
        const average = channels.reduce((sum, channel) => sum + channel.value, 0) / Math.max(channels.length, 1);
        const props = input.properties ?? {};
        return {
          key: String(input.index),
          names: [props['application.process.binary'], props['application.name']].filter(Boolean),
          volume: Math.round((average / 65536) * 100),
          muted: input.mute,
        };
      });
    },
    async setVolume(keys, volume) {
      await Promise.all(keys.map(key => run('pactl', ['set-sink-input-volume', key, `${Math.round(volume)}%`])));
    },
    async setMuted(keys, muted) {
      await Promise.all(keys.map(key => run('pactl', ['set-sink-input-mute', key, muted ? '1' : '0'])));
    },
  };
}

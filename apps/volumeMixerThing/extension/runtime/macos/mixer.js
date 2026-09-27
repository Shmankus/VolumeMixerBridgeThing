// jxa rather than applescript: apps resolve at runtime, so a player that is not installed is skipped instead of
// failing the whole script at compile time.
// usage: osascript -l JavaScript mixer.js list | set <key> <0-100> | mute <key> <0|1>
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

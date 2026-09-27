/** One audio stream the OS lets us control. `key` is opaque to everything but the backend that produced it. */
export type Session = { key: string; names: string[]; volume: number; muted: boolean };

/** The per-OS half of the mixer: list what is playing, and change it. Volumes are 0-100. */
export type MixerBackend = {
  list(): Promise<Session[]>;
  setVolume(keys: string[], volume: number): Promise<void>;
  setMuted(keys: string[], muted: boolean): Promise<void>;
  stop?(): void;
};

// deno is only reached through globalThis so the webapp's tsconfig does not need deno's types
// deno-lint-ignore no-explicit-any
export const Deno = (globalThis as any).Deno;

/** "C:\\Program Files\\Mozilla Firefox\\firefox.exe" and "Firefox" both become "firefox". */
export function cleanName(value: string): string {
  return (value.split(/[\\/]/).at(-1) ?? '').replace(/\.exe$/i, '').trim().toLowerCase();
}

export async function run(command: string, args: string[]): Promise<string> {
  const output = await new Deno.Command(command, {
    args,
    stdout: 'piped',
    stderr: 'piped',
    env: { LC_ALL: 'C' },
  }).output();
  const decoder = new TextDecoder();
  if (!output.success) throw new Error(decoder.decode(output.stderr).trim() || `${command} exited ${output.code}`);
  return decoder.decode(output.stdout);
}

/**
 * A long-lived child answering one stdout line per stdin line, in order.
 * It is spawned on first use and again after it dies, so a crash costs one failed request.
 */
export function lineProcess(command: string, args: string[]) {
  type Waiter = { resolve: (line: string) => void; reject: (error: unknown) => void };
  let child: { writer: WritableStreamDefaultWriter<Uint8Array>; waiting: Waiter[]; kill(): void } | undefined;
  const encoder = new TextEncoder();

  const spawn = () => {
    const process = new Deno.Command(command, { args, stdin: 'piped', stdout: 'piped', stderr: 'piped' }).spawn();
    const current = {
      writer: process.stdin.getWriter() as WritableStreamDefaultWriter<Uint8Array>,
      waiting: [] as Waiter[],
      kill: () => {
        try {
          process.kill();
        } catch {
          // already gone
        }
      },
    };

    void (async () => {
      const reader = process.stdout.pipeThrough(new TextDecoderStream()).getReader();
      let buffered = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += value;
        for (let cut = buffered.indexOf('\n'); cut >= 0; cut = buffered.indexOf('\n')) {
          const line = buffered.slice(0, cut).trim();
          buffered = buffered.slice(cut + 1);
          if (line.startsWith('{')) current.waiting.shift()?.resolve(line);
          else if (line) console.error(`${command}: ${line}`);
        }
      }
      if (child === current) child = undefined;
      for (const waiter of current.waiting.splice(0)) waiter.reject(new Error(`${command} exited`));
    })();

    void process.stderr.pipeTo(
      new WritableStream({ write: chunk => console.error(`${command}: ${new TextDecoder().decode(chunk).trim()}`) }),
    );

    return current;
  };

  return {
    request(line: string): Promise<string> {
      child ??= spawn();
      const current = child;
      return new Promise((resolve, reject) => {
        current.waiting.push({ resolve, reject });
        current.writer.write(encoder.encode(`${line}\n`)).catch(error => {
          current.waiting = current.waiting.filter(waiter => waiter.reject !== reject);
          reject(error);
        });
      });
    },
    stop() {
      child?.kill();
      child = undefined;
    },
  };
}

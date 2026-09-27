import { spawn } from 'node:child_process';

export type Command = {
  executable: string;
  args: string[];
  cwd: string;
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
};
export type CommandResult = { stdout: string };
export type Runner = (command: Command) => Promise<CommandResult>;

/** Output is intentionally private/non-enumerable: callers must opt in to
 * parsing a complete checkpoint, never log private provider output on errors. */
export class ReaderTimeoutError extends Error {
  #stdout: string;
  constructor(stdout: string) {
    super('Reader timed out');
    this.#stdout = stdout;
  }
  get stdout() {
    return this.#stdout;
  }
}

/** No shell, no login scripts, no discovery. Own the child group, never another agent's process. */
export const runCommand: Runner = (command) =>
  new Promise((resolve, reject) => {
    const outputLimit = command.maxOutputBytes ?? 16 * 1024 * 1024;
    if (!Number.isSafeInteger(outputLimit) || outputLimit < 1 || outputLimit > 32 * 1024 * 1024) {
      reject(new Error('Invalid reader output limit'));
      return;
    }
    if (command.signal?.aborted) {
      reject(new Error('Reader cancelled'));
      return;
    }
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: { ...process.env, SHELL_SESSIONS_DISABLE: '1' },
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    let exited = false;
    let bytes = 0,
      failure: string | null = null;
    let killer: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        /* already gone */
      }
    };
    const stop = (message: string) => {
      if (failure) return;
      failure = message;
      kill('SIGTERM');
      killer = setTimeout(() => kill('SIGKILL'), 1000);
    };
    const timer = setTimeout(
      () => stop(exited ? 'Reader output did not close after exit' : 'Reader timed out'),
      command.timeoutMs,
    );
    const abort = () => stop('Reader cancelled');
    command.signal?.addEventListener('abort', abort, { once: true });
    const clean = () => {
      clearTimeout(timer);
      clearTimeout(killer);
      command.signal?.removeEventListener('abort', abort);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > outputLimit) stop(`Reader output exceeded ${outputLimit / 1024 / 1024} MB`);
      else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > outputLimit) stop(`Reader output exceeded ${outputLimit / 1024 / 1024} MB`);
    });
    child.once('error', () => {
      clean();
      reject(new Error('Cannot start configured reader executable'));
    });
    child.once('exit', (code) => {
      exited = true;
      // Descendants may keep the pipes open after the reader exits. Record a
      // failure now, before a later deadline could make it recoverable. Preserve
      // an earlier timeout/cancellation that caused this exit.
      if (code !== 0) {
        failure ??= `Reader command exited ${code}; check provider login/configuration`;
        kill('SIGKILL');
      }
    });
    child.once('close', (code) => {
      // Closing the reader's pipes does not prove its whole process group
      // exited. Finish a failed/interrupted group's cleanup before cancelling the
      // grace timer: an auth helper may ignore SIGTERM and outlive its parent.
      if (failure || code !== 0) kill('SIGKILL');
      clean();
      // Overflow can arrive while a timed-out child shuts down. Discarded bytes
      // make its checkpoint ambiguous, even if the timeout happened first.
      if (bytes > outputLimit)
        reject(new Error(`Reader output exceeded ${outputLimit / 1024 / 1024} MB`));
      else if (failure === 'Reader timed out')
        reject(new ReaderTimeoutError(Buffer.concat(stdout).toString('utf8')));
      else if (failure || code !== 0)
        reject(
          new Error(failure ?? `Reader command exited ${code}; check provider login/configuration`),
        );
      else resolve({ stdout: Buffer.concat(stdout).toString('utf8') });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(command.stdin ?? '');
  });

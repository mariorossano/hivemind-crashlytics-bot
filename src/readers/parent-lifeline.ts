/** A detached reader can outlive a SIGKILL of its caller. A private IPC channel
 * closes on parent death, including core deadlines shorter than our read timer.
 * This helper runs only in readers started as their own process-group leader. */
export function installParentLifeline() {
  if (typeof process.send !== 'function') return () => {};
  const stop = () => {
    if (process.platform !== 'win32') {
      try {
        process.kill(-process.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    process.exit(1);
  };
  process.once('disconnect', stop);
  // The parent may have died while Node/tsx was loading, before this listener.
  if (!process.connected) stop();
  return () => {
    process.off('disconnect', stop);
    if (process.connected) process.disconnect();
  };
}

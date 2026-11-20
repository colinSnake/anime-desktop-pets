/** The launcher must own a live IPC channel before the worker can load the SDK. */
export function watchRuntimeOwner(channel = process) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  channel.once('disconnect', stop);
  if (channel.connected !== true) stop();
  return { signal: controller.signal, dispose: () => channel.off('disconnect', stop) };
}

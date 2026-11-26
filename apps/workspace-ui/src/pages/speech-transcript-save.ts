export type SpeechTranscriptSaver = {
  schedule(value: string): void;
  flush(): Promise<void>;
  cancel(): void;
};

/** Coalesces edits, but flush always waits for the latest submitted transcript. */
export function createSpeechTranscriptSaver(save: (value: string) => Promise<void>, delayMs = 400): SpeechTranscriptSaver {
  let pending: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let draining: Promise<void> | undefined;
  let cancelEpoch = 0;
  const drain = (): Promise<void> => {
    if (draining) return draining;
    draining = (async () => {
      while (pending !== undefined) {
        const value = pending;
        pending = undefined;
        const epoch = cancelEpoch;
        try { await save(value); }
        catch (error) {
          // Keep the latest unsaved edit for an explicit flush or the next edit.
          // Do not overwrite a newer value or revive a deliberately cancelled one.
          if (cancelEpoch === epoch && pending === undefined) pending = value;
          throw error;
        }
      }
    })().finally(() => { draining = undefined; });
    return draining;
  };
  return {
    schedule(value) {
      pending = value;
      clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; void drain().catch(() => {}); }, delayMs);
    },
    flush() {
      clearTimeout(timer); timer = undefined;
      return drain();
    },
    cancel() {
      cancelEpoch++;
      clearTimeout(timer); timer = undefined; pending = undefined;
    },
  };
}

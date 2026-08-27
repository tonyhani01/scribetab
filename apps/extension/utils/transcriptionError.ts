/** Persist live STT diagnostics. Offscreen cannot touch chrome.storage. */
export async function persistLastTranscriptionError(message: string | null): Promise<void> {
  if (message === null) {
    await chrome.storage.local.remove('lastTranscriptionError');
  } else {
    await chrome.storage.local.set({ lastTranscriptionError: message });
  }
}

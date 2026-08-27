/** Chrome native messaging host name — must match connectNative() in the extension. */
export const HOST_NAME = 'com.scribetab.host';

/**
 * Development extension ID from the packed `key` in `apps/extension/wxt.config.ts`.
 * Override at install time with `--extension-id`. The Chrome Web Store ID replaces
 * this once the extension is published.
 */
export const DEFAULT_EXTENSION_ID = 'cambjpbepplcihlihagiheggdkfcpmef';

export const MAX_AUDIO_CHUNK_BYTES = 8 * 1024 * 1024;
export const MAX_NATIVE_MESSAGE_BYTES = 64 * 1024 * 1024;
export const SLUG_MAX = 60;

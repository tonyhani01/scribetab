import { defineConfig } from 'wxt';

export default defineConfig({
  zip: {
    name: 'scribetab',
  },
  manifest: {
    name: 'ScribeTab',
    description:
      'BYOK meeting transcriber. Captures tab audio locally — no bot, no cloud storage.',
    // Packed key → stable development ID cambjpbepplcihlihagiheggdkfcpmef
    // (native host allowed_origins). Replace with the Web Store ID when published.
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAs2ItI8/ZDNCCHzxaXhue4evlPXWv/TLez4IQ+IYax4Q/YF80TF+u0Modf5fV5TSOXIcwDycUNuEFHamAnHoIgzzsteERl/iPnu3c8bHhr/sWe4G1Dl0m6JmCaIECNCenFbsgqVvhJkl+LJwRkHdgMK0osmzcQVGUCniJrOTLecWFwl7Is02EPbJUMXpSvOIRsri71n4JYr+QlGJuOgEioCJ6rKM+m5Ajj6j5zxjbJ2gRljpHEKgszKYM7/EGHRQQc9CgEHzMXA360KO9Mv/TDPPC8AvHY4QIAyUJy43uazLGKd4EC6BiZs8nYKiq6KQO4BmW5H+fafcfRL6wMmVFwwIDAQAB',
    permissions: [
      'tabCapture',
      'offscreen',
      'storage',
      'downloads',
      'activeTab',
      'sidePanel',
      'nativeMessaging',
      'tabs',
    ],
    commands: {
      'start-capture': {
        suggested_key: { default: 'Alt+Shift+R' },
        description: 'Start recording the active tab',
      },
      'stop-capture': {
        suggested_key: { default: 'Alt+Shift+S' },
        description: 'Stop recording',
      },
      'open-side-panel': {
        suggested_key: { default: 'Alt+Shift+T' },
        description: 'Open the transcript side panel',
      },
    },
    // Granted per-origin from the options page (chrome.permissions.request)
    // for exactly the STT endpoint the user configures — cloud or localhost.
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    minimum_chrome_version: '116',
  },
});

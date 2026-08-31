import { defineConfig } from 'wxt';

// `wxt zip` uses command "build"; detect the zip CLI so the packed development
// `key` stays in `wxt` / `wxt build` but is stripped from the store zip.
const isZip =
  process.argv.includes('zip') || process.env.npm_lifecycle_event === 'zip';

const DEV_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAs2ItI8/ZDNCCHzxaXhue4evlPXWv/TLez4IQ+IYax4Q/YF80TF+u0Modf5fV5TSOXIcwDycUNuEFHamAnHoIgzzsteERl/iPnu3c8bHhr/sWe4G1Dl0m6JmCaIECNCenFbsgqVvhJkl+LJwRkHdgMK0osmzcQVGUCniJrOTLecWFwl7Is02EPbJUMXpSvOIRsri71n4JYr+QlGJuOgEioCJ6rKM+m5Ajj6j5zxjbJ2gRljpHEKgszKYM7/EGHRQQc9CgEHzMXA360KO9Mv/TDPPC8AvHY4QIAyUJy43uazLGKd4EC6BiZs8nYKiq6KQO4BmW5H+fafcfRL6wMmVFwwIDAQAB';

export default defineConfig({
  zip: {
    name: 'scribetab',
  },
  manifest: {
    name: 'ScribeTab',
    description:
      'BYOK meeting transcriber. Captures tab audio locally — no bot, no cloud storage.',
    // Packed key → stable development ID cambjpbepplcihlihagiheggdkfcpmef
    // (native host allowed_origins). Omitted from the store zip.
    ...(isZip ? {} : { key: DEV_KEY }),
    icons: {
      16: 'icon-16.png',
      32: 'icon-32.png',
      48: 'icon-48.png',
      128: 'icon-128.png',
    },
    action: {
      default_icon: {
        16: 'icon-16.png',
        32: 'icon-32.png',
        48: 'icon-48.png',
        128: 'icon-128.png',
      },
    },
    permissions: [
      'tabCapture',
      'offscreen',
      'storage',
      'downloads',
      'activeTab',
      'sidePanel',
      'nativeMessaging',
      'tabs',
      'notifications',
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
      'add-highlight': {
        suggested_key: { default: 'Alt+Shift+H' },
        description: 'Highlight this moment in the transcript',
      },
    },
    // Granted per-origin from the options page (chrome.permissions.request)
    // for exactly the STT endpoint the user configures — cloud or localhost.
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    minimum_chrome_version: '116',
  },
});

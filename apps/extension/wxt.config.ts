import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'ScribeTab',
    description:
      'BYOK meeting transcriber. Captures tab audio locally — no bot, no cloud storage.',
    permissions: ['tabCapture', 'offscreen', 'storage', 'downloads', 'activeTab', 'sidePanel'],
    // Granted per-origin from the options page (chrome.permissions.request)
    // for exactly the STT endpoint the user configures — cloud or localhost.
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    minimum_chrome_version: '116',
  },
});

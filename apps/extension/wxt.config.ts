import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'ScribeTab',
    description:
      'BYOK meeting transcriber. Captures tab audio locally — no bot, no cloud storage.',
    permissions: ['tabCapture', 'offscreen', 'storage', 'downloads', 'activeTab'],
    minimum_chrome_version: '116',
  },
});

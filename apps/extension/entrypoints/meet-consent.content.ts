import type { ToMeetConsent } from '@/utils/messages';

export default defineContentScript({
  matches: ['https://meet.google.com/*'],
  runAt: 'document_idle',
  main() {
    let banner: HTMLDivElement | null = null;
    let dismissed = false;

    const removeBanner = () => {
      banner?.remove();
      banner = null;
    };

    const showBanner = () => {
      if (dismissed || banner) return;
      const next = document.createElement('div');
      next.setAttribute('role', 'status');
      next.setAttribute('aria-live', 'polite');
      Object.assign(next.style, {
        position: 'fixed',
        top: '16px',
        right: '16px',
        zIndex: '2147483647',
        maxWidth: '360px',
        padding: '12px 14px',
        borderRadius: '10px',
        background: '#fff8e1',
        color: '#5f4b00',
        border: '1px solid #e6ca68',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.2)',
        font: '600 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
      });

      const text = document.createElement('span');
      text.textContent = 'ScribeTab is recording this tab — make sure everyone consents.';
      next.append(text);

      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.textContent = '×';
      dismiss.setAttribute('aria-label', 'Dismiss recording consent reminder');
      Object.assign(dismiss.style, {
        flex: '0 0 auto',
        border: '0',
        background: 'transparent',
        color: 'inherit',
        font: '700 22px/1 sans-serif',
        padding: '0 2px',
        cursor: 'pointer',
      });
      dismiss.addEventListener('click', () => {
        dismissed = true;
        removeBanner();
      });
      next.append(dismiss);
      document.documentElement.append(next);
      banner = next;
    };

    chrome.runtime.onMessage.addListener((raw: unknown) => {
      const msg = raw as ToMeetConsent;
      if (msg?.target !== 'meet-consent') return;
      if (msg.type === 'SHOW_CONSENT') showBanner();
      if (msg.type === 'HIDE_CONSENT') removeBanner();
    });
  },
});

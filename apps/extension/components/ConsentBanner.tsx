import { useEffect, useState } from 'preact/hooks';
import { getSettings, saveSettings } from '@/utils/settings';

const DISMISS_KEY = 'consentDismissedSessionId';

export function ConsentBanner({ recording }: { recording: boolean }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!recording) {
      setShow(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      const s = await getSettings();
      if (cancelled) return;
      if (!s.consentReminder) {
        setShow(false);
        return;
      }
      const { currentSessionId } = await chrome.storage.local.get('currentSessionId');
      let dismissed: string | undefined;
      try {
        const v = await chrome.storage.session.get(DISMISS_KEY);
        dismissed = typeof v[DISMISS_KEY] === 'string' ? v[DISMISS_KEY] : undefined;
      } catch {
        dismissed = undefined;
      }
      if (cancelled) return;
      if (typeof currentSessionId === 'string' && dismissed === currentSessionId) {
        setShow(false);
        return;
      }
      setShow(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [recording]);

  if (!show) return null;

  return (
    <div data-testid="consent-banner" role="status" class="st-banner st-banner--warn" style={{ margin: '8px 0' }}>
      <p style={{ margin: '0 0 8px' }}>
        Get consent from everyone in the meeting before recording. Audio is sent only to the
        transcription provider you configured.
      </p>
      <button
        type="button"
        class="st-chip"
        data-testid="consent-dismiss"
        onClick={() => {
          void chrome.storage.local.get('currentSessionId').then(async (v) => {
            const id = typeof v.currentSessionId === 'string' ? v.currentSessionId : '';
            if (id) {
              try {
                await chrome.storage.session.set({ [DISMISS_KEY]: id });
              } catch {
                // session storage unavailable — hide for this view only
              }
            }
            setShow(false);
          });
        }}
      >
        Dismiss
      </button>{' '}
      <button
        type="button"
        class="st-chip"
        data-testid="consent-dont-show"
        onClick={() => {
          void getSettings().then(async (s) => {
            await saveSettings({ ...s, consentReminder: false });
            setShow(false);
          });
        }}
      >
        Don't show again
      </button>
    </div>
  );
}

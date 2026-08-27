import { useEffect, useState } from 'preact/hooks';
import { getSettings, saveSettings } from '@/utils/settings';

export function ConsentBanner({ recording }: { recording: boolean }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!recording) {
      setShow(false);
      return;
    }
    void getSettings().then((s) => setShow(s.consentReminder));
  }, [recording]);

  if (!show) return null;

  return (
    <div
      data-testid="consent-banner"
      role="status"
      style={{ background: '#fff8e1', padding: 8, fontSize: 12, margin: '8px 0' }}
    >
      <p style={{ margin: '0 0 6px' }}>
        Get consent from everyone in the meeting before recording. Audio is sent only to the
        transcription provider you configured.
      </p>
      <button type="button" onClick={() => setShow(false)}>
        Dismiss
      </button>{' '}
      <button
        type="button"
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

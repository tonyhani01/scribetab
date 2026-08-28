import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { LibraryView } from './LibraryView';
import { LiveView } from './LiveView';
import '@/assets/theme.css';

type Tab = 'live' | 'library';

function App() {
  const [tab, setTab] = useState<Tab>('live');
  const [quotaWarning, setQuotaWarning] = useState(false);

  useEffect(() => {
    void chrome.storage.local.get('quotaWarning').then((v) => setQuotaWarning(Boolean(v.quotaWarning)));
    const onStorage = (c: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && c.quotaWarning) setQuotaWarning(Boolean(c.quotaWarning.newValue));
    };
    chrome.storage.onChanged.addListener(onStorage);
    return () => chrome.storage.onChanged.removeListener(onStorage);
  }, []);

  return (
    <main data-testid="sidepanel-root" style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <header class="st-header" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
        <div class="st-brand">
          <img src="/icon-48.png" alt="" />
          <span class="st-wordmark">scribe<b>Tab</b></span>
        </div>
        <nav class="st-seg">
          {(['live', 'library'] as const).map((t) => (
            <button key={t} aria-selected={tab === t} onClick={() => setTab(t)}>{t}</button>
          ))}
        </nav>
      </header>
      <div class="st-body" style={{ flexGrow: 1 }}>
        {quotaWarning && <p class="st-banner st-banner--warn">Storage is over 80% full. Oldest meeting audio is being removed; transcripts are kept.</p>}
        {tab === 'live' ? <LiveView /> : <LibraryView />}
      </div>
    </main>
  );
}

render(<App />, document.getElementById('app')!);

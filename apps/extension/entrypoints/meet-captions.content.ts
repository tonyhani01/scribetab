import {
  EMPTY_CAPTION_STATE,
  applyCaptionSnapshots,
  stabilizeCaption,
  type CaptionEvent,
  type CaptionReduceState,
} from '@/utils/captionReduce';
import { findCaptionsContainer, parseCaptionNodes } from '@/utils/meetSelectors';
import {
  EMPTY_MEET_CHAT_STATE,
  applyMeetChatSnapshots,
  findMeetChatContainer,
  parseMeetChatSnapshots,
  type MeetChatState,
} from '@/utils/meetChat';
import type { Ack, ToMeetCaptions } from '@/utils/messages';
import { getSettings } from '@/utils/settings';

const STABILIZE_MS = 400;
const SCAN_MS = 1000;

export default defineContentScript({
  matches: ['https://meet.google.com/*'],
  runAt: 'document_idle',
  main() {
    let reduceState: CaptionReduceState = EMPTY_CAPTION_STATE;
    let container: Element | null = null;
    let containerObserver: MutationObserver | null = null;
    let stabilizeTimer: number | null = null;
    let boot: MutationObserver | null = null;
    let scanInterval: number | null = null;
    let scanTimer: number | null = null;
    let capturing = false;
    let chatState: MeetChatState = EMPTY_MEET_CHAT_STATE;
    let chatContainer: Element | null = null;
    let chatContainerObserver: MutationObserver | null = null;
    let chatDiscovery: MutationObserver | null = null;
    let chatScanInterval: number | null = null;
    let chatScanTimer: number | null = null;
    let chatEnabled = false;
    let chatSettingsEpoch = 0;

    const send = (ev: CaptionEvent) => {
      if (!capturing) return;
      void chrome.runtime
        .sendMessage({
          target: 'background',
          type: 'CAPTION_EVENT',
          speaker: ev.speaker,
          text: ev.text,
          timestampMs: ev.timestampMs,
          endMs: ev.endMs,
        })
        .catch(() => {
          // Service worker may be asleep; next caption retries.
        });
    };

    const scheduleStabilize = () => {
      if (stabilizeTimer != null) window.clearTimeout(stabilizeTimer);
      stabilizeTimer = window.setTimeout(() => {
        const r = stabilizeCaption(reduceState, Date.now(), STABILIZE_MS);
        reduceState = r.state;
        for (const ev of r.events) send(ev);
      }, STABILIZE_MS);
    };

    const handleChatMutations = () => {
      if (!chatContainer || !capturing || !chatEnabled) return;
      const applied = applyMeetChatSnapshots(
        chatState,
        parseMeetChatSnapshots(chatContainer),
      );
      chatState = applied.state;
      // Meet does not expose a stable sent-at value here; cues use observation time.
      const now = Date.now();
      applied.events.forEach((event, index) => {
        send({
          speaker: `${event.author} (chat)`,
          text: event.text,
          timestampMs: now + index,
          endMs: now + index + 1,
        });
      });
    };

    const handleMutations = () => {
      if (!container || !capturing) return;
      const now = Date.now();
      const snaps = parseCaptionNodes(container);
      const applied = applyCaptionSnapshots(reduceState, snaps, now);
      reduceState = applied.state;
      for (const ev of applied.events) send(ev);
      scheduleStabilize();
    };

    const detach = () => {
      containerObserver?.disconnect();
      containerObserver = null;
      container = null;
    };

    const detachChat = () => {
      chatContainerObserver?.disconnect();
      chatContainerObserver = null;
      chatContainer = null;
    };

    const disarmDiscovery = () => {
      boot?.disconnect();
      boot = null;
      if (scanInterval != null) {
        window.clearInterval(scanInterval);
        scanInterval = null;
      }
      if (scanTimer != null) {
        window.clearTimeout(scanTimer);
        scanTimer = null;
      }
    };

    const disarmChatDiscovery = () => {
      chatDiscovery?.disconnect();
      chatDiscovery = null;
      if (chatScanTimer != null) {
        window.clearTimeout(chatScanTimer);
        chatScanTimer = null;
      }
    };

    const requestChatScan = () => {
      if (!capturing || !chatEnabled || chatScanTimer != null) return;
      chatScanTimer = window.setTimeout(() => {
        chatScanTimer = null;
        scanChat();
      }, 100);
    };

    const armChatDiscovery = () => {
      if (!capturing || !chatEnabled) return;
      if (!chatDiscovery) {
        chatDiscovery = new MutationObserver(requestChatScan);
        chatDiscovery.observe(document.documentElement, { childList: true, subtree: true });
      }
      if (chatScanInterval == null) {
        chatScanInterval = window.setInterval(scanChat, SCAN_MS);
      }
    };

    function scanChat() {
      if (!capturing || !chatEnabled) return;
      const found = findMeetChatContainer(document);
      if (!found) {
        detachChat();
        armChatDiscovery();
        return;
      }
      if (found === chatContainer) {
        handleChatMutations();
        return;
      }
      detachChat();
      chatContainer = found;
      disarmChatDiscovery();
      chatContainerObserver = new MutationObserver(handleChatMutations);
      chatContainerObserver.observe(chatContainer, {
        subtree: true,
        childList: true,
        characterData: true,
      });
      handleChatMutations();
    }

    const stopChatObserving = () => {
      disarmChatDiscovery();
      if (chatScanInterval != null) {
        window.clearInterval(chatScanInterval);
        chatScanInterval = null;
      }
      detachChat();
      chatState = EMPTY_MEET_CHAT_STATE;
      chatEnabled = false;
    };

    const refreshChatSetting = async () => {
      const epoch = ++chatSettingsEpoch;
      try {
        const settings = await getSettings();
        if (!capturing || epoch !== chatSettingsEpoch) return;
        if (!settings.saveMeetChat) {
          stopChatObserving();
          return;
        }
        chatEnabled = true;
        armChatDiscovery();
        scanChat();
      } catch {
        // Storage unavailable or an unsupported Meet DOM: chat capture stays off.
      }
    };

    const scan = () => {
      if (!capturing) return;
      const found = findCaptionsContainer(document);
      if (found.status === 'not_found') {
        if (container) {
          const flushed = applyCaptionSnapshots(reduceState, [], Date.now());
          reduceState = flushed.state;
          for (const ev of flushed.events) send(ev);
        }
        detach();
        armDiscovery();
        return;
      }
      if (found.element === container) return;
      detach();
      container = found.element;
      disarmDiscovery();
      containerObserver = new MutationObserver(handleMutations);
      containerObserver.observe(container, {
        subtree: true,
        childList: true,
        characterData: true,
      });
      handleMutations();
    };

    const requestScan = () => {
      if (!capturing) return;
      if (scanTimer != null) return;
      scanTimer = window.setTimeout(() => {
        scanTimer = null;
        scan();
      }, 100);
    };

    const armDiscovery = () => {
      if (!capturing) return;
      if (!boot) {
        boot = new MutationObserver(requestScan);
        boot.observe(document.documentElement, { childList: true, subtree: true });
      }
      if (scanInterval == null) scanInterval = window.setInterval(scan, SCAN_MS);
    };

    const stopObserving = () => {
      if (stabilizeTimer != null) {
        window.clearTimeout(stabilizeTimer);
        stabilizeTimer = null;
      }
      const flushed = applyCaptionSnapshots(reduceState, [], Date.now());
      reduceState = EMPTY_CAPTION_STATE;
      for (const ev of flushed.events) send(ev);
      disarmDiscovery();
      detach();
    };

    const startObserving = () => {
      reduceState = EMPTY_CAPTION_STATE;
      armDiscovery();
      scan();
    };

    const setCapturing = (active: boolean) => {
      if (active === capturing) {
        if (active) {
          scan();
          void refreshChatSetting();
        }
        return;
      }
      if (active) {
        capturing = true;
        startObserving();
        void refreshChatSetting();
      } else {
        chatSettingsEpoch++;
        stopChatObserving();
        stopObserving(); // flush while capturing is still true so last cues send
        capturing = false;
      }
    };

    chrome.runtime.onMessage.addListener((raw: unknown) => {
      const msg = raw as ToMeetCaptions;
      if (msg?.target !== 'meet-captions' || msg.type !== 'CAPTURE_ACTIVE') return;
      setCapturing(Boolean(msg.active));
    });

    void chrome.runtime
      .sendMessage({ target: 'background', type: 'CAPTION_CAPTURE_QUERY' })
      .then((ack: Ack | undefined) => {
        if (ack?.captured) setCapturing(true);
      })
      .catch(() => {
        // SW asleep — CAPTURE_ACTIVE broadcast will arm us when capture starts.
      });
  },
});

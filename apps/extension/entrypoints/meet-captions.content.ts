import {
  EMPTY_CAPTION_STATE,
  applyCaptionSnapshots,
  stabilizeCaption,
  type CaptionEvent,
  type CaptionReduceState,
} from '@/utils/captionReduce';
import { findCaptionsContainer, parseCaptionNodes } from '@/utils/meetSelectors';

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

    const send = (ev: CaptionEvent) => {
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

    const handleMutations = () => {
      if (!container) return;
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

    const scan = () => {
      const found = findCaptionsContainer(document);
      if (found.status === 'not_found') {
        if (container) {
          const flushed = applyCaptionSnapshots(reduceState, [], Date.now());
          reduceState = flushed.state;
          for (const ev of flushed.events) send(ev);
        }
        detach();
        return;
      }
      if (found.element === container) return;
      detach();
      container = found.element;
      containerObserver = new MutationObserver(handleMutations);
      containerObserver.observe(container, {
        subtree: true,
        childList: true,
        characterData: true,
      });
      handleMutations();
    };

    let scanTimer: number | null = null;
    const requestScan = () => {
      if (scanTimer != null) return;
      scanTimer = window.setTimeout(() => {
        scanTimer = null;
        scan();
      }, 100);
    };

    const boot = new MutationObserver(requestScan);
    boot.observe(document.documentElement, { childList: true, subtree: true });
    window.setInterval(scan, SCAN_MS);
    scan();
  },
});

import { describe, expect, it } from 'vitest';
import {
  EMPTY_MEET_CHAT_STATE,
  applyMeetChatSnapshots,
  parseMeetChatSnapshots,
} from '../utils/meetChat';

describe('applyMeetChatSnapshots', () => {
  it('normalizes and emits the first observed messages in DOM order', () => {
    const result = applyMeetChatSnapshots(EMPTY_MEET_CHAT_STATE, [
      { author: '  Ada  ', text: ' First\nmessage ' },
      { author: 'Bo', text: 'Second message' },
    ]);

    expect(result.events).toEqual([
      { author: 'Ada', text: 'First message' },
      { author: 'Bo', text: 'Second message' },
    ]);
  });

  it('does not re-emit unchanged snapshots after a DOM rerender', () => {
    const first = applyMeetChatSnapshots(EMPTY_MEET_CHAT_STATE, [
      { author: 'Ada', text: 'Hello' },
      { author: 'Bo', text: 'Hi' },
    ]);
    const rerendered = applyMeetChatSnapshots(first.state, [
      { author: 'Ada', text: 'Hello' },
      { author: 'Bo', text: 'Hi' },
    ]);

    expect(rerendered.events).toEqual([]);
  });

  it('emits a repeated identical message when it is a new occurrence', () => {
    const first = applyMeetChatSnapshots(EMPTY_MEET_CHAT_STATE, [
      { author: 'Ada', text: 'Same' },
    ]);
    const appended = applyMeetChatSnapshots(first.state, [
      { author: 'Ada', text: 'Same' },
      { author: 'Ada', text: 'Same' },
    ]);

    expect(appended.events).toEqual([{ author: 'Ada', text: 'Same' }]);
  });

  it('preserves order when Meet trims old messages from the DOM', () => {
    const first = applyMeetChatSnapshots(EMPTY_MEET_CHAT_STATE, [
      { author: 'Ada', text: 'One' },
      { author: 'Bo', text: 'Two' },
    ]);
    const shifted = applyMeetChatSnapshots(first.state, [
      { author: 'Bo', text: 'Two' },
      { author: 'Cy', text: 'Three' },
      { author: 'Dee', text: 'Four' },
    ]);

    expect(shifted.events).toEqual([
      { author: 'Cy', text: 'Three' },
      { author: 'Dee', text: 'Four' },
    ]);
  });

  it('does not replay seen messages when Meet prepends older history', () => {
    const first = applyMeetChatSnapshots(EMPTY_MEET_CHAT_STATE, [
      { author: 'Bo', text: 'Two' },
      { author: 'Cy', text: 'Three' },
    ]);
    const hydrated = applyMeetChatSnapshots(first.state, [
      { author: 'Ada', text: 'One' },
      { author: 'Bo', text: 'Two' },
      { author: 'Cy', text: 'Three' },
      { author: 'Dee', text: 'Four' },
    ]);

    expect(hydrated.events).toEqual([{ author: 'Dee', text: 'Four' }]);
  });

  it('drops blank or malformed-looking snapshots', () => {
    const result = applyMeetChatSnapshots(EMPTY_MEET_CHAT_STATE, [
      { author: ' ', text: 'No author' },
      { author: 'Ada', text: ' ' },
      { author: 'Bo', text: 'Kept' },
    ]);

    expect(result.events).toEqual([{ author: 'Bo', text: 'Kept' }]);
  });
});

describe('parseMeetChatSnapshots', () => {
  it('keeps message text that starts with the author name', () => {
    const authorElement = { textContent: 'Ada', getAttribute: () => null } as unknown as Element;
    const textElement = {
      textContent: 'Ada please review',
      getAttribute: () => null,
    } as unknown as Element;
    let group: Element;
    group = {
      textContent: 'Ada Ada please review',
      parentElement: null,
      closest: () => group,
      getAttribute: () => null,
      querySelector(selector: string) {
        if (selector === '.poVWob') return authorElement;
        if (selector === '[data-message-text]') return textElement;
        return null;
      },
    } as unknown as Element;
    const root = {
      querySelectorAll: () => [group] as unknown as NodeListOf<Element>,
    } as unknown as ParentNode;

    expect(parseMeetChatSnapshots(root)).toEqual([
      { author: 'Ada', text: 'Ada please review' },
    ]);
  });
});

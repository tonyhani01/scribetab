import { describe, expect, it } from 'vitest';
import { originPattern } from '../src/originPattern';

describe('originPattern', () => {
  it('turns an https endpoint into a host match pattern', () => {
    expect(originPattern('https://api.openai.com/v1')).toBe('https://api.openai.com/*');
  });

  it('drops ports — match patterns cover all ports of a host', () => {
    expect(originPattern('http://localhost:8080/v1')).toBe('http://localhost/*');
    expect(originPattern('http://127.0.0.1:9000')).toBe('http://127.0.0.1/*');
  });

  it('drops paths and query strings', () => {
    expect(originPattern('https://api.deepgram.com/v1/listen?model=nova-2')).toBe('https://api.deepgram.com/*');
  });

  it('rejects non-http(s) schemes and garbage', () => {
    expect(() => originPattern('ftp://example.com')).toThrow(/http/);
    expect(() => originPattern('not a url')).toThrow();
  });
});

import type { TranscriptionProvider } from '../types.js';
import { customProvider } from './custom.js';
import { deepgramProvider } from './deepgram.js';
import { googleProvider } from './google.js';
import { groqProvider } from './groq.js';
import { mistralProvider } from './mistral.js';
import { openaiProvider } from './openai.js';
import { openrouterProvider } from './openrouter.js';

const providers: Record<string, TranscriptionProvider> = {
  openai: openaiProvider,
  groq: groqProvider,
  deepgram: deepgramProvider,
  mistral: mistralProvider,
  openrouter: openrouterProvider,
  google: googleProvider,
  custom: customProvider,
};

export const TRANSCRIPTION_PROVIDER_IDS = Object.freeze(Object.keys(providers));

export function getTranscriptionProvider(id: string): TranscriptionProvider {
  const p = providers[id];
  if (!p) throw new Error(`Unknown transcription provider: ${id}`);
  return p;
}

/** Where a config will actually send audio — the origin the extension must hold host permission for. */
const defaultBaseUrls: Record<string, string | undefined> = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  deepgram: 'https://api.deepgram.com',
  mistral: 'https://api.mistral.ai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  custom: undefined,
};

/** Official cloud endpoints ignore a stale custom baseUrl so keys cannot leak. */
export function transcriptionEndpoint(providerId: string, baseUrl?: string): string {
  if (providerId === 'custom') {
    if (!baseUrl) throw new Error(`${providerId}: baseUrl is required`);
    return baseUrl;
  }
  const d = defaultBaseUrls[providerId];
  if (!d) throw new Error(`${providerId}: baseUrl is required`);
  return d;
}

export {
  customProvider,
  deepgramProvider,
  googleProvider,
  groqProvider,
  mistralProvider,
  openaiProvider,
  openrouterProvider,
};
export { openAiCompatible } from './openaiCompatible.js';

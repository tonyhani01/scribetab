import type { TranscriptionProvider } from '../types.js';
import { customProvider } from './custom.js';
import { deepgramProvider } from './deepgram.js';
import { GOOGLE_API_BASE, googleProvider } from './google.js';
import { groqProvider } from './groq.js';
import { mistralProvider } from './mistral.js';
import { openaiProvider } from './openai.js';
import { openrouterProvider } from './openrouter.js';

export const TRANSCRIPTION_PROVIDER_IDS = [
  'openai',
  'groq',
  'deepgram',
  'mistral',
  'openrouter',
  'google',
  'custom',
] as const;

export type TranscriptionProviderId = (typeof TRANSCRIPTION_PROVIDER_IDS)[number];

export function isTranscriptionProviderId(id: string): id is TranscriptionProviderId {
  return (TRANSCRIPTION_PROVIDER_IDS as readonly string[]).includes(id);
}

const providers: Record<TranscriptionProviderId, TranscriptionProvider> = {
  openai: openaiProvider,
  groq: groqProvider,
  deepgram: deepgramProvider,
  mistral: mistralProvider,
  openrouter: openrouterProvider,
  google: googleProvider,
  custom: customProvider,
};

export function getTranscriptionProvider(id: string): TranscriptionProvider {
  if (!isTranscriptionProviderId(id)) throw new Error(`Unknown transcription provider: ${id}`);
  return providers[id];
}

/** Where a config will actually send audio — the origin the extension must hold host permission for. */
const defaultBaseUrls: Record<TranscriptionProviderId, string | undefined> = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  deepgram: 'https://api.deepgram.com',
  mistral: 'https://api.mistral.ai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  google: GOOGLE_API_BASE,
  custom: undefined,
};

/** Official cloud endpoints ignore a stale custom baseUrl so keys cannot leak. */
export function transcriptionEndpoint(providerId: string, baseUrl?: string): string {
  if (providerId === 'custom') {
    if (!baseUrl) throw new Error(`${providerId}: baseUrl is required`);
    return baseUrl;
  }
  const d = isTranscriptionProviderId(providerId) ? defaultBaseUrls[providerId] : undefined;
  if (!d) throw new Error(`${providerId}: baseUrl is required`);
  return d;
}

export {
  GOOGLE_API_BASE,
  customProvider,
  deepgramProvider,
  googleProvider,
  groqProvider,
  mistralProvider,
  openaiProvider,
  openrouterProvider,
};
export { openAiCompatible } from './openaiCompatible.js';

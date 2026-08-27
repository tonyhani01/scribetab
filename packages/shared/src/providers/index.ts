import type { TranscriptionProvider } from '../types';
import { customProvider } from './custom';
import { deepgramProvider } from './deepgram';
import { groqProvider } from './groq';
import { mistralProvider } from './mistral';
import { openaiProvider } from './openai';

const providers: Record<string, TranscriptionProvider> = {
  openai: openaiProvider,
  groq: groqProvider,
  deepgram: deepgramProvider,
  mistral: mistralProvider,
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
  custom: undefined,
};

export function transcriptionEndpoint(providerId: string, baseUrl?: string): string {
  if (baseUrl) return baseUrl;
  const d = defaultBaseUrls[providerId];
  if (!d) throw new Error(`${providerId}: baseUrl is required`);
  return d;
}

export { customProvider, deepgramProvider, groqProvider, mistralProvider, openaiProvider };
export { openAiCompatible } from './openaiCompatible';

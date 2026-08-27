import { openAiCompatible } from './openaiCompatible';

// Voxtral speaks the OpenAI multipart dialect but takes
// timestamp_granularities=segment instead of response_format=verbose_json.
export const mistralProvider = openAiCompatible({
  id: 'mistral',
  defaultBaseUrl: 'https://api.mistral.ai/v1',
  defaultModel: 'voxtral-mini-latest',
  form: { timestamp_granularities: 'segment' },
});

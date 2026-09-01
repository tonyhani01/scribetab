import { openAiCompatible } from './openaiCompatible.js';

// Voxtral speaks the OpenAI multipart dialect but takes
// timestamp_granularities=segment instead of response_format=verbose_json.
// Its own vocabulary hook is documented as `context_bias`, not `prompt`, so the
// shared adapter's `prompt` field may be ignored here — the `wrong=>right`
// replacement dictionary is the reliable path for this provider.
export const mistralProvider = openAiCompatible({
  id: 'mistral',
  defaultBaseUrl: 'https://api.mistral.ai/v1',
  defaultModel: 'voxtral-mini-latest',
  form: { timestamp_granularities: 'segment' },
});

# @scribetab/shared

Locked TypeScript contracts plus pure helpers used by the extension and the
native host: WAV/chunker, STT and LLM adapters, export formats, caption fusion,
redaction, costs.

```
pnpm --filter @scribetab/shared test
pnpm --filter @scribetab/shared build
```

WXT consumes TypeScript source via the `development` export condition. Node
(native host) imports `dist/` after `pnpm --filter @scribetab/shared build`.

Do not change `src/types.ts` without updating the roadmap locked-contract
section.

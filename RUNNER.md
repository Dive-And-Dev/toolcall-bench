# Phase 3 offline smoke results

These are **synthetic mock results**, not measurements of any live model. No MCP tool calls or paid provider requests were made.

Commands:

```sh
npm run build
npm test
npm run lint-tasks -- --all
node dist/cli.js run --all --driver mock --ci --trials 3
node dist/cli.js run --suite suites/memory --driver mock --ci --trials 3 --seed 43 --out results/seed43
node dist/cli.js diff results/memory.mock.mock-v1.json results/seed43/memory.mock.mock-v1.json --markdown
```

The default seed is 42, correct-selection probability 0.8, deliberately-invalid-argument probability 0.2. The nine suites total 170 tasks and 510 trials; all task prompts pass leakage lint. Reports/traces are kept locally under the gitignored results directory. Filesystem was refreshed after adding the deprecated text-reading alias as an acceptable answer; scores were unchanged.

| Suite | Selection | Conditional parameter compliance | End-to-end first try | Strict schema compilation errors |
|---|---:|---:|---:|---:|
| cloudflare | 0.8000 | 0.8333 | 0.6833 | 1 |
| fetch | 0.8667 | 0.8167 | 0.7000 | 0 |
| filesystem | 0.7667 | 0.9561 | 0.7333 | 0 |
| github | 0.7500 | 0.8083 | 0.6167 | 0 |
| github-official | 0.8833 | 0.7000 | 0.6333 | 1 |
| memory | 0.7667 | 0.7083 | 0.5333 | 0 |
| notion | 0.8000 | 0.8250 | 0.6667 | 1 |
| playwright | 0.7833 | 0.7833 | 0.6333 | 0 |
| resend | 0.8833 | 0.7583 | 0.7000 | 6 |

Fetch selection is labeled `trivial_single_tool`; random mock abstentions explain its score below 1. Conditional scores are means over eligible task means, not a pooled fraction of all trials. Full percentile intervals and denominators are in each report.

## Seed 42 → 43: memory

| Metric | Delta | Paired 95% CI | p-value | Verdict |
|---|---:|---|---:|---|
| tool_selection_accuracy | 0.0000 | [-0.1833, 0.1833] | 0.9956 | not_significant |
| param_compliance_conditional | 0.1583 | [-0.0250, 0.3333] | 0.1036 | not_significant |
| end_to_end_first_try_pass | 0.1167 | [-0.0333, 0.2667] | 0.1044 | not_significant |

Token delta 0; lint delta 0. CLI regression exit behavior is also covered by a deterministic perfect-versus-wrong mock integration test.

## Strict-schema compatibility findings

Real manifests were not modified or silently relaxed. AJV strict compilation rejects the following definitions. Affected calls fail schema validation; these are harness compatibility findings, not evidence of poor model behavior or necessarily invalid JSON Schema under a less restrictive validator.

- Cloudflare `worker_put`: `strict mode: missing type "array" for keyword "items" at "#/properties/migrations" (strictTypes)`.
- Official GitHub `issue_write`: `strict mode: use allowUnionTypes to allow union type keyword at "#/properties/issue_fields/items/properties/value" (strictTypes)`.
- Notion `API-post-page`: `unknown format "json" ignored in schema at path "#/properties/icon"` (thrown under strict mode despite the wording).
- Resend `create-contact-property`, `update-contact-property`, `create-contact`, `update-contact`, `create-template`, and `update-template`: `strict mode: use allowUnionTypes to allow union type keyword` at their respective value/fallbackValue schemas.

The adapters were tested against stubbed HTTP responses, including first-call extraction and retry behavior. Live provider schema support, tool-count limits, and actual model quality remain unverified.

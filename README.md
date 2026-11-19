# toolcall-bench

Strict TypeScript MCP tool-calling DX evaluation harness: real catalogs, deterministic analysis, blind tasks, and single-turn model evaluation.

Requires Node >=20 for the CLI; Node 22.12+ for development tests.

```sh
npm ci
npm run build
npm test
node dist/cli.js snapshot --cmd 'npx -y @playwright/mcp@0.0.86' --out suites/playwright/manifest.json
node dist/cli.js snapshot --url https://example.com/mcp --header 'Authorization: Bearer TOKEN' --out manifest.json
```

`--env KEY=VALUE` and `--header 'Name: Value'` are repeatable. Supply exactly one of `--cmd` (a trusted shell command) or `--url` (Streamable HTTP). Snapshots paginate tools/list, record negotiated initialize metadata, and write only after a complete successful capture. `--timeout` sets a total timeout in milliseconds (default 60000). No tools are invoked.

See [SNAPSHOTS.md](SNAPSHOTS.md) for versions, reproducible capture commands, offline dummy-token checks, and skips. Config and evaluation data schemas live in `src/types.ts`.

## Deterministic analysis

```sh
node dist/cli.js lint suites/playwright/manifest.json
node dist/cli.js lint --all
node dist/cli.js lint --all --json
```

Token reports use `o200k_base` over compact JSON of the tools array projected to `name`, `description`, and `inputSchema`. Catalog tokens include JSON array framing and need not equal the sum of individual tool tokens. Empty catalogs have zero median but still count the `[]` framing.

Lint reports contain findings, counts by rule, aggregate findings/tool density, and per-tool counts. Paths are JSON Pointers within each tool. The walker checks nested properties, arrays, composition branches, and reachable local references (each definition once per tool), ignoring unused definitions. Empty root argument objects are treated as parameterless tools. Explicit `additionalProperties` guidance, including `true` or `false`, avoids untyped-object findings. Unit-bearing names such as `limit-bytes` and enum/const selectors avoid ambiguous-unit findings. Finite-enum checks deliberately skip examples and conditional prose. Overlap uses lowercase alphanumeric token sets with English stopwords removed, requires at least three meaningful tokens on both sides, and defaults to Jaccard >=0.6; each pair is counted once, attributed to the first tool. Textual overlap is a review signal, not proof of semantic duplication.

`clusterBootstrap(tasks, { B, seed })` in `src/analyzer/stats.ts` accepts nonempty binary outcome arrays per task and weights each task equally, including when trial counts vary. It resamples whole tasks with replacement, defaults to 5000 draws and seed 42 (mulberry32), and uses linearly interpolated 2.5/97.5 percentiles. It reports total observed trials, not bootstrap sample counts. Empty data, nonbinary outcomes, invalid seeds and nonpositive/noninteger B are rejected.

`pairedBootstrap(baseline, candidate, options)` accepts `{id, outcomes}` records. It matches the intersection of ids, sorts ids for order-independent seeded output, reports unmatched counts, and resamples paired task deltas (candidate minus baseline). `n_trials` counts both arms of matched tasks. Duplicate ids and no matched tasks are errors. The two-sided p-value doubles bootstrap mass at or across zero on the opposite side of the observed delta, capped at 1 (no pseudocount). Verdicts use CI exclusion of zero, not the p-value. A single-task or homogeneous-task interval can be degenerate: these intervals represent task sampling variability, not within-task trial uncertainty.

## Tasks and leakage

Each captured suite has 20 intent-based developer tasks (fetch has 10). Tasks specify acceptable real catalog names, JSON Pointer semantic assertions (`equals`, `matches`, `iso8601: true`, `exists`, or `oneOf`), rationale and tags. Assertions run against the first call's arguments, not tool output. No MCP tools are executed, including destructive operations mentioned in prompts. Fixture identifiers and addresses are synthetic.

```sh
npm run lint-tasks -- --all
node dist/cli.js lint-tasks suites/memory
```

Task lint checks against **every** name in the suite, not just golden names. Multi-token identifiers are rejected case-insensitively in exact, snake_case, camelCase, kebab-case, concatenated, and contiguous split-word forms with identifier boundaries. Single-token names such as `fetch` are rejected only in backticks or followed by `(` or the word `tool`, preserving ordinary English. A finding or invalid suite exits 1. With no arguments, lint-tasks checks all captured suites. The loader also validates schemas, unique ids, assertion regexes, and expected-name membership; evaluation refuses leaking tasks.

## Single-turn evaluation

```sh
node dist/cli.js run --all --driver mock --ci --trials 3
node dist/cli.js run --suite suites/memory --driver mock --ci --seed 43 --out results/seed43
node dist/cli.js diff results/memory.mock.mock-v1.json results/seed43/memory.mock.mock-v1.json --markdown
node dist/cli.js diff baseline.json candidate.json --fail-on-regression

# Live calls incur provider charges; set the corresponding key in your environment.
node dist/cli.js run --suite suites/memory --driver anthropic --model MODEL_ID
node dist/cli.js run --suite suites/memory --driver openai --model MODEL_ID
node dist/cli.js run --suite suites/memory --driver gemini --model MODEL_ID
```

- Native fetch adapters use `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY`; credentials are never written to traces. Requests have a neutral system prompt, the task prompt, and the entire manifest catalog. Golden names, assertions, rationale and tags are **not sent** to providers. No tool call is forced. Only the first call is scored, while the full raw response is retained. Gemini uses `parametersJsonSchema`; all adapters currently preserve schemas without sanitization, recording `schema_transformations: []`. Unsupported schemas/catalog limits may produce provider errors rather than silently altering the benchmark.
- HTTP 429 and 5xx responses retry up to three times with 500ms exponential backoff; each HTTP attempt has a 60-second timeout. Final provider errors and missing/no calls are scored as failures, not dropped trials. `--concurrency` limits simultaneous model requests (default 4); `--trials` defaults to 3.
- Mock requires `--ci` or exactly `CI=true`. It is seeded per task/trial, independent of scheduling, and defaults to 0.8 correct-selection probability and 0.2 deliberately-invalid-argument probability. Both probabilities have CLI flags. Mock argument generation uses golden assertions **only for synthetic harness testing**; its schema sampler is intentionally not a general solver. Reports and traces carry `driver: "mock"` and mock configuration. Never interpret mock scores as model quality.
- `tool_selection_accuracy`: acceptable name selected. Generic executors are N/A; fetch is labeled `trivial_single_tool`.
- `param_compliance_conditional`: strict AJV schema validity among correct selections, per task. Tasks without correct selections have no conditional denominator and are omitted; if none remain, the metric is N/A. This metric does not include semantic assertions.
- `end_to_end_first_try_pass`: correct selection **and** schema validity **and** all semantic assertions pass, without repair or further turns.
- Each metric uses task-level cluster bootstrap CIs, not independent-trial intervals. Generic-executor selection is N/A, but expected-name checks still gate parameter and end-to-end scoring.
- AJV uses strict mode, ajv-formats, no coercion/default insertion, and draft-appropriate validators. `x-mcp-header` is registered only as an annotation. Unsupported or strict-invalid real schemas are not repaired: compilation errors are included in the report/traces and affected calls fail schema validity. This measures harness compatibility too; inspect those errors before attributing failures to models.
- `results/<suite>.<driver>.<model>.json` contains trial scores, metric CIs, snapshot provenance, manifest/task hashes, token/lint summaries, and timestamps. The neighboring `.traces.jsonl` contains prompts, raw responses, the scored call, AJV errors, assertion outcomes, and schema transformations. Unsafe filename characters are replaced with underscores. Output files are overwritten for the same suite/driver/model; use separate `--out` directories for distinct seeds or experiments. Results are gitignored.
- Diffs require the same suite and identical task-definition hash, pair by task id, and include per-metric delta CIs/p-values/verdicts plus token/lint deltas. Conditional comparisons use tasks with a denominator in **both** arms, reporting unmatched counts. `--fail-on-regression` exits 1 if any comparable metric has a CI strictly below zero. No multiple-comparison correction is applied; lint/token deltas alone do not trigger that flag.

See [RUNNER.md](RUNNER.md) for the offline smoke-run results and observed strict-schema limitations. Live provider adapters are covered by stubbed HTTP tests, not by paid network calls.

# toolcall-bench

Strict TypeScript MCP tool-calling DX evaluation harness (Phase 1: real tool catalogs).

Requires Node >=20 for the CLI; Node 22.12+ for development tests.

```sh
npm ci
npm run build
npm test
node dist/cli.js snapshot --cmd 'npx -y @playwright/mcp@0.0.86' --out suites/playwright/manifest.json
node dist/cli.js snapshot --url https://example.com/mcp --header 'Authorization: Bearer TOKEN' --out manifest.json
```

`--env KEY=VALUE` and `--header 'Name: Value'` are repeatable. Supply exactly one of `--cmd` (a trusted shell command) or `--url` (Streamable HTTP). Snapshots paginate tools/list, record negotiated initialize metadata, and write only after a complete successful capture. `--timeout` sets a total timeout in milliseconds (default 60000). No tools are invoked.

See [SNAPSHOTS.md](SNAPSHOTS.md) for versions, reproducible capture commands, offline dummy-token checks, and skips. Config and evaluation data schemas live in `src/types.ts`. Evaluation execution and task linting are planned for later phases; `lint-tasks` is explicitly a placeholder.

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

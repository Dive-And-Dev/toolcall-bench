# Live ZenMux evaluation

These are paid, single-turn model evaluations over the committed catalogs, **not mock scores**. No MCP operations were executed. Each suite has its own tasks; this is not a cross-server ranking.

## Provenance and reproduction

- Gateway: `https://zenmux.ai/api/v1`, using OpenAI chat completions and `ZENMUX_API_KEY`.
- Requested and returned model IDs: `anthropic/claude-sonnet-5.5` and `openai/gpt-5.5`. Both were listed by `/models`; no substitutions were needed.
- Benchmark window: `2026-11-20T06:36:10.068Z` through `2026-11-20T06:49:51.825Z`.
- Nine suites, 170 tasks, three trials per task per model: **1,020 scored calls**. Each model ran with concurrency two, for a maximum of four simultaneous requests across both processes. The adapter retries HTTP 429/5xx with exponential backoff, up to three retries.
- Before the full runs, one memory task per model passed a live smoke test. Smoke outputs are not mixed into the committed results.
- Task prompts explicitly quote the exact wording for all 27 multi-word string equality assertions. Other determined equalities are unchanged. Leakage lint passes across all 170 tasks.
- `results/` contains 18 reports and 18 matching JSONL traces. Each report records gateway/model ID, current manifest/task hashes, snapshot provenance, trial usage, and request-attempt counts. Existing synthetic outputs were moved locally to ignored `results-mock/`.

After securely setting `ZENMUX_API_KEY` in your shell (live calls incur charges):

```sh
npm ci
npm run build
node dist/cli.js run --all --driver zenmux --model anthropic/claude-sonnet-5.5 --trials 3 --concurrency 2 --out results
node dist/cli.js run --all --driver zenmux --model openai/gpt-5.5 --trials 3 --concurrency 2 --out results
node dist/cli.js build-site --results results --out dist-site
```

The two recorded model runs were launched concurrently. Re-running overwrites matching filenames; use another output directory to preserve these artifacts. Provider sampling defaults were used, so requests are not guaranteed to reproduce model responses. Bootstrap intervals are deterministic with `B=5000`, seed `42`.

## Within-suite metrics

All entries are percentages: **mean [95% task-cluster bootstrap CI]**. Conditional parameters measure schema compliance on correct selections, not semantic assertion compliance. Fetch has one tool, so its selection metric is trivial. Perfect observed task outcomes yield degenerate empirical bootstrap intervals; they do not establish perfect population performance. See [METHODOLOGY.md](METHODOLOGY.md) for definitions and limitations.

| Suite | Model | Selection | Conditional parameters | End-to-end first try |
|---|---|---|---|---|
| cloudflare | anthropic/claude-sonnet-5.5 | 100.0 [100.0, 100.0] | 100.0 [100.0, 100.0] | 100.0 [100.0, 100.0] |
| cloudflare | openai/gpt-5.5 | 85.0 [70.0, 100.0] | 100.0 [100.0, 100.0] | 85.0 [70.0, 100.0] |
| fetch | anthropic/claude-sonnet-5.5 | 100.0 [100.0, 100.0] | 100.0 [100.0, 100.0] | 100.0 [100.0, 100.0] |
| fetch | openai/gpt-5.5 | 100.0 [100.0, 100.0] | 100.0 [100.0, 100.0] | 100.0 [100.0, 100.0] |
| filesystem | anthropic/claude-sonnet-5.5 | 95.0 [85.0, 100.0] | 100.0 [100.0, 100.0] | 95.0 [85.0, 100.0] |
| filesystem | openai/gpt-5.5 | 91.7 [78.3, 100.0] | 100.0 [100.0, 100.0] | 91.7 [78.3, 100.0] |
| github | anthropic/claude-sonnet-5.5 | 100.0 [100.0, 100.0] | 100.0 [100.0, 100.0] | 100.0 [100.0, 100.0] |
| github | openai/gpt-5.5 | 100.0 [100.0, 100.0] | 100.0 [100.0, 100.0] | 100.0 [100.0, 100.0] |
| github-official | anthropic/claude-sonnet-5.5 | 100.0 [100.0, 100.0] | 90.0 [75.0, 100.0] | 90.0 [75.0, 100.0] |
| github-official | openai/gpt-5.5 | 100.0 [100.0, 100.0] | 90.0 [75.0, 100.0] | 85.0 [70.0, 100.0] |
| memory | anthropic/claude-sonnet-5.5 | 90.0 [75.0, 100.0] | 100.0 [100.0, 100.0] | 90.0 [75.0, 100.0] |
| memory | openai/gpt-5.5 | 76.7 [58.3, 91.7] | 100.0 [100.0, 100.0] | 76.7 [58.3, 91.7] |
| notion | anthropic/claude-sonnet-5.5 | 95.0 [85.0, 100.0] | 100.0 [100.0, 100.0] | 95.0 [85.0, 100.0] |
| notion | openai/gpt-5.5 | 95.0 [86.7, 100.0] | 100.0 [100.0, 100.0] | 95.0 [86.7, 100.0] |
| playwright | anthropic/claude-sonnet-5.5 | 100.0 [100.0, 100.0] | 100.0 [100.0, 100.0] | 100.0 [100.0, 100.0] |
| playwright | openai/gpt-5.5 | 98.3 [95.0, 100.0] | 100.0 [100.0, 100.0] | 98.3 [95.0, 100.0] |
| resend | anthropic/claude-sonnet-5.5 | 90.0 [75.0, 100.0] | 88.9 [72.2, 100.0] | 75.0 [55.0, 90.0] |
| resend | openai/gpt-5.5 | 83.3 [66.7, 96.7] | 88.9 [72.2, 100.0] | 68.3 [48.3, 86.7] |

## Calls, tokens, and failures

| Model | Scored calls | HTTP attempts | Reported input tokens | Reported output tokens |
|---|---:|---:|---:|---:|
| anthropic/claude-sonnet-5.5 | 510 | 518 | 10,178,547 | 48,834 |
| openai/gpt-5.5 | 510 | 510 | 4,069,290 | 30,888 |
| Total | 1,020 | 1,028 | 14,247,837 | 79,722 |

Usage was returned for all 1,020 scored responses: **14,327,559 tokens** in total. This is provider-reported usage, not a cost estimate; unsuccessful attempts may consume unreported usage, and gateway-internal retries are not observable. The two extra smoke calls used 4,474 input and 114 output tokens. The model-list GET is not a chat-completions call.

There were **zero terminal request errors** and eight additional retry attempts. First-try failures were retained, not rerun selectively or excluded:

| Model | First-try passes | Selection/no-call failures | Strict-schema failures | Semantic failures after valid schema |
|---|---:|---:|---:|---:|
| anthropic/claude-sonnet-5.5 | 477 | 18 | 12 | 3 |
| openai/gpt-5.5 | 450 | 42 | 12 | 6 |

Failure categories above are mutually exclusive, checking selection before schema before semantics. All 24 schema failures were correct selections of tools with known strict-AJV compilation limitations: six `issue_write` trials and six Resend trials per model. They are **not evidence of malformed model arguments**. Reports retain all nine catalog-tool compilation findings across Cloudflare, official GitHub, Notion, and Resend; the other findings did not cause schema failures in these particular selected calls. Catalogs and strict validation were not relaxed. See [RUNNER.md](RUNNER.md) for the underlying schema diagnostics.

## Verification and publication safety

- Build succeeded; all 83 tests passed; all 170 tasks passed leakage lint.
- Validated all 18 reports and 1,020 corresponding trace rows, their current suite hashes, unique task/trial pairs, and independently reproduced the seeded bootstrap metrics from trial outcomes.
- Scanned all 36 live result/trace files: zero exact credential matches and zero literal credential-prefix marker matches. The broader scan of 71 report, trace, generated-site, smoke, summary and log files also found zero exact credential matches. Its ten substring matches in HTML were only the ordinary wording “task-level,” not credentials.
- Built nine pages from 18 live runs **without** `--allow-mock-preview`. Generated `dist-site/` stays ignored and is reproducible from the committed live artifacts.
- Rendered and visually inspected the alphabetical identity-only index and the memory and official-GitHub report cards, with both requested models, six CI bars per report card, and no mock watermark. Screenshots are outside the repository under `/home/ubuntu/screens/live-*.png`.

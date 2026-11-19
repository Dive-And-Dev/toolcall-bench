# Methodology

## What this measures

This is a single-turn, manifest-based evaluation of tool selection and argument construction, not end-to-end MCP execution or SaaS reliability. Every provider receives the complete captured catalog, a neutral system instruction, and one intent prompt. Only its first tool call is scored; there is no repair, feedback, tool execution, or multi-turn search. Expected tools and assertions are withheld from live providers.

The committed catalogs are real `initialize` + `tools/list` snapshots. [SNAPSHOTS.md](SNAPSHOTS.md) records pinned versions, commands, authentication circumstances, and skips. Capturing a catalog is not proof that executing its tools works. Snapshot dates and hashes belong to the captured artifacts, not a claim of freshness or an independent audit. Native adapters have only offline HTTP-contract coverage until someone runs live evaluations with their own keys.

## Metrics

- **Tool selection accuracy:** first selected name is in the task's acceptable set. A missing call or provider error is a failure. Selection is N/A for generic executors and explicitly trivial for fetch's single-tool catalog.
- **Parameter compliance, conditional:** strict AJV + ajv-formats validity against the selected real schema, restricted to correct tool selections. First average eligible trials within each task, then average eligible task means. Tasks with zero correct selections have no conditional denominator and are omitted; all-empty is N/A. Semantic correctness is not part of this metric. Comparisons may have different eligible task populations; paired diffs use only their shared eligible tasks, so check denominators and unmatched counts.
- **End-to-end first-try pass:** correct selection AND schema-valid arguments AND all semantic assertions pass. Here “end-to-end” ends at the constructed call; the external tool is never executed.

Semantic assertions use JSON Pointers into arguments: equality, regex matching, offset-aware ISO-8601 date-time, existence, or membership. Assertions test selected aspects of intent, not full functional correctness. Schema compilation failures are surfaced explicitly and affected calls fail compliance rather than being silently dropped or repaired. Provider failures remain in denominators and raw final HTTP error bodies are retained in traces. Durations include retries; provider usage tokens are not currently collected.

## Uncertainty: cluster bootstrap, not Wilson

The sampling unit is a **task**, not each repeated trial. Repeats of the same prompt share difficulty and semantic constraints and should not be treated as independent Bernoulli observations. A Wilson interval over all correlated repeats would imply more independent evidence than was collected.

Compute the mean of per-task means. Resample whole tasks with replacement, retaining each task's trial cluster, for 5,000 seeded draws (default seed 42, mulberry32). Report percentile 2.5% and 97.5% endpoints, half-width, task/trial counts, draw count and seed. Intervals describe variability across this task set, not a universal population guarantee or within-task uncertainty. Homogeneous outcomes and tiny task sets can yield degenerate intervals. More repeats are not a substitute for more diverse tasks.

## Paired changes

Diffs require the same suite and identical task-definition hash. Match task IDs, calculate candidate-minus-baseline task mean differences, then resample those paired IDs. Report delta, percentile interval, unmatched task counts, and a two-sided bootstrap tail proportion (mass at/across zero opposite the observed delta, doubled and clipped at one). A CI wholly above zero is an improvement; wholly below zero is a regression; otherwise not significant. Lint and token changes are deterministic deltas, not model metrics. No multiple-comparison correction is applied; three metrics and repeated experiments increase false-discovery risk.

Report pages show marginal 95% intervals as visual error bars. Overlapping intervals carry the required conservative label **“not statistically distinguishable”**. This visual heuristic is not a hypothesis test: paired evidence can differ, including a significant paired change despite overlapping marginal intervals. Only the paired diff determines the harness regression verdict.

## Architectural context

Static catalogs, dynamically discovered toolsets, and generic executors are not interchangeable interfaces. Full-catalog o200k_base tokens count JSON-serialized names, descriptions and input schemas, not actual provider wire usage. Deferred loading or dynamic discovery may expose only a fraction of that catalog. Executor architectures move complexity into another language or request field. We do not measure that extra interaction here. The current committed suites are static catalogs; other architecture paths have synthetic test coverage only.

The site lists servers alphabetically without cross-server metric columns. It provides within-suite model comparisons and paired changes, never a cross-server ordering by performance or a composite score. Suite task sets and difficulty differ; comparing their raw percentages is not valid evidence of relative server quality.

## Blind intent prompts and leakage

Tasks are intent descriptions with synthetic identifiers, acceptable catalog names, assertions, rationale and everyday/edge/unit-ambiguity tags. “Blind” describes prompt content, not a claim of independent human or double-blind authorship. Task authors consulted the catalogs to choose valid answers and assertions. Prompts avoid catalog identifiers and contiguous split forms. Leakage lint checks **every** tool in a suite, case-insensitively, including exact/snake/camel/kebab/split forms. For single-token names, only backticks or a following `(` or `tool` count as identifier-looking leakage; ordinary English such as “fetch this page” remains legal. This heuristic does not detect semantic hints, paraphrases, fragmented identifiers or every Unicode variant.

## Known limitations and release policy

- Tasks are a small, authored convenience sample, not representative developer traffic. There are 20 per suite, except fetch's 10. Assertions can be incomplete or overly specific; acceptable aliases require review.
- Description Jaccard overlap is lexical triage. Shared boilerplate inflates it (especially Notion); different operations may legitimately overlap. Findings are not proof of confusing tools.
- Strict AJV rejects nine captured definitions: Cloudflare `worker_put`, official GitHub `issue_write`, Notion `API-post-page`, and six Resend tools. Union types, missing strict types and unknown formats are compatibility findings, not proof of model failure. See [RUNNER.md](RUNNER.md). The snapshots remain unchanged.
- Provider schema support, catalog/name limits, latency, price, model drift and nondeterminism can affect real runs. No live adapter compatibility or model-quality claim has been established by mock runs. Seeds control mocks/bootstrap, not live provider sampling.
- All evaluation is single-turn. Tools are never executed. Credentials, actual effects, discovery workflows, repair, retrieval, and output interpretation are outside scope. Trace files can contain sensitive prompt/provider material; review before sharing.
- Mock runs use golden assertions to synthesize arguments and test harness plumbing only. **Mock results must never be published as benchmark results.** Site generation rejects them by default. The explicit preview flag watermarks every page red; CI uploads only a clearly named preview artifact, never deploys it. No live benchmark results are committed.

For reproductions, record the commit, manifests/tasks hashes, snapshot provenance, provider/model identity, trial counts, timestamps, schema transformations, failures and bootstrap settings. Keep separate output directories for experiments. Do not substitute newer captures without disclosing them.

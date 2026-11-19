# Phase 2 real-suite analysis

Generated with `node dist/cli.js lint --all` over the nine committed manifests. No servers were contacted for analysis.

| Server | Tools | o200k_base tokens | Missing description | Untyped object | Ambiguous unit/format | Missing enum | Overlap pairs |
|---|---:|---:|---:|---:|---:|---:|---:|
| cloudflare | 89 | 6714 | 2 | 10 | 0 | 0 | 12 |
| fetch | 1 | 298 | 0 | 0 | 0 | 0 | 0 |
| filesystem | 16 | 2926 | 0 | 0 | 0 | 0 | 0 |
| github-official | 46 | 11132 | 0 | 0 | 0 | 1 | 2 |
| github | 26 | 3548 | 53 | 0 | 1 | 0 | 2 |
| memory | 9 | 1738 | 0 | 0 | 0 | 0 | 0 |
| notion | 24 | 17163 | 49 | 0 | 0 | 0 | 85 |
| playwright | 25 | 3940 | 0 | 0 | 0 | 0 | 0 |
| resend | 138 | 49076 | 0 | 0 | 0 | 0 | 58 |

## Hand checks and tuning

- Cloudflare `worker_put` migrations' `renamed_classes` items have `from` and `to` string properties with no descriptions: genuine missing-description findings. `ai_inference.input` has `type: object` without properties or additionalProperties guidance: genuine untyped-object finding.
- Archived GitHub `list_issues.since` is just `{ "type": "string" }`: its missing description and ambiguous format are genuine.
- Official GitHub `sub_issue_write.method` explicitly lists `add`, `remove`, and `reprioritize` in an "Options are:" bullet list without an enum: genuine missing-enum finding.
- Initial enum candidates such as Playwright's key examples (`ArrowLeft` or `a`), conditional checkbox values, GitHub branch examples, Resend email-address examples, and mutually exclusive filePath/content/url arguments are not finite domains. The rule now excludes examples, conditional prose, and argument-selection instructions; regression tests cover these distinctions.
- Cloudflare analytics since/until explicitly say "ISO string": no ambiguous-format finding after tuning. Notion search's timestamp is the *name* of a timestamp field, not a timestamp value; it is also excluded.
- Notion embeds unused shared definitions in many tool schemas. Only definitions reachable through local references are traversed, reducing missing-description findings from 523 to 49 without ignoring reachable nested parameters.
- Overlap remains a literal lexical Jaccard signal as requested. For example, Cloudflare list-worker/list-queue descriptions and official GitHub create/fork-repository descriptions share substantial wording while naming different operations or resources. These can be semantic false positives; the output is not a claim of redundant functionality. Notion's repeated error-response boilerplate also inflates its overlap count. The threshold remains the specified 0.6 rather than hand-tuning against particular servers.

Conservative exclusions and statistical conventions are documented in README.md. No claim is made that these heuristic lint rules detect every possible DX defect.

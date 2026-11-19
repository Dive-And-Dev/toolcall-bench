# Real MCP tools/list snapshots

Captured on 2026-11-19 using Node v22.23.5 (npm/npx 10.9.9). All manifests come from SDK initialize and tools/list requests; no tools/call requests were sent. npm versions were resolved with `npm view <package> version` before capture. Package versions are separate from the server's self-reported initialize version. GitHub official release v2.2.0 was resolved via the GitHub releases/latest redirect (the GitHub REST API was rate limited), then its Docker image was pulled and pinned by digest. Fetch version was resolved using Python distribution metadata through uvx 0.13.9.

Dummy-token successes were recaptured in a fresh Linux network namespace (`unshare -Urn`) with npm offline, proving tools/list works without SaaS network authentication. Packages must already be cached for offline recapture. The official GitHub capture uses Docker `--network none` without any token; a separate dummy-token attempt also returned 46 tools but is not the committed capture.

| Server | Package@version | Tools | Dummy token |
|---|---|---:|---|
| playwright | @playwright/mcp@0.0.86 | 25 | No |
| github | @modelcontextprotocol/server-github@2025.4.8 | 26 | No |
| github-official | ghcr.io/github/github-mcp-server@2.2.0 | 46 | No |
| resend | resend-mcp@2.29.0 | 138 | Yes: `RESEND_API_KEY=re_dummy` |
| cloudflare | @cloudflare/mcp-server-cloudflare@0.2.0 | 89 | Yes: `CLOUDFLARE_API_TOKEN=dummy` |
| notion | @notionhq/notion-mcp-server@2.6.1 | 24 | Yes: `NOTION_TOKEN=ntn_dummy` |
| filesystem | @modelcontextprotocol/server-filesystem@2.4.0 | 16 | No |
| memory | @modelcontextprotocol/server-memory@2.2.1 | 9 | No |
| fetch | mcp-server-fetch@2026.11.11 | 1 | No |

## Capture commands

Run `npm ci && npm run build` first (captures originally used `node --import tsx src/cli.ts`, equivalent to the compiled CLI below).

### playwright

```sh
node dist/cli.js snapshot --cmd 'npx -y @playwright/mcp@0.0.86' --out suites/playwright/manifest.json
```

### github

```sh
node dist/cli.js snapshot --cmd 'npx -y @modelcontextprotocol/server-github@2025.4.8' --out suites/github/manifest.json
```

### github-official

```sh
node dist/cli.js snapshot --cmd 'docker run --rm -i --network none ghcr.io/github/github-mcp-server@sha256:040c4e99810076035eb1d9beb4b4a96fcf589c43cefed6ff51a46a553eb4e174 stdio' --out suites/github-official/manifest.json
```

### resend

```sh
node dist/cli.js snapshot --cmd 'unshare -Urn npx --offline -y resend-mcp@2.29.0' --env RESEND_API_KEY=re_dummy --out suites/resend/manifest.json
```

### cloudflare

```sh
node dist/cli.js snapshot --cmd 'unshare -Urn npx --offline -y @cloudflare/mcp-server-cloudflare@0.2.0 run dummy' --env CLOUDFLARE_API_TOKEN=dummy --out suites/cloudflare/manifest.json
```

### notion

```sh
node dist/cli.js snapshot --cmd 'unshare -Urn npx --offline -y @notionhq/notion-mcp-server@2.6.1' --env NOTION_TOKEN=ntn_dummy --out suites/notion/manifest.json
```

### filesystem

```sh
node dist/cli.js snapshot --cmd 'npx -y @modelcontextprotocol/server-filesystem@2.4.0 /home/ubuntu/repos/toolcall-bench' --out suites/filesystem/manifest.json
```

### memory

```sh
node dist/cli.js snapshot --cmd 'npx -y @modelcontextprotocol/server-memory@2.2.1' --out suites/memory/manifest.json
```

### fetch

```sh
node dist/cli.js snapshot --cmd 'uvx --from mcp-server-fetch==2026.11.11 mcp-server-fetch' --out suites/fetch/manifest.json
```

## Skipped servers / failed attempts

| Server | Attempt | Exact result / reason |
|---|---|---|
| Stripe | `npx -y @stripe/mcp@0.3.4 --api-key=sk_test_dummy` | Package is a proxy to hosted Stripe. HTTP 401: `Unauthorized. See https://docs.stripe.com/mcp for usage instructions.`; `invalid_api_key`: `The supplied API key could not authenticate this request. Verify or replace the configured key.` SDK eventually reported `MCP error -32001: Request timed out`. No manifest retained. |
| Supabase | `npx -y @supabase/mcp-server-supabase@0.18.0 --access-token dummy` | Online returned 36 tools, but network-disabled retry `unshare -Urn npx --offline -y @supabase/mcp-server-supabase@0.18.0 --access-token dummy` failed: `MCP error -32603: fetch failed`. Cannot establish a SaaS-independent tools/list with a dummy credential, so the online manifest was deliberately discarded. |
| Sentry | Streamable HTTP `https://mcp.sentry.dev/mcp`, no auth | SDK: `Streamable HTTP error: Error POSTing to endpoint:` (empty body). Direct initialize diagnostic: HTTP 403, Cloudflare `Error 1010: Access denied`, `The site owner has blocked access based on your browser's signature.`, `browser_signature_banned`. No retries after this diagnostic. Not a verified 401. |
| Linear | Streamable HTTP `https://mcp.linear.app/mcp`, no auth | SDK: `Streamable HTTP error: Error POSTing to endpoint:` (empty body). Direct initialize diagnostic: HTTP 401, empty body. |
| PostHog | Streamable HTTP `https://mcp.posthog.com/mcp`, no auth | HTTP 401: `No token provided, please provide a valid API token. View the documentation for more information: https://posthog.com/docs/model-context-protocol` |

## Reproduction caveats

- The npm GitHub and Stripe packages print deprecation warnings; their versions are intentional targets of this benchmark.
- Latest filesystem@2.4.0 and memory@2.2.1 declare Node >=24 and npm printed `EBADENGINE` under Node 22.23.5. Their initialize/tools/list captures nevertheless succeeded; no tool execution or full compatibility is claimed. The environment was checked: nvm Node 22 was loaded correctly. Use Node 24 for those servers separately if evaluating execution compatibility.
- Harness runtime targets Node >=20. Development tests use Vitest 5 (Node >=22.12) to avoid known vulnerabilities in older Vitest/tinypool releases; use the installed Node 22 LTS for development.
- Snapshots describe the default startup catalog and are not a promise of all optional feature/toolset combinations. `architecture_type` describes the captured configuration.
- Capture commands may execute arbitrary local shell code: use only trusted commands. Do not put real credentials into committed configs or shell examples.

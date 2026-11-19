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

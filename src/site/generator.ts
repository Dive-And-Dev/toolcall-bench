import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EvalReport } from '../types.js';

const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const plural = (count: number, noun: string) => count === 1 ? noun : `${noun}s`;
const Diff = z.object({ server_name: z.string(), baseline: z.object({ driver: z.string(), model: z.string() }), candidate: z.object({ driver: z.string(), model: z.string() }), metrics: z.record(z.string(), z.object({ delta: z.number(), ci_low: z.number(), ci_high: z.number(), verdict: z.string() }).passthrough().nullable()), token_delta: z.number(), lint_delta: z.number() }).passthrough();
type Comparison = z.infer<typeof Diff>;
type Run = { report: EvalReport; traces: Record<string, unknown>[]; jsonl: string; label: string; download: string };
const css = `:root{color-scheme:light;font:16px/1.55 system-ui,sans-serif;color:#192c3b;background:#eff3f6}*{box-sizing:border-box}body{max-width:1140px;margin:auto;padding:32px 24px 70px}a{color:#075a87}h1{font-size:2.7rem;line-height:1.15;letter-spacing:-.04em}h2{margin-top:0;font-size:1.5rem}h3{margin-bottom:8px}header{margin:28px 0}small,.muted{color:#4d6273}.eyebrow{font-size:.78rem;letter-spacing:.15em;text-transform:uppercase;color:#31566e;font-weight:750}.panel,article{background:white;border:1px solid #ccd9e2;border-radius:14px;padding:26px;margin:20px 0;box-shadow:0 3px 12px #16364b06}.badge{display:inline-block;border-radius:20px;background:#e5f1f6;color:#194b63;padding:4px 12px;font-size:.8rem;font-weight:650}.mock{background:#a80e24;color:white;padding:17px;border:4px solid #78071b;border-radius:8px;font-size:1.15rem;font-weight:850;text-align:center;position:sticky;top:0;z-index:5}table{border-collapse:collapse;width:100%;font-size:.88rem}th,td{text-align:left;vertical-align:top;padding:12px 10px;border-bottom:1px solid #dce4ea}th{color:#435e70}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 ui-monospace,monospace;background:#f2f6f8;padding:16px;border-radius:8px}details{border-top:1px solid #dce4ea;padding:12px 0}summary{cursor:pointer;font-weight:650}dl{display:grid;grid-template-columns:170px 1fr;gap:8px 20px;font-size:.9rem}dt{color:#4d6273}dd{margin:0;overflow-wrap:anywhere}.scroll{overflow:auto}.interval{position:relative;width:210px;height:22px;background:linear-gradient(to right,#edf2f5,#dfeaf0);border-radius:5px;margin:8px 0}.range{position:absolute;top:10px;height:3px;background:#087e8b}.range:before,.range:after{content:'';position:absolute;top:-4px;width:2px;height:11px;background:#087e8b}.range:after{right:0}.point{position:absolute;top:6px;width:11px;height:11px;background:#134b69;transform:translateX(-50%) rotate(45deg)}.note{border-left:3px solid #27859b;padding:8px 14px;background:#edf7fa}.catalog-name{font-weight:750;font-size:1.1rem}footer{margin-top:35px;color:#4d6273;font-size:.85rem}@media(max-width:650px){body{padding:18px 12px}h1{font-size:2rem}.panel,article{padding:17px}dl{grid-template-columns:1fr;gap:3px}dd{margin-bottom:9px}.mock{font-size:.9rem}.interval{width:160px}}`;
function page(title: string, body: string, mock: boolean) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · toolcall-bench</title><style>${css}</style></head><body>${mock ? '<div class="mock" role="alert">MOCK DATA — NOT A BENCHMARK RESULT</div>' : ''}${body}<footer>toolcall-bench · Within-suite evidence, with task-level uncertainty. No MCP operations were executed.</footer></body></html>`;
}
function provenance(report: EvalReport) {
  const meta = report.snapshot.snapshot_meta;
  const digest = meta.capture_cmd.match(/sha256:[a-f0-9]{64}/i)?.[0];
  return `<dl><dt>Package</dt><dd>${escape(meta.package)}@${escape(meta.package_version)}</dd><dt>Git SHA / digest</dt><dd>${escape(meta.git_sha ?? digest ?? 'Not recorded')}</dd><dt>Captured at</dt><dd>${escape(meta.captured_at)}</dd><dt>Capture method</dt><dd>${escape(meta.capture_method)}</dd><dt>Manifest SHA-256</dt><dd>${escape(report.manifest_sha256)}</dd><dt>Tasks SHA-256</dt><dd>${escape(report.tasks_sha256)}</dd></dl>`;
}
function interval(metric: NonNullable<EvalReport['metrics'][string]>) {
  const position = (n: number) => Math.max(0, Math.min(100, n * 100));
  return `<strong>${percent(metric.mean)}</strong> <span class="muted">[${percent(metric.ci_low)}, ${percent(metric.ci_high)}]</span><div class="interval" role="img" aria-label="Mean ${percent(metric.mean)}, 95% confidence interval ${percent(metric.ci_low)} to ${percent(metric.ci_high)}"><span class="range" style="left:${position(metric.ci_low)}%;width:${position(metric.ci_high - metric.ci_low)}%"></span><span class="point" style="left:${position(metric.mean)}%"></span></div><small>${metric.n_tasks} ${plural(metric.n_tasks, 'task')} · ${metric.n_trials} ${plural(metric.n_trials, 'trial')}</small>`;
}
function lint(report: EvalReport) {
  const findings = z.array(z.object({ tool: z.string(), rule: z.string(), path: z.string(), message: z.string() })).parse(report.lint.findings ?? []);
  const tools = [...new Set(findings.map(f => f.tool))].sort();
  return `<p>${report.lint.total_findings} ${plural(report.lint.total_findings, 'finding')}; deterministic diagnostics, not a quality verdict.</p>${tools.map(tool => `<details><summary>${escape(tool)} · ${findings.filter(f => f.tool === tool).length} ${plural(findings.filter(f => f.tool === tool).length, 'finding')}</summary><div class="scroll"><table><thead><tr><th>Rule</th><th>Path</th><th>Finding</th></tr></thead><tbody>${findings.filter(f => f.tool === tool).map(f => `<tr><td>${escape(f.rule)}</td><td>${escape(f.path)}</td><td>${escape(f.message)}</td></tr>`).join('')}</tbody></table></div></details>`).join('') || '<p>No lint findings.</p>'}`;
}
function card(name: string, runs: Run[], comparisons: Comparison[], mock: boolean) {
  const first = runs[0]!.report;
  const metrics = Object.keys(first.metrics);
  const overlaps = metrics.flatMap(metric => runs.flatMap((left, i) => runs.slice(i + 1).flatMap(right => {
    const a = left.report.metrics[metric], b = right.report.metrics[metric];
    if (left.report.tasks_sha256 !== right.report.tasks_sha256 || !a || !b || a.ci_low > b.ci_high || b.ci_low > a.ci_high) return [];
    return [`<li>${escape(left.label)} / ${escape(right.label)} — ${escape(metric)}: <strong>not statistically distinguishable</strong> (overlapping marginal 95% CIs).</li>`];
  })));
  return page(name, `<header><a href="index.html">← All servers</a><p class="eyebrow">Suite report</p><h1>${escape(name)}</h1><span class="badge">${escape(first.snapshot.architecture_type)}</span></header>
  <section class="panel"><h2>Snapshot provenance</h2>${provenance(first)}<p>Additional snapshots, if present, are identified with their individual runs below.</p></section>
  <section class="panel"><h2>Within-suite model comparisons</h2><p>Mean with 95% confidence interval (error bars on a 0–100% scale). Only identical task definitions are comparable. Selection is N/A for generic executors; single-tool selection is trivial.</p><div class="scroll"><table><thead><tr><th>Model / run</th>${metrics.map(m => `<th>${escape(m.replaceAll('_', ' '))}</th>`).join('')}</tr></thead><tbody>${runs.map(run => `<tr><td>${escape(run.label)}<br><small>${escape(run.report.selection_metric)}</small></td>${metrics.map(m => `<td>${run.report.metrics[m] ? interval(run.report.metrics[m]!) : 'N/A'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${overlaps.length ? `<ul>${overlaps.join('')}</ul>` : ''}<p class="note">Overlapping intervals are labelled “not statistically distinguishable” as a conservative visual cue, not a paired significance test. Use a paired diff below for inference; non-overlap alone is not the harness verdict.</p></section>
  ${runs.map(run => `<article><h2>${escape(run.label)}</h2><p class="muted">${escape(run.report.started_at)} · ${run.report.trials} ${plural(run.report.trials, 'trial')}/task · driver: ${escape(run.report.driver)}</p><details><summary>Run provenance</summary>${provenance(run.report)}</details><h3>Full-catalog schema tokens</h3><p><strong>${run.report.tokens.catalog_tokens.toLocaleString('en-US')}</strong> o200k_base ${plural(run.report.tokens.catalog_tokens, 'token')} · ${run.report.tokens.tool_count} ${plural(run.report.tokens.tool_count, 'tool')}</p><p class="note">Full-catalog estimate, not necessarily tokens actually sent by a client. Deferred loading, dynamic discovery, or executor architectures may expose only part of the catalog at a time; this number does not measure that workflow.</p><h3>Lint findings</h3>${lint(run.report)}${Object.keys(run.report.schema_compilation_errors).length ? `<h3>Strict schema compilation limitations</h3><pre>${escape(JSON.stringify(run.report.schema_compilation_errors, null, 2))}</pre>` : ''}<h3>Per-task trace inspector</h3><p><a href="${escape(run.download)}" download>Download JSONL traces</a> · Expand a task to inspect prompts, raw responses, calls, validation errors and assertions.</p>${run.traces.length ? [...new Set(run.traces.map(t => String(t.task_id)))].map(id => `<details><summary>${escape(id)}</summary>${run.traces.filter(t => String(t.task_id) === id).map(t => `<details><summary>Trial ${escape(t.trial)} · ${t.first_try_pass ? 'first-try pass' : 'first-try failure'}</summary><pre>${escape(JSON.stringify(t, null, 2))}</pre></details>`).join('')}</details>`).join('') : '<p>No trace rows available.</p>'}</article>`).join('')}
  <section class="panel"><h2>Baseline → candidate diffs</h2>${comparisons.length ? comparisons.map(diff => `<h3>${escape(diff.baseline.model)} → ${escape(diff.candidate.model)}</h3><div class="scroll"><table><thead><tr><th>Metric</th><th>Delta</th><th>Paired 95% CI</th><th>Verdict</th></tr></thead><tbody>${Object.entries(diff.metrics).map(([key, metric]) => `<tr><td>${escape(key)}</td><td>${metric ? percent(metric.delta) : 'N/A'}</td><td>${metric ? `[${percent(metric.ci_low)}, ${percent(metric.ci_high)}]` : 'N/A'}</td><td>${escape(metric?.verdict ?? 'not comparable')}</td></tr>`).join('')}</tbody></table></div><p>Token delta: ${diff.token_delta}; lint finding delta: ${diff.lint_delta}</p>`).join('') : '<p>No saved paired diff reports for this suite.</p>'}</section>`, mock);
}
async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(directory, entry.name)) : Promise.resolve([join(directory, entry.name)])))).flat().sort();
}
function guardPlaceholder(value: unknown) {
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'capture_status' && typeof child === 'string' && /placeholder/i.test(child)) throw new Error('Placeholder capture_status cannot be published');
      guardPlaceholder(child);
    }
  }
}
function hasMock(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && Object.entries(value).some(([key, child]) => key === 'driver' && child === 'mock' || hasMock(child)));
}
export async function buildSite(options: { results: string; out: string; allowMockPreview?: boolean; suites?: string }) {
  const input = resolve(options.results), out = resolve(options.out);
  if (input === out || out.startsWith(input + '/') || input.startsWith(out + '/')) throw new Error('Site output and results must be separate directories');
  for (const path of await files(options.suites ?? 'suites')) if (path.endsWith('config.json')) guardPlaceholder(JSON.parse(await readFile(path, 'utf8')));
  const groups = new Map<string, Run[]>(), comparisons: Comparison[] = [];
  let count = 0;
  for (const path of await files(input)) {
    if (!path.endsWith('.json')) continue;
    const data: unknown = JSON.parse(await readFile(path, 'utf8'));
    guardPlaceholder(data);
    if (hasMock(data) && !options.allowMockPreview) throw new Error('Mock results require --allow-mock-preview');
    if (data && typeof data === 'object' && 'baseline' in data) { comparisons.push(Diff.parse(data)); continue; }
    const report = EvalReport.parse(data);
    const jsonl = await readFile(path.replace(/\.json$/, '.traces.jsonl'), 'utf8');
    const traces = jsonl.split('\n').filter(line => line.trim()).map(line => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
    if (hasMock(traces) && !options.allowMockPreview) throw new Error('Mock results require --allow-mock-preview');
    const download = `traces-${count++}.jsonl`;
    const runs = groups.get(report.server_name) ?? [];
    runs.push({ report, traces, jsonl, download, label: `${report.model} · ${report.driver} · seed ${report.driver_options.seed ?? report.seed}` });
    groups.set(report.server_name, runs);
  }
  if (!groups.size) throw new Error('No evaluation reports found');
  for (const diff of comparisons) if (!groups.has(diff.server_name)) throw new Error(`Diff has no matching suite report: ${diff.server_name}`);
  const names = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  const filename = (name: string) => `suite-${createHash('sha256').update(name).digest('hex').slice(0, 16)}.html`;
  const mock = Boolean(options.allowMockPreview);
  await mkdir(out, { recursive: true });
  for (const file of await readdir(out)) if (/^(?:index\.html|suite-[a-f0-9]{16}\.html|traces-\d+\.jsonl)$/.test(file)) await rm(join(out, file));
  await writeFile(join(out, 'index.html'), page('Servers', `<header><p class="eyebrow">toolcall-bench / catalog evidence</p><h1>MCP tool-calling reports</h1><p>Browse snapshot provenance and within-suite model experiments. Servers are listed alphabetically; each suite has its own tasks and architectural context.</p></header><section class="panel"><h2>Captured servers</h2><div class="scroll"><table><thead><tr><th>Server</th><th>Architecture</th><th>Snapshot version / captured at</th></tr></thead><tbody>${names.map(name => { const report = groups.get(name)![0]!.report; return `<tr><td><a class="catalog-name" href="${filename(name)}">${escape(name)}</a></td><td><span class="badge">${escape(report.snapshot.architecture_type)}</span></td><td>${escape(report.snapshot.snapshot_meta.package_version)}<br><small>${escape(report.snapshot.snapshot_meta.captured_at)}</small>${groups.get(name)!.some(r => r.report.manifest_sha256 !== report.manifest_sha256) ? '<br><small>Multiple snapshots; see report</small>' : ''}</td></tr>`; }).join('')}</tbody></table></div></section>`, mock));
  for (const name of names) {
    const runs = groups.get(name)!;
    await writeFile(join(out, filename(name)), card(name, runs, comparisons.filter(d => d.server_name === name), mock));
    for (const run of runs) await writeFile(join(out, run.download), run.jsonl);
  }
  return { servers: names.length, runs: count, out };
}

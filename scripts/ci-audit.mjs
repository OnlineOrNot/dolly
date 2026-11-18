#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const excluded = new Set(["skipped", "cancelled"]);

export function percentile(values, fraction) {
  if (values.length === 0) return null;

  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
}

function distribution(values) {
  return { samples: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
}

function seconds(start, end) {
  if (!start || !end) return null;
  const a = Date.parse(start);
  const b = Date.parse(end);

  // GitHub uses year-one sentinel dates for steps that never ran.
  return a >= 0 && b >= a ? (b - a) / 1000 : null;
}

export function phase(name) {
  if (
    /^(Set up job|Complete job|Post )/.test(name) ||
    /^(Run )?(actions\/(checkout|setup-)|pnpm\/action-setup|oven-sh\/setup-bun|actions\/cache)/.test(
      name,
    ) ||
    /^(Run )?(pnpm|bun|npm|yarn) install(?: |$)/.test(name) ||
    /playwright install|^Start Chromium|^Stop Chromium|^Download .*artifact/i.test(name)
  ) {
    return "setup";
  }

  return "running";
}

export function measureJob(job, run) {
  const waiting = seconds(job.created_at, job.started_at);
  const dependencyDelay = seconds(run.created_at, job.created_at);

  const spans = (job.steps ?? [])
    .filter((step) => step.conclusion !== "skipped")
    .map((step) => ({ ...step, seconds: seconds(step.started_at, step.completed_at) }));

  // Jobs that never acquired a runner can still have start and end timestamps.
  const active =
    job.conclusion !== "skipped" && (job.runner_id > 0 || spans.length > 0)
      ? seconds(job.started_at, job.completed_at)
      : null;

  const measured = spans.every((step) => step.seconds !== null);
  const stepTotal = spans.reduce((total, step) => total + (step.seconds ?? 0), 0);

  const complete =
    job.status === "completed" &&
    !excluded.has(job.conclusion) &&
    active !== null &&
    spans.length > 0 &&
    measured &&
    stepTotal <= active;

  const running = complete
    ? spans.reduce((total, step) => total + (phase(step.name) === "running" ? step.seconds : 0), 0)
    : null;

  return {
    id: job.id,
    name: job.name,
    conclusion: job.conclusion,
    url: job.html_url,
    labels: job.labels ?? [],
    waiting: complete ? waiting : null,
    dependencyDelay: complete ? dependencyDelay : null,
    setup: complete ? active - running : null,
    running,
    active,
    complete,
    // Keep partial/cancelled time in compute totals, never in completed-job percentiles.
    billableMinutes: active === null ? null : Math.ceil(active / 60),
    steps: spans,
  };
}

export function summarize(capture) {
  const groups = new Map();

  const runs = capture.runs.map((run) => {
    const jobs = run.jobs.map((job) => {
      const measured = measureJob(job, run);
      const key = `${run.name} / ${job.name}`;

      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(measured);

      return measured;
    });

    const ends = run.jobs
      .filter((job) => job.conclusion !== "skipped")
      .map((job) => seconds(run.created_at, job.completed_at))
      .filter((value) => value !== null);

    return {
      id: run.id,
      event: run.event,
      conclusion: run.conclusion,
      attempt: run.run_attempt,
      headSha: run.head_sha,
      workflowPath: run.path,
      url: run.html_url,
      wall: run.status === "completed" && ends.length > 0 ? Math.max(...ends) : null,
      jobs,
    };
  });

  const jobs = runs.flatMap((run) => run.jobs);
  const computeJobs = jobs.filter((job) => job.conclusion !== "skipped");
  const measuredCompute = computeJobs.filter((job) => job.active !== null);

  return {
    repository: capture.repository,
    fetchedAt: capture.fetchedAt,
    requestedRuns: capture.requestedRuns,
    actualRuns: runs.length,
    window: {
      oldest: capture.runs.at(-1)?.created_at ?? null,
      newest: capture.runs[0]?.created_at ?? null,
    },
    conclusions: Object.fromEntries(
      [...new Set(runs.map((run) => run.conclusion))].map((conclusion) => [
        conclusion,
        runs.filter((run) => run.conclusion === conclusion).length,
      ]),
    ),
    groups: [...groups.entries()].map(([name, samples]) => ({
      name,
      total: samples.length,
      complete: samples.filter((job) => job.complete).length,
      phases: Object.fromEntries(
        ["dependencyDelay", "waiting", "setup", "running"].map((key) => [
          key,
          distribution(samples.map((job) => job[key]).filter((value) => value !== null)),
        ]),
      ),
    })),
    wall: Object.fromEntries(
      ["pull_request", "pull_request_target", "merge_group", "push"].map((event) => [
        event,
        distribution(
          runs
            .filter(
              (run) =>
                run.event === event &&
                run.conclusion === "success" &&
                run.wall !== null &&
                run.jobs.some((job) => job.complete),
            )
            .map((run) => run.wall),
        ),
      ]),
    ),
    observedRunnerMinutes: measuredCompute.length
      ? measuredCompute.reduce((total, job) => total + job.active, 0) / 60
      : null,
    roundedRunnerMinutes: measuredCompute.length
      ? measuredCompute.reduce((total, job) => total + job.billableMinutes, 0)
      : null,
    measuredComputeJobs: measuredCompute.length,
    unmeasuredComputeJobs: computeJobs.length - measuredCompute.length,
    unmeasuredJobs: jobs.filter((job) => !job.complete).length,
    rerunAttempts: runs.filter((run) => run.attempt > 1).length,
    runs,
  };
}

function pair(value) {
  return value.samples === 0 ? "N/A" : `${value.p50}s / ${value.p95}s (n=${value.samples})`;
}

export function markdown(report) {
  const computeCoverage = `${report.measuredComputeJobs} measured jobs, ${report.unmeasuredComputeJobs} unmeasured non-skipped jobs`;

  const computeStatus =
    report.measuredComputeJobs && report.unmeasuredComputeJobs ? "partial; " : "";

  return [
    `# CI audit: ${report.repository}`,
    "",
    `Fetched ${report.fetchedAt}. Requested ${report.requestedRuns} runs; found ${report.actualRuns}.`,
    `Window: ${report.window.oldest ?? "N/A"} to ${report.window.newest ?? "N/A"}.`,
    `Conclusions: ${JSON.stringify(report.conclusions)}.`,
    "",
    "## Job phases (nearest-rank p50 / p95)",
    "",
    "| Workflow / job | Completed samples / total | Dependency delay | Waiting | Setup + overhead | Running |",
    "| --- | ---: | --- | --- | --- | --- |",
    ...report.groups.map(
      (group) =>
        `| ${group.name.replaceAll("|", "\\|")} | ${group.complete} / ${group.total} | ${pair(group.phases.dependencyDelay)} | ${pair(group.phases.waiting)} | ${pair(group.phases.setup)} | ${pair(group.phases.running)} |`,
    ),
    "",
    "## Successful workflow wall time (created → last job completed)",
    "",
    ...Object.entries(report.wall).map(([event, value]) => `- ${event}: ${pair(value)}`),
    "",
    `Observed active runner minutes: ${report.observedRunnerMinutes?.toFixed(2) ?? "N/A"}; sum of per-job rounded minutes: ${report.roundedRunnerMinutes ?? "N/A"} (${computeStatus}${computeCoverage}).`,
    `Excluded from completed-job phase percentiles: ${report.unmeasuredJobs} jobs. Runs with attempt > 1: ${report.rerunAttempts}.`,
    "",
    "## Interpretation and limits",
    "",
    "- Zero runs means no baseline, not a passing or zero-second pipeline.",
    "- Waiting uses job.created_at → job.started_at. Dependency delay is run.created_at → job.created_at; neither is silently folded into test time.",
    "- Setup includes named checkout/runtime/install/cache/browser setup steps, post steps, and residual runner overhead. Running includes all other steps. Inline setup inside a test/build command cannot be separated by the API; inspect logs before attributing that time to tests.",
    "- Skipped, cancelled, unfinished, and invalid-timestamp jobs are retained in JSON but excluded from phase percentiles. Failed completed jobs are included and may represent truncated work; inspect individual conclusions in JSON. Wall percentiles above use successful workflows only, not a representative all-outcomes PR SLA.",
    "- Job names can span workflow revisions. Per-run SHA, workflow path, attempt, event, labels, conclusions, and step timings are retained; compare matched revisions before claiming an improvement.",
    "- Only the latest attempt of each run is fetched. Earlier attempts are not included in time/cost totals; reruns can increase actual spend. No requests or checks are retried by this auditor.",
    "- Compute totals use non-skipped jobs with runner or step evidence and valid start/end timestamps. Missing measurements make numeric totals partial; no measurements produce N/A.",
    "- Runner minutes are not an invoice. Rates, free allowances, cache/storage charges, previous attempts, and the account's bill are unknown. Cache hit rate is unavailable from job metadata alone.",
    "- No logs, artifacts, credentials, or environment variables are collected. The raw API capture supports re-analysis without re-fetching.",
    "",
  ].join("\n");
}

export async function collect(repository, limit, request) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Expected owner/repository");

  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("Run limit must be an integer from 1 to 1000");
  }

  const runs = [];

  for (let page = 1; runs.length < limit; page++) {
    const result = await request(`repos/${repository}/actions/runs?per_page=100&page=${page}`);
    runs.push(...result.workflow_runs.slice(0, limit - runs.length));

    if (result.workflow_runs.length < 100) break;
  }

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, runs.length) }, async () => {
      while (next < runs.length) {
        const run = runs[next++];
        run.jobs = [];

        for (let page = 1; ; page++) {
          const result = await request(
            `repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`,
          );

          run.jobs.push(...result.jobs);

          if (result.jobs.length < 100) break;
        }
      }
    }),
  );

  return { repository, requestedRuns: limit, fetchedAt: new Date().toISOString(), runs };
}

async function main(args) {
  const options = new Map();

  for (let index = 0; index < args.length; index += 2) {
    if (!["--repo", "--limit", "--output", "--input"].includes(args[index]) || !args[index + 1]) {
      throw new Error(
        "Usage: node scripts/ci-audit.mjs --repo owner/repo --output directory [--limit 150] [--input capture.json]",
      );
    }

    options.set(args[index], args[index + 1]);
  }

  if (!options.has("--output") || (!options.has("--repo") && !options.has("--input"))) {
    throw new Error("Provide --output and either --repo or --input");
  }

  const capture = options.has("--input")
    ? JSON.parse(await readFile(options.get("--input"), "utf8"))
    : await collect(options.get("--repo"), Number(options.get("--limit") ?? 150), async (path) => {
        const result = await exec("gh", ["api", path], { maxBuffer: 32 * 1024 * 1024 });

        return JSON.parse(result.stdout);
      });

  if (options.has("--repo") && options.get("--repo") !== capture.repository) {
    throw new Error("Capture repository does not match --repo");
  }

  const report = summarize(capture);
  const output = resolve(options.get("--output"));
  await mkdir(output, { recursive: true });

  for (const [name, contents] of [
    ["capture.json", JSON.stringify(capture, null, 2)],
    ["report.json", JSON.stringify(report, null, 2)],
    ["report.md", markdown(report)],
  ]) {
    await writeFile(resolve(output, name), `${contents}\n`);
  }

  console.log(markdown(report));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { collect, markdown, measureJob, percentile, phase, summarize } from "./ci-audit.mjs";

const time = (seconds) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();

const step = (name, start, end, conclusion = "success") => ({
  name,
  started_at: time(start),
  completed_at: end === null ? null : time(end),
  conclusion,
});

const job = (overrides = {}) => ({
  id: 10,
  name: "check",
  status: "completed",
  conclusion: "success",
  created_at: time(5),
  started_at: time(8),
  completed_at: time(48),
  steps: [
    step("Set up job", 9, 10),
    step("Run actions/checkout@v6", 10, 12),
    step("Run pnpm install --frozen-lockfile", 12, 20),
    step("Run pnpm test", 20, 45),
    step("Post Run actions/checkout@v6", 45, 46),
  ],
  ...overrides,
});

const run = (overrides = {}) => ({
  id: 1,
  name: "Check",
  status: "completed",
  conclusion: "success",
  created_at: time(0),
  event: "pull_request",
  run_attempt: 1,
  head_sha: "abc",
  path: ".github/workflows/check.yml",
  jobs: [job()],
  ...overrides,
});

const capture = (runs = [run()]) => ({
  repository: "example/repository",
  requestedRuns: 150,
  fetchedAt: time(100),
  runs,
});

test("nearest-rank percentiles never turn empty data into zero", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([9, 1, 2, 8], 0.5), 2);
  assert.equal(
    percentile(
      Array.from({ length: 100 }, (_, i) => i + 1),
      0.95,
    ),
    95,
  );
});

test("queue, dependency delay, setup/overhead and work partition elapsed time", () => {
  const result = measureJob(job(), run());
  assert.equal(result.dependencyDelay, 5);
  assert.equal(result.waiting, 3);
  assert.equal(result.setup, 15);
  assert.equal(result.running, 25);
  assert.equal(result.setup + result.running, result.active);
  assert.equal(result.billableMinutes, 1);
});

test("named setup is classified but hidden inline setup is not invented", () => {
  for (const name of [
    "Run actions/setup-node@v6",
    "Run pnpm/action-setup@v6",
    "Run oven-sh/setup-bun@v2",
    "Run actions/cache/restore@v4",
    "Run bun install --frozen-lockfile",
    "Run pnpm --dir web exec playwright install --with-deps chromium",
    "Start Chromium over CDP",
    "Post Run actions/setup-node@v6",
  ]) {
    assert.equal(phase(name), "setup", name);
  }

  for (const name of ["Run pnpm test", "Run suite", "Run pnpm run test:sandbox"]) {
    assert.equal(phase(name), "running", name);
  }
});

test("skipped steps with sentinel dates cannot become work samples", () => {
  const result = measureJob(
    job({
      steps: [
        ...job().steps,
        {
          name: "Run unused suite",
          conclusion: "skipped",
          started_at: "0001-01-01T00:00:00Z",
          completed_at: "0001-01-01T00:00:00Z",
        },
      ],
    }),
    run(),
  );

  assert.equal(result.complete, true);
  assert.equal(result.running, 25);
});

test("cancelled jobs retain consumed compute without shortening completed percentiles", () => {
  const report = summarize(
    capture([run(), run({ conclusion: "cancelled", jobs: [job({ conclusion: "cancelled" })] })]),
  );

  assert.equal(report.groups[0].phases.running.samples, 1);
  assert.equal(report.unmeasuredJobs, 1);
  assert.equal(report.roundedRunnerMinutes, 2);
  assert.equal(report.wall.pull_request.samples, 1);
  assert.equal(report.wall.pull_request.p50, 48);
});

test("failed jobs are visible and not misrepresented as successful wall-time samples", () => {
  const report = summarize(
    capture([run({ conclusion: "failure", jobs: [job({ conclusion: "failure" })] })]),
  );

  assert.equal(report.groups[0].phases.running.samples, 1);
  assert.equal(report.wall.pull_request.samples, 0);
  assert.equal(report.conclusions.failure, 1);
});

test("missing, backwards, overlapping and sentinel timestamps are not zero-duration successes", () => {
  for (const invalid of [
    job({ completed_at: null }),
    job({ completed_at: time(7) }),
    job({ completed_at: "0001-01-01T00:00:00Z" }),
    job({ steps: [step("Run suite", 8, null)] }),
    job({ steps: [step("Run suite", 8, 48), step("Run other", 8, 48)] }),
    job({ steps: [] }),
    job({ conclusion: "skipped", steps: [] }),
  ]) {
    const result = measureJob(invalid, run());
    assert.equal(result.complete, false);
    assert.equal(result.running, null);
    assert.equal(result.setup, null);
  }

  const missingQueue = measureJob(job({ created_at: null }), run());
  assert.equal(missingQueue.waiting, null);
  assert.equal(missingQueue.running, 25);
});

test("empty repositories and entirely skipped runs have no baseline", () => {
  for (const runs of [[], [run({ jobs: [job({ conclusion: "skipped", steps: [] })] })]]) {
    const report = summarize(capture(runs));
    assert.equal(report.wall.pull_request.p50, null);
    assert.match(markdown(report), /pull_request: N\/A/);
  }
});

test("different workflows stay separate and per-run revisions and attempts survive", () => {
  const report = summarize(capture([run(), run({ name: "Deploy", run_attempt: 2 })]));
  assert.equal(report.groups.length, 2);
  assert.equal(report.rerunAttempts, 1);
  assert.equal(report.runs[0].headSha, "abc");
  assert.equal(report.runs[0].workflowPath, ".github/workflows/check.yml");
});

test("collects exactly 150 runs, paginates every job and uses the latest attempt", async () => {
  const calls = [];

  const result = await collect("example/repository", 150, async (path) => {
    calls.push(path);

    if (path.includes("/actions/runs?")) {
      const offset = path.endsWith("page=1") ? 0 : 100;

      return {
        workflow_runs: Array.from({ length: 100 }, (_, index) =>
          run({ id: offset + index, run_attempt: 2 }),
        ),
      };
    }

    return { jobs: path.endsWith("page=1") ? Array.from({ length: 100 }, () => job()) : [job()] };
  });

  assert.equal(result.runs.length, 150);
  assert.equal(result.runs.at(-1).id, 149);
  assert.ok(result.runs.every((item) => item.jobs.length === 101));
  assert.equal(calls.filter((path) => path.includes("/attempts/2/jobs")).length, 300);
});

test("empty repository does not query imaginary jobs", async () => {
  const calls = [];

  const result = await collect("example/repository", 150, async (path) => {
    calls.push(path);

    return { workflow_runs: [] };
  });

  assert.equal(result.runs.length, 0);
  assert.equal(calls.length, 1);
});

test("API errors fail the audit without retries or a partial green report", async () => {
  let calls = 0;
  await assert.rejects(
    collect("example/repository", 150, async () => {
      calls++;
      throw new Error("permission denied");
    }),
    /permission denied/,
  );
  assert.equal(calls, 1);

  for (const limit of [0, 1.5, 1001, NaN]) {
    await assert.rejects(
      collect("example/repository", limit, async () => ({})),
      /Run limit/,
    );
  }

  await assert.rejects(
    collect("not-a-repo", 150, async () => ({})),
    /owner\/repository/,
  );
});

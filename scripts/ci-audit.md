# Measuring CI before changing it

The audit uses GitHub's read-only Actions API through an already authenticated `gh` CLI. It defaults to the most recent 150 workflow runs. It does not dispatch, retry, cancel, or change workflows or repository settings.

```sh
node scripts/ci-audit.mjs --repo owner/repository --output /tmp/ci-audit
node --test scripts/ci-audit.test.mjs
```

The output directory contains:

- `capture.json`: raw workflow runs and all jobs from each run's latest attempt, including paginated results.
- `report.json`: per-job phase measurements, run metadata, distributions, and consumed runner time.
- `report.md`: a human-readable summary, sample counts, and interpretation limits.

Keep captures outside the checkout. They include repository and branch metadata, but no logs, artifacts, credentials, or environment variables. Share them only through a channel appropriate for the repository's visibility.

An API or permission error fails the command, rather than emitting a partial report. A repository with no runs produces an explicit empty report, not a measured zero-second baseline. Cancelled and skipped jobs remain visible in the capture and totals; they cannot improve completed-job timing percentiles.

## Reproduce a report

```sh
node scripts/ci-audit.mjs --input /tmp/ci-audit/capture.json --output /tmp/ci-audit-replay
```

`--limit` accepts 1–1000 runs. `--repo` with `--input` checks the capture's repository identity. All percentiles use nearest rank and include their sample count.

## Read the buckets correctly

- **Dependency delay:** workflow creation to job creation. This may include scheduler delay, concurrency, or dependencies; it is not necessarily runner-queue time.
- **Waiting:** job creation to runner start. Missing job creation timestamps produce N/A, not a fallback to workflow creation.
- **Setup + overhead:** checkout, runtime and package-manager setup, dependency installation, browser installation/start/stop, cache actions, post steps, and residual job overhead.
- **Running:** all remaining step durations, including check, test, and build commands.

These buckets use API step boundaries. If a test command also installs Docker, builds an image, launches a database, or starts the application, the API cannot separate those operations. Inspect the logs and introduce explicit workflow step boundaries before claiming that bucket is test execution. Millisecond budgets also need finer instrumentation than the API's second-resolution timestamps.

Compare matching workflow revisions, runner labels, event types, outcomes, and cache warmth. Failed checks can end early. An aggregate success check may take only seconds because it waits on other jobs, not because validation became free. Successful-workflow wall time excludes failed, cancelled, skipped, and unexecuted runs and is not an all-outcomes PR SLA. The capture retains individual conclusions and revisions to make these distinctions inspectable.

Earlier rerun attempts are not fetched. The report flags runs with multiple attempts, and its compute total is a lower bound if reruns occurred. Rounded runner-minutes are a billing input, not a dollar cost: rates, allowances, cache/storage charges, and the account's invoice must be supplied separately. Cache hit rates require separate evidence from logs or explicit workflow outputs.

## Optimization order

1. Establish an executing baseline and enforce a full-suite merge-queue gate before adding PR selection.
2. Separate waiting and setup from workload; change the largest measured bucket first.
3. Compare old and replacement tools on the same revision, including deliberately broken fixtures; record missed checks before switching.
4. Measure real cold and warm CI runs after each isolated change. Report failures and missing evidence, not just successful samples.
5. Never use retries, skipped tests, or broader timeouts to meet a latency target.

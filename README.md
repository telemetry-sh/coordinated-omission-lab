# Coordinated Omission Lab

[![CI](https://github.com/telemetry-sh/coordinated-omission-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/telemetry-sh/coordinated-omission-lab/actions/workflows/ci.yml)

Your load test got faster. It stopped sending traffic.

Coordinated Omission Lab is a deterministic, interactive simulator that sends
the same intended load through closed-loop and open-loop generators. It shows
how a benchmark can report flattering percentiles simply because slow responses
prevented virtual users from issuing the next request.

## The interesting part

A latency histogram only describes requests that existed.

In a closed-loop load test, each virtual user waits for a response before
sending again. During a slowdown, fewer clients become available, offered load
drops, and the generator omits the pressure that would have deepened the queue.
Production traffic often behaves more like scheduled open-loop arrivals.

Included scenarios:

- a stop-the-world pause;
- a sustained downstream brownout;
- worker-pool saturation; and
- a healthy control.

The lab compares measured and interval-corrected p99, observed versus intended
RPS, SLO violations, latency distributions, and the requests that were never
sent.

## Run the interactive lab

Node.js 22.13 or newer is required.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## What the simulator models

- deterministic request latency jitter;
- a finite shared worker pool;
- scheduled incidents with configurable slowdown;
- closed-loop clients with think time;
- open-loop fixed-rate arrivals;
- queue delay and responses completing beyond the test window; and
- interval correction for omitted latency samples.

This is a teaching model, not a production capacity planner. It omits network
partitions, retries, autoscaling, warmup behavior, and request cancellation so
the coordinated-omission effect remains visible.

## Optional aggregate telemetry

The lab works locally without credentials. To record privacy-safe comparison
summaries with
[Telemetry](https://telemetry.sh/?utm_source=github&utm_medium=referral&utm_campaign=coordinated-omission-lab&utm_content=readme):

```bash
cp .env.example .env.local
# Set TELEMETRY_API_KEY, then restart the server.
```

Each comparison emits one aggregate row per load model to
`coordinated_omission_runs`. Events include the scenario, intended load,
worker count, model, observed load, p99, corrected p99, SLO violations, and
missing requests. Individual synthetic requests are never sent.

For real benchmark events, preserve the schedule next to each result:

```sql
SELECT
  load_model,
  quantile(0.99)(latency_ms) AS p99_ms,
  count() / 24 AS observed_rps,
  max(target_rps) AS intended_rps
FROM benchmark_requests
WHERE run_id = 'latest'
GROUP BY load_model
ORDER BY load_model
```

## Verify

```bash
npm run check
```

This runs the type checker, linter, deterministic simulation tests, rendered
HTML verification, and a production build.

## License

MIT

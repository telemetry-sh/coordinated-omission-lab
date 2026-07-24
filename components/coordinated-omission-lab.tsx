"use client";

import { useMemo, useState } from "react";
import {
  compareModels,
  MODEL_META,
  PRESETS,
  telemetryPayload,
  type SimulationConfig,
  type SimulationResult,
} from "../lib/simulation";

const QUERY = `SELECT
  load_model,
  quantile(0.99)(latency_ms) AS p99_ms,
  count() / 24 AS observed_rps,
  max(target_rps) AS intended_rps
FROM benchmark_requests
WHERE run_id = 'latest'
GROUP BY load_model
ORDER BY load_model`;

function number(value: number, digits = 0) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
  }).format(value);
}

function RangeControl({
  label,
  value,
  minimum,
  maximum,
  step,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  minimum: number;
  maximum: number;
  step: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="range">
      <span>
        {label}
        <strong>
          {number(value, step < 1 ? 1 : 0)}
          {suffix}
        </strong>
      </span>
      <input
        type="range"
        min={minimum}
        max={maximum}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function Metric({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "good" | "bad" | "warn";
}) {
  return (
    <div className={`metric ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function ResultCard({ result }: { result: SimulationResult }) {
  const meta = MODEL_META[result.model];
  const isClosed = result.model === "closed_loop";
  const maxHistogram = Math.max(
    1,
    ...result.histogram.map((bucket) => bucket.count)
  );

  return (
    <article className={`result-card ${isClosed ? "closed" : "open"}`}>
      <header>
        <span>{meta.eyebrow}</span>
        <h3>{meta.name}</h3>
        <p>{meta.description}</p>
      </header>
      <div className="metric-grid">
        <Metric
          label="measured p99"
          value={`${number(result.p99Ms)}ms`}
          detail={isClosed ? "looks reassuring" : "includes the queue"}
          tone={result.p99Ms > 500 ? "bad" : "good"}
        />
        <Metric
          label="observed load"
          value={`${number(result.observedRps, 1)} rps`}
          detail={`${number(result.offeredLoadPercent, 1)}% of intended`}
          tone={result.offeredLoadPercent < 90 ? "warn" : "good"}
        />
        <Metric
          label="SLO violations"
          value={`${number(result.sloViolationPercent, 1)}%`}
          detail="requests slower than 500ms"
          tone={result.sloViolationPercent > 5 ? "bad" : "good"}
        />
        <Metric
          label={isClosed ? "requests never sent" : "requests queued"}
          value={
            isClosed
              ? number(result.missingRequests)
              : number(
                  Math.max(0, result.issuedRequests - result.completedRequests)
                )
          }
          detail={
            isClosed ? "absent from the histogram" : "still visible as demand"
          }
          tone={isClosed && result.missingRequests > 0 ? "warn" : undefined}
        />
      </div>
      <div className="histogram" aria-label={`${meta.name} latency histogram`}>
        <div className="histogram-title">
          <span>latency distribution</span>
          <span>{number(result.issuedRequests)} samples</span>
        </div>
        <div className="histogram-bars">
          {result.histogram.map((bucket) => (
            <div className="histogram-column" key={bucket.label}>
              <div
                className="histogram-bar"
                style={{
                  height: `${Math.max(
                    2,
                    (bucket.count / maxHistogram) * 100
                  )}%`,
                }}
                title={`${bucket.label}: ${number(bucket.count)} requests`}
              />
              <span>{bucket.label}</span>
            </div>
          ))}
        </div>
      </div>
      {isClosed && (
        <div className="correction">
          <span>interval-corrected p99</span>
          <strong>{number(result.correctedP99Ms)}ms</strong>
          <small>
            Reconstructs the samples that waiting clients could not send.
          </small>
        </div>
      )}
    </article>
  );
}

function Timeline({
  results,
  config,
}: {
  results: readonly SimulationResult[];
  config: SimulationConfig;
}) {
  const closed = results[0];
  const open = results[1];
  const ceiling = Math.max(
    1,
    ...closed.timeBuckets.map((bucket) => bucket.p99Ms),
    ...open.timeBuckets.map((bucket) => bucket.p99Ms)
  );

  return (
    <div className="timeline">
      <div className="timeline-head">
        <div>
          <span className="section-index">02 / the missing interval</span>
          <h2>Same service. Different story.</h2>
        </div>
        <div className="legend">
          <span className="closed-key">closed-loop</span>
          <span className="open-key">open-loop</span>
        </div>
      </div>
      <div className="chart" aria-label="P99 latency by second">
        <div className="chart-scale">
          <span>{number(ceiling)}ms</span>
          <span>{number(ceiling / 2)}ms</span>
          <span>0</span>
        </div>
        <div className="chart-bars">
          {closed.timeBuckets.map((bucket, index) => {
            const openBucket = open.timeBuckets[index];
            const inIncident =
              bucket.second >= config.incidentStartSeconds &&
              bucket.second <
                config.incidentStartSeconds + config.incidentDurationSeconds;
            return (
              <div
                className={`second ${inIncident ? "incident" : ""}`}
                key={bucket.second}
                title={`second ${bucket.second}: closed ${number(
                  bucket.p99Ms
                )}ms, open ${number(openBucket.p99Ms)}ms`}
              >
                <i
                  className="closed-bar"
                  style={{
                    height: `${Math.max(
                      1,
                      (bucket.p99Ms / ceiling) * 100
                    )}%`,
                  }}
                />
                <i
                  className="open-bar"
                  style={{
                    height: `${Math.max(
                      1,
                      (openBucket.p99Ms / ceiling) * 100
                    )}%`,
                  }}
                />
                {bucket.second % 4 === 0 && <span>{bucket.second}s</span>}
              </div>
            );
          })}
        </div>
      </div>
      <p className="chart-note">
        The shaded interval is the slowdown. Closed-loop traffic backs off
        automatically; open-loop arrivals keep exposing the growing queue.
      </p>
    </div>
  );
}

export function CoordinatedOmissionLab() {
  const [config, setConfig] = useState<SimulationConfig>(
    PRESETS["Stop-the-world pause"]
  );
  const [recordState, setRecordState] = useState(
    "record aggregate comparison"
  );
  const results = useMemo(() => compareModels(config), [config]);
  const closed = results[0];
  const open = results[1];
  const p99Gap = Math.max(0, open.p99Ms - closed.p99Ms);

  function update<K extends keyof SimulationConfig>(
    key: K,
    value: SimulationConfig[K]
  ) {
    setConfig((current) => ({ ...current, preset: "Custom", [key]: value }));
  }

  async function recordComparison() {
    setRecordState("recording…");
    try {
      const response = await fetch("/api/telemetry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(telemetryPayload(config, results)),
      });
      if (!response.ok) throw new Error("request failed");
      setRecordState("comparison recorded");
    } catch {
      setRecordState("recording unavailable");
    }
    window.setTimeout(
      () => setRecordState("record aggregate comparison"),
      2_400
    );
  }

  return (
    <main className="shell">
      <nav className="nav">
        <div className="brand">
          <i aria-hidden="true" />
          telemetry.sh / field lab 09
        </div>
        <span>load-test truth detector</span>
        <a href="#telemetry">find the missing traffic ↓</a>
      </nav>

      <section className="hero">
        <div>
          <span className="kicker">coordinated omission lab</span>
          <h1>
            Your load test got faster. <em>It stopped sending traffic.</em>
          </h1>
        </div>
        <div className="hero-copy">
          Compare two generators against the same overloaded service. One
          waits. One keeps the appointment. Only one shows the queue your users
          actually create.
        </div>
      </section>

      <section className="lab" aria-label="Coordinated omission simulator">
        <aside className="controls">
          <span className="section-index">01 / shape the incident</span>
          <h2>Break the benchmark.</h2>
          <div className="presets">
            {Object.keys(PRESETS).map((name) => (
              <button
                type="button"
                key={name}
                className={config.preset === name ? "is-active" : ""}
                onClick={() => setConfig(PRESETS[name])}
              >
                {name}
              </button>
            ))}
          </div>
          <div className="control-grid">
            <RangeControl
              label="intended load"
              value={config.targetRps}
              minimum={60}
              maximum={360}
              step={5}
              suffix=" rps"
              onChange={(value) => update("targetRps", value)}
            />
            <RangeControl
              label="worker slots"
              value={config.workers}
              minimum={8}
              maximum={64}
              step={1}
              suffix=""
              onChange={(value) => update("workers", value)}
            />
            <RangeControl
              label="healthy latency"
              value={config.baseLatencyMs}
              minimum={30}
              maximum={180}
              step={2}
              suffix="ms"
              onChange={(value) => update("baseLatencyMs", value)}
            />
            <RangeControl
              label="slowdown"
              value={config.incidentMultiplier}
              minimum={1}
              maximum={10}
              step={0.1}
              suffix="×"
              onChange={(value) => update("incidentMultiplier", value)}
            />
          </div>
          <div className="system-strip">
            <div>
              <span>generator</span>
              <strong>{number(config.targetRps)} rps</strong>
            </div>
            <b>→</b>
            <div>
              <span>worker pool</span>
              <strong>{config.workers} slots</strong>
            </div>
            <b>→</b>
            <div>
              <span>dependency</span>
              <strong>{number(config.incidentMultiplier, 1)}× slow</strong>
            </div>
          </div>
        </aside>

        <div className="blindspot">
          <span>the blind spot</span>
          <strong>{number(closed.missingRequests)}</strong>
          <p>
            intended requests were never issued by the closed-loop test. Its
            measured p99 is <b>{number(p99Gap)}ms lower</b> because the worst
            demand vanished before it could become a sample.
          </p>
        </div>

        <Timeline results={results} config={config} />

        <div className="comparison">
          {results.map((result) => (
            <ResultCard result={result} key={result.model} />
          ))}
        </div>
      </section>

      <section className="lesson">
        <span className="section-index">03 / what production knows</span>
        <div>
          <h2>Latency without arrival rate is half an observation.</h2>
          <p>
            A response-time histogram only describes requests that existed.
            During a stall, a closed-loop generator coordinates with the
            slowdown: fewer clients become free, fewer requests are emitted,
            and the test omits the exact pressure that would deepen the queue.
          </p>
        </div>
        <div className="lesson-grid">
          <article>
            <span>01</span>
            <h3>Record intent</h3>
            <p>
              Track scheduled arrival rate beside accepted and completed
              throughput.
            </p>
          </article>
          <article>
            <span>02</span>
            <h3>Preserve timestamps</h3>
            <p>
              Store scheduled, start, and finish time—not only a final
              duration.
            </p>
          </article>
          <article>
            <span>03</span>
            <h3>Correct the histogram</h3>
            <p>
              Add interval-corrected percentiles or use an open-loop generator.
            </p>
          </article>
        </div>
      </section>

      <section className="telemetry-section" id="telemetry">
        <div className="telemetry-copy">
          <span className="section-index">04 / make the omission queryable</span>
          <h2>Observe the requests—and the schedule they came from.</h2>
          <p>
            Telemetry events can carry the intended arrival rate, load model,
            scheduled timestamp, queue delay, and response latency together.
            That makes a flattering percentile easy to challenge.
          </p>
          <button type="button" onClick={recordComparison}>
            {recordState}
          </button>
          <small>
            Works without credentials. With a server key, this sends two
            privacy-safe aggregate rows—never individual synthetic requests.
          </small>
        </div>
        <div className="query-card">
          <div>
            <span>telemetry.sh / query</span>
            <i>live-shaped evidence</i>
          </div>
          <pre>
            <code>{QUERY}</code>
          </pre>
          <div className="query-result">
            <span>closed_loop</span>
            <b>{number(closed.p99Ms)}ms</b>
            <em>{number(closed.observedRps, 1)} observed rps</em>
          </div>
          <div className="query-result">
            <span>open_loop</span>
            <b>{number(open.p99Ms)}ms</b>
            <em>{number(open.observedRps, 1)} intended rps</em>
          </div>
        </div>
      </section>

      <footer>
        <div>
          <strong>COORDINATED OMISSION LAB</strong>
          <span>A deterministic teaching model, not a capacity planner.</span>
        </div>
        <div>
          <a
            href="https://telemetry.sh/?utm_source=coordinated-omission-lab&utm_medium=referral&utm_campaign=field-lab"
            target="_blank"
            rel="noreferrer"
          >
            explore telemetry.sh ↗
          </a>
          <a
            href="https://github.com/telemetry-sh/coordinated-omission-lab"
            target="_blank"
            rel="noreferrer"
          >
            source ↗
          </a>
        </div>
      </footer>
    </main>
  );
}

export type LoadModel = "closed_loop" | "open_loop";

export type SimulationConfig = {
  preset: string;
  durationSeconds: number;
  targetRps: number;
  workers: number;
  baseLatencyMs: number;
  jitterPercent: number;
  thinkTimeMs: number;
  incidentStartSeconds: number;
  incidentDurationSeconds: number;
  incidentMultiplier: number;
  seed: number;
};

export type TimeBucket = {
  second: number;
  issued: number;
  completed: number;
  p99Ms: number;
};

export type HistogramBucket = {
  label: string;
  upperMs: number;
  count: number;
};

export type SimulationResult = {
  model: LoadModel;
  issuedRequests: number;
  completedRequests: number;
  observedRps: number;
  offeredLoadPercent: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  sloViolationPercent: number;
  missingRequests: number;
  correctedP99Ms: number;
  timeBuckets: TimeBucket[];
  histogram: HistogramBucket[];
};

export const MODEL_META: Record<
  LoadModel,
  { name: string; eyebrow: string; description: string }
> = {
  closed_loop: {
    name: "Closed-loop generator",
    eyebrow: "the flattering benchmark",
    description:
      "Each virtual user waits for a response before sending again. Slow responses silently reduce offered load.",
  },
  open_loop: {
    name: "Open-loop arrivals",
    eyebrow: "the production-shaped view",
    description:
      "Requests arrive on schedule whether the service is healthy or stalled, exposing queueing and tail latency.",
  },
};

export const PRESETS: Record<string, SimulationConfig> = {
  "Stop-the-world pause": {
    preset: "Stop-the-world pause",
    durationSeconds: 24,
    targetRps: 180,
    workers: 32,
    baseLatencyMs: 72,
    jitterPercent: 34,
    thinkTimeMs: 35,
    incidentStartSeconds: 8,
    incidentDurationSeconds: 1.4,
    incidentMultiplier: 7,
    seed: 17,
  },
  "Downstream brownout": {
    preset: "Downstream brownout",
    durationSeconds: 24,
    targetRps: 155,
    workers: 28,
    baseLatencyMs: 88,
    jitterPercent: 42,
    thinkTimeMs: 45,
    incidentStartSeconds: 7,
    incidentDurationSeconds: 7,
    incidentMultiplier: 3.8,
    seed: 31,
  },
  "Pool saturation": {
    preset: "Pool saturation",
    durationSeconds: 24,
    targetRps: 260,
    workers: 18,
    baseLatencyMs: 78,
    jitterPercent: 28,
    thinkTimeMs: 28,
    incidentStartSeconds: 5,
    incidentDurationSeconds: 13,
    incidentMultiplier: 2.5,
    seed: 43,
  },
  "Healthy baseline": {
    preset: "Healthy baseline",
    durationSeconds: 24,
    targetRps: 120,
    workers: 36,
    baseLatencyMs: 64,
    jitterPercent: 24,
    thinkTimeMs: 40,
    incidentStartSeconds: 9,
    incidentDurationSeconds: 2,
    incidentMultiplier: 1.15,
    seed: 59,
  },
};

const SLO_MS = 500;

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function percentile(values: number[], quantile: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1)
  );
  return sorted[index];
}

function serviceTime(
  config: SimulationConfig,
  random: () => number,
  startMs: number
) {
  const incidentStartMs = config.incidentStartSeconds * 1_000;
  const incidentEndMs =
    (config.incidentStartSeconds + config.incidentDurationSeconds) * 1_000;
  const inIncident = startMs >= incidentStartMs && startMs < incidentEndMs;
  const jitter =
    1 +
    ((random() * 2 - 1) * Math.max(0, config.jitterPercent)) / 100;
  const multiplier = inIncident ? config.incidentMultiplier : 1;
  return Math.max(1, config.baseLatencyMs * jitter * multiplier);
}

function histogram(values: number[]) {
  const boundaries = [100, 250, 500, 1_000, 2_000, 4_000, Infinity];
  const labels = [
    "<100ms",
    "100–250",
    "250–500",
    "0.5–1s",
    "1–2s",
    "2–4s",
    "4s+",
  ];
  const counts = boundaries.map(() => 0);
  for (const value of values) {
    const index = boundaries.findIndex((boundary) => value < boundary);
    counts[index < 0 ? counts.length - 1 : index] += 1;
  }
  return counts.map((count, index) => ({
    label: labels[index],
    upperMs: boundaries[index],
    count,
  }));
}

type Completion = {
  arrivalMs: number;
  finishMs: number;
  latencyMs: number;
};

function processRequest(
  arrivalMs: number,
  workers: number[],
  config: SimulationConfig,
  random: () => number
) {
  let workerIndex = 0;
  for (let index = 1; index < workers.length; index += 1) {
    if (workers[index] < workers[workerIndex]) workerIndex = index;
  }
  const startMs = Math.max(arrivalMs, workers[workerIndex]);
  const finishMs = startMs + serviceTime(config, random, startMs);
  workers[workerIndex] = finishMs;
  return {
    arrivalMs,
    finishMs,
    latencyMs: finishMs - arrivalMs,
  };
}

function generateOpenLoop(config: SimulationConfig) {
  const random = mulberry32(config.seed);
  const workers = Array.from({ length: config.workers }, () => 0);
  const completions: Completion[] = [];
  const intervalMs = 1_000 / config.targetRps;
  const durationMs = config.durationSeconds * 1_000;

  for (let arrivalMs = 0; arrivalMs < durationMs; arrivalMs += intervalMs) {
    completions.push(processRequest(arrivalMs, workers, config, random));
  }
  return completions;
}

function generateClosedLoop(config: SimulationConfig) {
  const random = mulberry32(config.seed);
  const workers = Array.from({ length: config.workers }, () => 0);
  const healthyCycleMs = config.baseLatencyMs + config.thinkTimeMs;
  const clientCount = Math.max(
    1,
    Math.ceil((config.targetRps * healthyCycleMs) / 1_000)
  );
  const clients = Array.from(
    { length: clientCount },
    (_, index) => (index / clientCount) * healthyCycleMs
  );
  const durationMs = config.durationSeconds * 1_000;
  const completions: Completion[] = [];

  while (true) {
    let clientIndex = 0;
    for (let index = 1; index < clients.length; index += 1) {
      if (clients[index] < clients[clientIndex]) clientIndex = index;
    }
    const arrivalMs = clients[clientIndex];
    if (arrivalMs >= durationMs) break;
    const completion = processRequest(arrivalMs, workers, config, random);
    completions.push(completion);
    clients[clientIndex] = completion.finishMs + config.thinkTimeMs;
  }
  return completions;
}

function correctedLatencies(values: number[], expectedIntervalMs: number) {
  const corrected: number[] = [];
  for (const latency of values) {
    corrected.push(latency);
    for (
      let missing = latency - expectedIntervalMs;
      missing > expectedIntervalMs;
      missing -= expectedIntervalMs
    ) {
      corrected.push(missing);
      if (corrected.length > 750_000) return corrected;
    }
  }
  return corrected;
}

function buckets(completions: Completion[], durationSeconds: number) {
  return Array.from({ length: durationSeconds }, (_, second) => {
    const startMs = second * 1_000;
    const endMs = startMs + 1_000;
    const issued = completions.filter(
      (item) => item.arrivalMs >= startMs && item.arrivalMs < endMs
    );
    const completed = completions.filter(
      (item) => item.finishMs >= startMs && item.finishMs < endMs
    );
    return {
      second,
      issued: issued.length,
      completed: completed.length,
      p99Ms: Math.round(
        percentile(
          issued.map((item) => item.latencyMs),
          0.99
        )
      ),
    };
  });
}

export function simulate(
  config: SimulationConfig,
  model: LoadModel
): SimulationResult {
  const completions =
    model === "open_loop"
      ? generateOpenLoop(config)
      : generateClosedLoop(config);
  const durationMs = config.durationSeconds * 1_000;
  const completedInWindow = completions.filter(
    (item) => item.finishMs < durationMs
  );
  const latencies = completions.map((item) => item.latencyMs);
  const corrected =
    model === "closed_loop"
      ? correctedLatencies(latencies, 1_000 / config.targetRps)
      : latencies;
  const targetRequests = Math.round(
    config.targetRps * config.durationSeconds
  );
  const issuedRequests = completions.length;
  const violationCount = latencies.filter((value) => value > SLO_MS).length;

  return {
    model,
    issuedRequests,
    completedRequests: completedInWindow.length,
    observedRps: issuedRequests / config.durationSeconds,
    offeredLoadPercent: Math.min(100, (issuedRequests / targetRequests) * 100),
    p50Ms: Math.round(percentile(latencies, 0.5)),
    p95Ms: Math.round(percentile(latencies, 0.95)),
    p99Ms: Math.round(percentile(latencies, 0.99)),
    maxMs: Math.round(Math.max(0, ...latencies)),
    sloViolationPercent:
      issuedRequests === 0 ? 0 : (violationCount / issuedRequests) * 100,
    missingRequests: Math.max(0, targetRequests - issuedRequests),
    correctedP99Ms: Math.max(
      Math.round(percentile(latencies, 0.99)),
      Math.round(percentile(corrected, 0.99))
    ),
    timeBuckets: buckets(completions, config.durationSeconds),
    histogram: histogram(latencies),
  };
}

export function compareModels(config: SimulationConfig) {
  return [
    simulate(config, "closed_loop"),
    simulate(config, "open_loop"),
  ] as const;
}

export function telemetryPayload(
  config: SimulationConfig,
  results: readonly SimulationResult[]
) {
  return {
    event: "comparison_run",
    preset: config.preset,
    target_rps: config.targetRps,
    workers: config.workers,
    incident_multiplier: config.incidentMultiplier,
    results: results.map((result) => ({
      model: result.model,
      issued_requests: result.issuedRequests,
      observed_rps: Number(result.observedRps.toFixed(1)),
      offered_load_percent: Number(result.offeredLoadPercent.toFixed(1)),
      p99_ms: result.p99Ms,
      corrected_p99_ms: result.correctedP99Ms,
      missing_requests: result.missingRequests,
      slo_violation_percent: Number(result.sloViolationPercent.toFixed(2)),
    })),
  };
}

import type { LoadModel } from "../../../lib/simulation";

const PRESETS = new Set([
  "Stop-the-world pause",
  "Downstream brownout",
  "Pool saturation",
  "Healthy baseline",
  "Custom",
]);
const MODELS = new Set<LoadModel>(["closed_loop", "open_loop"]);

type ResultPayload = {
  model: LoadModel;
  issued_requests: number;
  observed_rps: number;
  offered_load_percent: number;
  p99_ms: number;
  corrected_p99_ms: number;
  missing_requests: number;
  slo_violation_percent: number;
};

function finiteBetween(value: unknown, minimum: number, maximum: number) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function validResult(value: unknown): value is ResultPayload {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<ResultPayload>;
  return (
    MODELS.has(result.model as LoadModel) &&
    finiteBetween(result.issued_requests, 0, 1_000_000) &&
    finiteBetween(result.observed_rps, 0, 100_000) &&
    finiteBetween(result.offered_load_percent, 0, 100) &&
    finiteBetween(result.p99_ms, 0, 10_000_000) &&
    finiteBetween(result.corrected_p99_ms, 0, 10_000_000) &&
    finiteBetween(result.missing_requests, 0, 1_000_000) &&
    finiteBetween(result.slo_violation_percent, 0, 100)
  );
}

export async function POST(request: Request) {
  const apiKey = process.env.TELEMETRY_API_KEY;
  if (!apiKey) return new Response(null, { status: 204 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (
    body.event !== "comparison_run" ||
    !PRESETS.has(String(body.preset)) ||
    !finiteBetween(body.target_rps, 1, 100_000) ||
    !finiteBetween(body.workers, 1, 10_000) ||
    !finiteBetween(body.incident_multiplier, 1, 100) ||
    !Array.isArray(body.results) ||
    body.results.length !== 2 ||
    !body.results.every(validResult)
  ) {
    return Response.json({ error: "Invalid aggregate event" }, { status: 400 });
  }

  await Promise.all(
    body.results.map(async (result: ResultPayload) => {
      const response = await fetch("https://api.telemetry.sh/log", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: apiKey,
        },
        body: JSON.stringify({
          table: "coordinated_omission_runs",
          data: {
            event_name: "comparison_run",
            preset: body.preset,
            target_rps: body.target_rps,
            workers: body.workers,
            incident_multiplier: body.incident_multiplier,
            ...result,
          },
        }),
      });
      const responseBody = (await response
        .json()
        .catch(() => null)) as { status?: string; message?: string } | null;
      if (!response.ok || responseBody?.status === "error") {
        throw new Error(responseBody?.message ?? "Telemetry request failed");
      }
    })
  );

  return new Response(null, { status: 204 });
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  compareModels,
  PRESETS,
  simulate,
  telemetryPayload,
} from "../lib/simulation.ts";

test("simulation is deterministic", () => {
  const config = PRESETS["Stop-the-world pause"];
  assert.deepEqual(simulate(config, "open_loop"), simulate(config, "open_loop"));
});

test("open-loop preserves scheduled demand", () => {
  const config = PRESETS["Downstream brownout"];
  const result = simulate(config, "open_loop");
  const target = Math.round(config.targetRps * config.durationSeconds);
  assert.ok(Math.abs(result.issuedRequests - target) <= 1);
  assert.ok(result.offeredLoadPercent > 99.9);
  assert.equal(result.missingRequests, 0);
});

test("closed-loop omits demand during a slowdown", () => {
  const config = PRESETS["Stop-the-world pause"];
  const [closed, open] = compareModels(config);
  assert.ok(closed.missingRequests > 0);
  assert.ok(closed.observedRps < open.observedRps);
  assert.ok(closed.offeredLoadPercent < 100);
});

test("open-loop exposes a worse tail under saturation", () => {
  const [closed, open] = compareModels(PRESETS["Pool saturation"]);
  assert.ok(open.p99Ms > closed.p99Ms);
  assert.ok(open.sloViolationPercent > closed.sloViolationPercent);
});

test("interval correction never flatters the closed-loop p99", () => {
  const closed = simulate(
    PRESETS["Downstream brownout"],
    "closed_loop"
  );
  assert.ok(closed.correctedP99Ms >= closed.p99Ms);
});

test("aggregate telemetry contains both load models", () => {
  const config = PRESETS["Healthy baseline"];
  const payload = telemetryPayload(config, compareModels(config));
  assert.equal(payload.results.length, 2);
  assert.deepEqual(
    payload.results.map((result) => result.model),
    ["closed_loop", "open_loop"]
  );
});

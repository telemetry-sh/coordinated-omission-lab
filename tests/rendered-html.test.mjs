import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const files = await readdir("dist", { recursive: true });
const bundles = files.filter((file) => /\.(?:html|js)$/.test(file));
const output = (
  await Promise.all(
    bundles.map((file) => readFile(path.join("dist", file), "utf8"))
  )
).join("\n");

test("ships the finished lab, not starter content", () => {
  assert.match(output, /Coordinated Omission Lab/i);
  assert.match(output, /Your load test got faster/i);
  assert.match(output, /record aggregate comparison/i);
  assert.doesNotMatch(output, /Your site is taking shape/i);
  assert.doesNotMatch(output, /codex-preview/i);
});

test("includes discovery metadata and the social card", async () => {
  assert.match(output, /og\.png/);
  assert.match(output, /distorted latency percentiles/i);
  const image = await stat("dist/client/og.png");
  assert.ok(image.size > 20_000);
});

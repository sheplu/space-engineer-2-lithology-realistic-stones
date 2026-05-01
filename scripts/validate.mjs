#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const load = (p) => JSON.parse(readFileSync(resolve(repoRoot, p), "utf8"));

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats.default(ajv);

const envelopeSchema = load("schemas/envelope.schema.json");
const stoneSchema = load("schemas/resource-stone.schema.json");
const indexSchema = load("schemas/index.schema.json");

const validateEnvelope = ajv.compile(envelopeSchema);
const validateStone = ajv.compile(stoneSchema);
const validateIndex = ajv.compile(indexSchema);

const index = load("index.json");

const baseRepoPath =
  process.env.BASE_GAME_REPO ??
  resolve(repoRoot, "..", "space-engineer-2-base-game");
const baseRawPath = resolve(baseRepoPath, "data/raw-resources.json");

let baseResourceIds = null;
if (existsSync(baseRawPath)) {
  const baseRaw = JSON.parse(readFileSync(baseRawPath, "utf8"));
  baseResourceIds = new Set(baseRaw.resources.map((r) => r.id));
  console.log(
    `✓ loaded ${baseResourceIds.size} base-game resource ids from ${baseRawPath}`,
  );
} else {
  console.warn(
    `! base-game repo not found at ${baseRawPath} — skipping resourceId cross-check (set BASE_GAME_REPO to enable)`,
  );
}

let failures = 0;
const report = (label, errors) => {
  if (!errors || errors.length === 0) return;
  failures += errors.length;
  console.error(`✗ ${label}`);
  for (const err of errors) {
    console.error(`    ${err.instancePath || "(root)"} ${err.message}`);
    if (err.params && Object.keys(err.params).length) {
      console.error(`      params: ${JSON.stringify(err.params)}`);
    }
  }
};

const COMPOSITION_TOLERANCE = 1e-6;
const checkComposition = (rec, label) => {
  const sum = rec.composition.reduce((a, c) => a + c.percentage, 0);
  if (Math.abs(sum - 1) > COMPOSITION_TOLERANCE) {
    console.error(
      `✗ ${label} — composition sums to ${sum} (expected 1.0 ± ${COMPOSITION_TOLERANCE})`,
    );
    failures += 1;
  }
  if (baseResourceIds) {
    for (const { resourceId } of rec.composition) {
      if (!baseResourceIds.has(resourceId)) {
        console.error(
          `✗ ${label} — composition references unknown base-game resourceId "${resourceId}"`,
        );
        failures += 1;
      }
    }
  }
  const seen = new Set();
  for (const { resourceId } of rec.composition) {
    if (seen.has(resourceId)) {
      console.error(
        `✗ ${label} — composition lists "${resourceId}" more than once`,
      );
      failures += 1;
    }
    seen.add(resourceId);
  }
};

if (!validateIndex(index)) {
  report("index.json", validateIndex.errors);
} else {
  console.log("✓ index.json");
}

for (const entry of index.datasets) {
  const data = load(entry.path);
  const label = entry.path;

  if (!validateEnvelope(data)) {
    report(`${label} (envelope)`, validateEnvelope.errors);
    continue;
  }

  let recordFailures = 0;
  for (const [i, rec] of data.resources.entries()) {
    const recLabel = `${label} [${i}] stone record "${rec.id ?? "?"}"`;
    if (!validateStone(rec)) {
      recordFailures += validateStone.errors.length;
      report(recLabel, validateStone.errors);
      continue;
    }
    checkComposition(rec, recLabel);
  }
  if (data.resources.length !== entry.entryCount) {
    console.error(
      `✗ ${label} — index declares ${entry.entryCount} entries but file has ${data.resources.length}`,
    );
    failures += 1;
  }
  if (recordFailures === 0) {
    console.log(`✓ ${label} (${data.resources.length} stone records)`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} validation error(s)`);
  process.exit(1);
}
console.log("\nAll datasets valid.");

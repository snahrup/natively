#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");

const brainRoot = process.argv[2]
  || process.env.NATIVELY_BRAIN_ROOT
  || path.join(os.homedir(), "CascadeProjects", "ipcorp-architecture-brain");
const nativelyRoot = path.join(brainRoot, "natively");

const errors = [];
const warnings = [];
const stats = {
  prepPackets: 0,
  cortexInsights: 0,
  actionProposals: 0,
  workflowRuns: 0,
};

function main() {
  if (!fs.existsSync(nativelyRoot)) {
    fail(nativelyRoot, "Natively brain read-model directory does not exist.");
    report();
    process.exit(1);
  }

  readJsonIfPresent(path.join(nativelyRoot, "status.json"));
  readJsonIfPresent(path.join(nativelyRoot, "meeting-index.json"));
  validatePrepPackets(path.join(nativelyRoot, "prep-packets"));
  validateCortex(path.join(nativelyRoot, "cortex"));
  validateActionProposals(path.join(nativelyRoot, "action-proposals"));
  validateWorkflowRuns(path.join(nativelyRoot, "workflow-runs"));

  report();
  process.exit(errors.length ? 1 : 0);
}

function validatePrepPackets(dir) {
  for (const filePath of jsonFiles(dir)) {
    const packet = readJsonIfPresent(filePath);
    if (!packet) continue;
    stats.prepPackets += 1;
    requireString(packet, filePath, "id");
    requireString(packet, filePath, "title");
    requireString(packet, filePath, "summary");
    requireArray(packet, filePath, "currentState");
    requireArray(packet, filePath, "talkingPoints");
    requireArray(packet, filePath, "openQuestions");
    requireArray(packet, filePath, "evidenceRefs");
  }
}

function validateCortex(dir) {
  readJsonIfPresent(path.join(dir, "latest-run.json"));
  for (const filePath of jsonFiles(path.join(dir, "insights"))) {
    const insight = readJsonIfPresent(filePath);
    if (!insight) continue;
    stats.cortexInsights += 1;
    requireString(insight, filePath, "id");
    requireString(insight, filePath, "type");
    requireString(insight, filePath, "title");
    requireString(insight, filePath, "summary");
    requireString(insight, filePath, "createdAt");
    if (!isRecord(insight.reasoning)) {
      warn(filePath, "Cortex insight has no reasoning object. It will load, but it will not preserve Prism-style depth.");
    } else {
      for (const key of ["trigger", "observations", "connections", "chain", "alternativesConsidered", "confidenceFactors"]) {
        if (!(key in insight.reasoning)) {
          warn(filePath, `Cortex reasoning is missing ${key}.`);
        }
      }
    }
  }
}

function validateActionProposals(dir) {
  for (const filePath of jsonFiles(dir)) {
    const proposal = readJsonIfPresent(filePath);
    if (!proposal) continue;
    stats.actionProposals += 1;
    requireString(proposal, filePath, "id");
    requireString(proposal, filePath, "type");
    requireString(proposal, filePath, "title");
    requireStringAny(proposal, filePath, ["summary", "description", "body", "proposal.suggestedAction", "proposal.whyNow"]);
    requireString(proposal, filePath, "status");
    if (!isRecord(proposal.payload) && !isRecord(proposal.proposal)) {
      warn(filePath, "Action proposal has no payload. Natively can display it, but execution will be unavailable.");
    }
    if (!isRecord(proposal.approval) || proposal.approval.required !== true) {
      warn(filePath, "Action proposal should explicitly set approval.required=true.");
    }
  }
}

function validateWorkflowRuns(dir) {
  for (const filePath of jsonFiles(dir)) {
    const run = readJsonIfPresent(filePath);
    if (!run) continue;
    stats.workflowRuns += 1;
    requireString(run, filePath, "id");
    requireString(run, filePath, "proposalId");
    requireString(run, filePath, "proposalType");
    requireString(run, filePath, "state");
    requireArray(run, filePath, "events");
    if (!isRecord(run.approval)) fail(filePath, "Workflow run is missing approval object.");
    if (!isRecord(run.autonomy)) fail(filePath, "Workflow run is missing autonomy object.");
  }
}

function jsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((fileName) => fileName.toLowerCase().endsWith(".json"))
    .map((fileName) => path.join(dir, fileName));
}

function readJsonIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(filePath, `Invalid JSON: ${error.message}`);
    return null;
  }
}

function requireString(record, filePath, key) {
  if (typeof record[key] !== "string" || !record[key].trim()) {
    fail(filePath, `Missing required string field: ${key}`);
  }
}

function requireArray(record, filePath, key) {
  if (!Array.isArray(record[key])) {
    fail(filePath, `Missing required array field: ${key}`);
  }
}

function requireStringAny(record, filePath, keys) {
  for (const key of keys) {
    const value = getPath(record, key);
    if (typeof value === "string" && value.trim()) return;
  }
  fail(filePath, `Missing one required text field: ${keys.join(" or ")}`);
}

function getPath(record, keyPath) {
  return keyPath.split(".").reduce((value, key) => {
    if (!isRecord(value)) return undefined;
    return value[key];
  }, record);
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function fail(filePath, message) {
  errors.push({ filePath, message });
}

function warn(filePath, message) {
  warnings.push({ filePath, message });
}

function report() {
  console.log("Natively brain read-model validation");
  console.log(`Root: ${nativelyRoot}`);
  console.log(`Prep packets: ${stats.prepPackets}`);
  console.log(`Cortex insights: ${stats.cortexInsights}`);
  console.log(`Action proposals: ${stats.actionProposals}`);
  console.log(`Workflow runs: ${stats.workflowRuns}`);

  if (warnings.length) {
    console.log("");
    console.log(`Warnings (${warnings.length})`);
    for (const item of warnings) {
      console.log(`- ${path.relative(brainRoot, item.filePath)}: ${item.message}`);
    }
  }

  if (errors.length) {
    console.log("");
    console.log(`Errors (${errors.length})`);
    for (const item of errors) {
      console.log(`- ${path.relative(brainRoot, item.filePath)}: ${item.message}`);
    }
  } else {
    console.log("");
    console.log("Validation passed.");
  }
}

main();

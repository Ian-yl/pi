import fs from "node:fs";
import path from "node:path";

const startup = JSON.parse(fs.readFileSync("stages/backend/startup.json", "utf8"));
assert(startup.version === 1, "startup.version must be 1");
assert(Array.isArray(startup.install), "startup.install must be an array");
assert(Array.isArray(startup.build), "startup.build must be an array");
assert(typeof startup.start?.backend === "string", "start.backend missing");
assert(typeof startup.start?.frontend === "string", "start.frontend missing");
assert(typeof startup.start?.detached === "string", "start.detached missing");
assert(!/SEED_MODE=|VITE_API_MODE=/.test(startup.start.backend), "start.backend must not hard-code mode variables");
assert(!/SEED_MODE=|VITE_API_MODE=/.test(startup.start.detached), "start.detached must not hard-code mode variables");
assert(Number.isInteger(startup.port), "startup.port must be an integer");
assert(startup.healthCheck === `http://127.0.0.1:${startup.port}/`, "healthCheck must point to 127.0.0.1 port root");
assert(startup.env?.dotenv === true, "startup.env.dotenv must be true");
assert(startup.env?.apiModeVar === "VITE_API_MODE", "apiModeVar must be VITE_API_MODE");
assert(startup.env?.seedModeVar === "SEED_MODE", "seedModeVar must be SEED_MODE");

const manifest = JSON.parse(fs.readFileSync("stages/frontend/frontend-manifest.json", "utf8"));
assert(manifest.apiMode === "real", "frontend manifest apiMode must be real");

const contract = JSON.parse(fs.readFileSync("stages/frontend/api-contract.json", "utf8"));
const sourceText = collectSourceText(".");
const missing = contract.endpoints
  .map((endpoint) => endpoint.path)
  .filter((endpointPath) => !sourceText.includes(endpointPath));
assert(missing.length === 0, `contract paths missing from backend source: ${missing.join(", ")}`);

function collectSourceText(root) {
  let output = "";
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "web" || entry.name === "node_modules" || entry.name === "data") {
      continue;
    }
    const next = path.join(root, entry.name);
    if (entry.isDirectory()) {
      output += collectSourceText(next);
    } else if (/\.(js|mjs|json|md)$/.test(entry.name)) {
      output += fs.readFileSync(next, "utf8");
    }
  }
  return output;
}

function assert(condition, message) {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
}

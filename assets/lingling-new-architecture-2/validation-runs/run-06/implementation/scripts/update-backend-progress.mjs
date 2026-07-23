import fs from "node:fs";

const [, , state, message = ""] = process.argv;
if (!state || !["implementing", "testing", "repairing", "succeeded", "failed"].includes(state)) {
  console.error("usage: node scripts/update-backend-progress.mjs <state> <message>");
  process.exit(1);
}

const file = "implementation-progress.backend.json";
const units = ["pg-1r", "pg-1s", "pg-1t", "pg-1u", "pg-1v"];
const data = fs.existsSync(file)
  ? JSON.parse(fs.readFileSync(file, "utf8"))
  : { version: 1, units: {} };
data.version = 1;
data.units ||= {};
for (const unitId of units) {
  data.units[unitId] = { state, message };
}
const tmp = `${file}.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
fs.renameSync(tmp, file);

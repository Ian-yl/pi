import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const logPath = path.join(projectRoot, "agent.backend.runtime.log");
const pidPath = path.join(projectRoot, "agent.backend.runtime.pid");

const out = fs.openSync(logPath, "a");
const child = spawn(process.execPath, ["backend/server.js"], {
  cwd: projectRoot,
  detached: true,
  env: process.env,
  stdio: ["ignore", out, out],
});

fs.writeFileSync(pidPath, `${child.pid}\n`);
child.unref();
console.log(child.pid);

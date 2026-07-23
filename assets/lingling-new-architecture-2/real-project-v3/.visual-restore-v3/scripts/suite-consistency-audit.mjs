import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pngjs from 'pngjs';
import { evaluateSuiteConsistency } from './lib/suite-consistency.mjs';

const { PNG } = pngjs;

export async function runSuiteConsistencyAuditCli(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);
  const planPath = resolveRequiredPath(options.plan, '--plan');
  const runDir = resolveRequiredPath(options['run-dir'], '--run-dir');
  const outPath = resolveRequiredPath(options.out, '--out');
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const pageNames = (plan?.pages || []).map((page) => String(page?.name || page?.id || page)).filter(Boolean);
  const inventories = {};
  const pageImages = {};

  for (const page of pageNames) {
    const inventoryPath = evidencePath(runDir, page, ['visual-inventory.json', 'inventory.json']);
    const imagePath = evidencePath(runDir, page, ['actual.png', 'screenshot.png']);
    if (inventoryPath) inventories[page] = JSON.parse(readFileSync(inventoryPath, 'utf8'));
    if (imagePath) pageImages[page] = PNG.sync.read(readFileSync(imagePath));
  }

  const result = evaluateSuiteConsistency({ plan, inventories, pageImages, PNG });
  writeJsonAtomic(outPath, result);
  process.stdout.write(`suite consistency: ${result.pass ? 'PASS' : 'FAIL'} (${result.findings.length} findings) -> ${outPath}\n`);
  return result.pass ? 0 : 2;
}

function evidencePath(runDir, page, names) {
  for (const name of names) {
    const candidates = [
      join(runDir, page, name),
      join(runDir, 'pages', page, name),
      name.endsWith('.png') ? join(runDir, `${page}.png`) : null,
    ].filter(Boolean);
    const found = candidates.find(existsSync);
    if (found) return found;
  }
  return null;
}

function parseCliArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`unexpected argument: ${argument}`);
    const equal = argument.indexOf('=');
    if (equal >= 0) options[argument.slice(2, equal)] = argument.slice(equal + 1);
    else {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`missing value for ${argument}`);
      options[argument.slice(2)] = value;
    }
  }
  return options;
}

function resolveRequiredPath(value, option) {
  if (!value) throw new Error(`${option} is required`);
  return resolve(value);
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${path.split('/').pop()}.${process.pid}.${Date.now()}.tmp`);
  let descriptor = null;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

const isDirectMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectMain) {
  runSuiteConsistencyAuditCli()
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((error) => {
      process.stderr.write(`suite consistency audit failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}

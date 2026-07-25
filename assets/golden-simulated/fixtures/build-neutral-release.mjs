#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, 'visual-release'); const payload = `${root}/payload`;
rmSync(root, { recursive: true, force: true });
for (const path of ['evidence/payload/pages/submission', 'publication/pages/submission/assets']) mkdirSync(`${payload}/${path}`, { recursive: true });
const html = `<!doctype html><html><body><main data-vr-id="workspace"><img class="brand-icon" src="assets/icon.svg" alt=""><section data-vr-id="identity-section"><label>Submission title<input data-vr-id="title-input" required></label></section><section data-vr-id="options-section"><label>Submission category<select data-vr-id="category-select"><option>standard</option><option>priority</option></select></label><label>Result quantity<input data-vr-id="quantity-input" type="number" required value="2"></label></section><section data-vr-id="upload-panel"><input data-vr-id="upload-input" type="file"><img class="sample-result" src="assets/sample-result.svg" alt="Sample result"></section><button data-vr-id="submit-button">Create submission</button><button data-vr-id="planned-export">External submission review</button><section data-vr-id="result-panel">No submission result</section><section data-vr-id="history-panel">No submission history</section></main><script>async function submit(){return fetch('/api/submissions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:document.querySelector('[data-vr-id=title-input]').value,category:document.querySelector('[data-vr-id=category-select]').value,quantity:document.querySelector('[data-vr-id=quantity-input]').value})})}document.querySelector('[data-vr-id=submit-button]').addEventListener('click',submit);</script></body></html>\n`;
write(`${payload}/publication/pages/submission/index.html`, html);
write(`${payload}/publication/pages/submission/assets/icon.svg`, '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="7" fill="#333"/></svg>\n');
write(`${payload}/publication/pages/submission/assets/sample-result.svg`, '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#ccc"/><text x="8" y="24">sample</text></svg>\n');
writeJSON(`${payload}/publication/pages/submission/restore-plan.json`, { capture: { url: '/submission' } });
writeJSON(`${payload}/evidence/payload/pages/submission/visual-inventory.json`, { version: 3, name: 'submission', items: [
  item('workspace', 'main', 'main', 'body>main', 'Submission workspace'),
  item('identity-section', 'section', 'section', 'body>main>section:nth-of-type(1)', 'Identity section'),
  control('title-input', 'input', 'body>main>section:nth-of-type(1)>label>input', 'Submission title', { required: true }),
  item('options-section', 'section', 'section', 'body>main>section:nth-of-type(2)', 'Options section'),
  control('category-select', 'select', 'body>main>section:nth-of-type(2)>label:nth-of-type(1)>select', 'Submission category'),
  control('quantity-input', 'input', 'body>main>section:nth-of-type(2)>label:nth-of-type(2)>input', 'Result quantity', { required: true }),
  item('upload-panel', 'section', 'section', 'body>main>section:nth-of-type(3)', 'Upload source'),
  control('upload-input', 'input', 'body>main>section:nth-of-type(3)>input', 'Upload source file', { type: 'file', accept: 'text/plain' }),
  control('submit-button', 'button', 'body>main>button:nth-of-type(1)', 'Create submission'),
  control('planned-export', 'button', 'body>main>button:nth-of-type(2)', 'External submission review'),
  item('result-panel', 'container', 'section', 'body>main>section:nth-of-type(4)', 'No submission result'),
  item('history-panel', 'container', 'section', 'body>main>section:nth-of-type(5)', 'No submission history')
] });
const gateDigest = sha(Buffer.from('neutral-suite-gate')); const approvalDigest = sha(Buffer.from('neutral-approval'));
writeJSON(`${payload}/evidence/payload/page-results.json`, { submission: { ok: true, gate: { pass: true } } });
writeJSON(`${payload}/evidence/payload/suite-gate.json`, { pass: true, gateDigest });
writeJSON(`${payload}/approval.json`, { approvalDigest });
const files = walk(payload).map((file) => ({ path: file.slice(payload.length + 1), size: statSync(file).size, sha256: sha(readFileSync(file)) }));
const payloadManifest = { schemaVersion: '1.0', files }; const manifest = { schemaVersion: '1.0', suiteId: 'neutral-submission', gateDigest, approvalDigest, payloadManifestDigest: digest(payloadManifest), payloadManifest };
manifest.releaseDigest = digest(manifest); writeJSON(`${root}/release-manifest.json`, manifest);

function item(id, kind, tag, domPath, text) { return { id, auditId: id, kind, tag, selector: `[data-vr-id="${id}"]`, domPath, text, attrs: { dataVrId: id } }; }
function control(id, kind, domPath, text, attrs = {}) { return { ...item(id, kind, kind === 'button' ? 'button' : kind, domPath, text), placeholder: text, attrs: { dataVrId: id, ...attrs } }; }
function write(path, value) { writeFileSync(path, value); }
function writeJSON(path, value) { write(path, `${JSON.stringify(value, null, 2)}\n`); }
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
function digest(value) { return sha(Buffer.from(canonical(value))); }
function canonical(value) { if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`; }
function walk(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]).sort(); }

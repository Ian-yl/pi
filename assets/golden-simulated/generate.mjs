#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { completeBmad } from './fixtures/bmad-completion.mjs';

const piRoot = resolve(import.meta.dirname, '../..');
const fddRoot = resolve(process.env.FDD_HARNESS_ROOT || `${piRoot}/test-support/functional-domain-design`);
const fixtures = `${import.meta.dirname}/fixtures`;
const architecture = `${fixtures}/architecture`;
const release = `${fixtures}/visual-release`;
const output = resolve(option('--output') || `${import.meta.dirname}/current`);
const headlessOnly = process.argv.includes('--headless');
const functional = `${output}/functional-domain`;
const handoff = `${output}/implementation-handoff`;
const implementation = `${output}/implementation`;

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
  run(`${fddRoot}/scripts/scaffold-package.mjs`, ['--input', architecture, '--visual-release', release, '--output', functional, '--author-agent', 'golden-domain-author', '--designs', `${fixtures}/designs`]);
  overlayAuthoredClosure(functional);
  if (headlessOnly) convertToHeadlessPreservingContracts(functional);
  run(`${fddRoot}/scripts/review-package.mjs`, ['--package', functional, '--reviewer-agent', 'golden-domain-reviewer', '--prepare-semantic-review']);
  writeSemanticReview(functional, 'golden-domain-reviewer');
  run(`${fddRoot}/scripts/review-package.mjs`, ['--package', functional, '--reviewer-agent', 'golden-domain-reviewer']);
run(`${fddRoot}/scripts/build-implementation-handoff.mjs`, ['--functional', functional, '--visual-release', release, '--output', handoff, '--author-agent', 'golden-handoff-author']);
run(`${fddRoot}/scripts/review-implementation-handoff.mjs`, ['--handoff', handoff, '--reviewer-agent', 'golden-handoff-reviewer']);
run(`${piRoot}/scripts/prepare-implementation.mjs`, ['--functional', functional, '--handoff', handoff, '--output', implementation]);

const spec = readJSON(`${functional}/functional-spec.json`);
const capabilities = spec.capabilities || [];
const api = readJSON(`${implementation}/inputs/handoff-api-contract.json`);
const fieldPlan = readJSON(`${implementation}/field-binding-plan.json`);
const uiPlan = readJSON(`${implementation}/inputs/handoff-ui-implementation-plan.json`);
const uiByCapability = new Map((uiPlan.capabilities || []).map((item) => [item.capabilityId, item]));
const releaseControl = (capability) => uiByCapability.get(capability?.id)?.presentation?.triggerControl?.controlId;
const releaseControlByInput = new Map((uiPlan.capabilities || []).flatMap((item) => (item.presentation?.fieldBindings || []).map((binding) => [binding.inputId, binding.controlId])));
const submit = capabilities.find((item) => item.aggregateSubmission);
const upload = capabilities.find((item) => item.operations?.[0]?.resourceTransfer);
const planned = capabilities.find((item) => item.specificationStatus === 'planned');
if (!headlessOnly && (!submit || !upload || !planned)) throw new Error('neutral schema 2.3 authored fixture lacks aggregate, upload, or planned capabilities');

mkdirSync(`${implementation}/backend`, { recursive: true });
mkdirSync(`${implementation}/tests`, { recursive: true });
mkdirSync(`${implementation}/migrations`, { recursive: true });
if (!headlessOnly) writeFrontendImplementation();
writeBackendImplementation();
writeUnitEvidence();
writeFileSync(`${implementation}/migrations/001-submissions.sql`, 'CREATE TABLE resources (id TEXT PRIMARY KEY, checksum TEXT NOT NULL);\nCREATE TABLE submissions (id TEXT PRIMARY KEY, resource_ids TEXT NOT NULL, status TEXT NOT NULL);\n');
writeFileSync(`${implementation}/Dockerfile`, 'FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nCMD ["node", "backend/server.mjs"]\n');
writeJSON(`${implementation}/package.json`, { private: true, type: 'module', scripts: { test: 'node tests/unit.mjs', build: 'node -e "process.exit(0)"', start: 'node backend/server.mjs' } });
writeProvenance();
completeBmad(implementation);
if (!headlessOnly) writeFrontendContracts();
if (!headlessOnly) writeCampaignCandidate();

run(`${piRoot}/scripts/finalize-implementation.mjs`, ['--dir', implementation]);
run(`${piRoot}/scripts/verify-implementation.mjs`, [implementation, '--require-level', 'simulated']);
writeJSON(`${output}/summary.json`, { schemaVersion: '1.0', status: 'verified', verificationLevel: 'simulated', deliveryStatus: 'simulated-verified', deliveryStatusNote: 'Capabilities carrying an external providerContract require campaign-qualified integrated evidence before a completion declaration; simulated-verified is a prerequisite qualification.', functional: 'functional-domain', handoff: 'implementation-handoff', implementation: 'implementation' });
console.log(`Golden simulated flow generated: ${output}`);

function writeFrontendImplementation() {
  const submitOperation = submit.operations[0]; const uploadOperation = upload.operations[0];
  const submitBindings = fieldPlan.bindings.filter((item) => item.capabilityId === submit.id);
  const uploadBindings = fieldPlan.bindings.filter((item) => item.capabilityId === upload.id);
  const inputBindings = submitBindings.filter((item) => item.kind === 'input' && item.source === 'user-input');
  const uploadInput = uploadBindings.find((item) => item.kind === 'input');
  const submitCommand = submitBindings.find((item) => item.kind === 'command');
  const resultBinding = submitBindings.find((item) => item.kind === 'result');
  const uploadResultBinding = uploadBindings.find((item) => item.kind === 'result');
  const displayBindings = [...submitBindings, ...uploadBindings].filter((item) => item.kind === 'display');
  const uploadCommand = uploadBindings.find((item) => item.kind === 'command');
  const pagePath = `${implementation}/web/pages/submission/index.html`;
  mkdirSync(resolve(pagePath, '..'), { recursive: true });
  const uploadFieldSchema = uploadOperation.request?.bodySchema?.properties?.[uploadOperation.resourceTransfer.fileField] || {};
  const uploadMultiple = Number(uploadOperation.resourceTransfer.maxFiles ?? uploadOperation.resourceTransfer.constraints?.maxFiles ?? uploadFieldSchema.maxItems ?? 1) > 1;
  const controls = { submit: `control-${submit.id}`, upload: uploadInput.controlId, planned: `control-${planned.id}` };
  const vr = { submit: releaseControl(submit), upload: releaseControl(upload), planned: releaseControl(planned) };
  const html = `<!doctype html><html><body><main data-vr-id="workspace" data-clean-session="true" data-active-capability-id="${submit.id}" data-capability-status="implemented" data-surface-heading="${submit.name}" data-primary-action="${submit.name}" data-primary-operation-id="${submitOperation.id}" data-empty-state="${submit.presentation.surface.contentContract.emptyState}"><img src="/assets/icon.svg" alt="" width="16" height="16"><section data-vr-id="identity-section" data-region="identity-section">${inputBindings.slice(0, 1).map(inputHtml).join('')}</section><section data-vr-id="options-section" data-region="options-section">${inputBindings.slice(1).map(inputHtml).join('')}</section><section data-vr-id="upload-panel" data-region="upload-panel" data-upload-state="empty" data-result-region-id="${uploadResultBinding.regionId}" data-result-status="empty"><input id="${uploadInput.controlId}" data-vr-id="${vr.upload}" data-domain-input-id="files" type="file"><div id="upload-status" data-state="empty">No source file selected</div>${displayBindings.filter((item) => item.capabilityId === upload.id).map((item) => `<div data-display-host-id="${item.id}"></div>`).join('')}</section><button id="${controls.submit}" data-vr-id="${vr.submit}">${submit.name}</button><button id="${controls.planned}" data-vr-id="${vr.planned}">${planned.name}</button><section data-vr-id="result-panel" data-region="result-panel" data-result-region-id="${resultBinding.regionId}" data-result-status="empty"><span>${submit.presentation.surface.contentContract.emptyState}</span></section><section data-vr-id="history-panel" data-region="history-panel" data-history-state="empty">No submission history</section><section data-region="detail-panel" data-detail-region data-detail-for=""></section>${displayBindings.filter((item) => item.capabilityId === submit.id).map((item) => `<div data-display-host-id="${item.id}"></div>`).join('')}</main><script>const submitId=${JSON.stringify(submit.id)},uploadId=${JSON.stringify(upload.id)},plannedId=${JSON.stringify(planned.id)};let resourceIds=JSON.parse(localStorage.getItem('resourceIds')||'[]');const main=document.querySelector('main'),uploadStatus=document.querySelector('#upload-status'),result=document.querySelector('[data-result-region-id="${resultBinding.regionId}"]');function state(value){const marker=document.createElement('i');marker.dataset.state=value;marker.hidden=true;main.append(marker)}function renderDisplays(capabilityId,data){for(const binding of ${JSON.stringify(displayBindings)}){if(binding.capabilityId!==capabilityId)continue;const host=document.querySelector('[data-display-host-id="'+binding.id+'"]');const value=data[binding.responsePath];host.replaceChildren(...(Array.isArray(value)?value:[value]).map(item=>{const node=document.createElement('span');node.dataset.displayBindingId=binding.id;node.textContent=typeof item==='object'?JSON.stringify(item):String(item);return node}))}}document.querySelector('#${uploadInput.controlId}').addEventListener('change',async event=>{main.dataset.activeCapabilityId=uploadId;main.dataset.capabilityStatus='implemented';main.dataset.surfaceHeading='Upload source file';main.dataset.primaryAction='Upload source file';main.dataset.primaryOperationId=${JSON.stringify(uploadOperation.id)};main.dataset.emptyState='No source file selected';document.querySelectorAll('[data-domain-input-id]').forEach(node=>node.removeAttribute('data-domain-input-id'));event.target.dataset.domainInputId='files';state('empty');state('loading');uploadStatus.dataset.state='loading';const body=new FormData();body.append(${JSON.stringify(uploadOperation.resourceTransfer.fileField)},event.target.files[0]);const response=await fetch(${JSON.stringify(uploadOperation.path)}+(new URL(location.href).search.includes('uploadFailure=1')?'?fail=1':''),{method:'POST',body});const data=await response.json();if(!response.ok){state('failure');uploadStatus.dataset.state='failure';uploadStatus.parentElement.dataset.resultStatus='error';uploadStatus.innerHTML='<span data-result-error="true">'+data.error+'</span>';return}resourceIds=data.assetIds;localStorage.setItem('resourceIds',JSON.stringify(resourceIds));state('success');uploadStatus.dataset.state='success';uploadStatus.parentElement.dataset.resultStatus='success';uploadStatus.replaceChildren(...data.assetIds.map(value=>{const node=document.createElement('span');node.dataset.resultBindingId=${JSON.stringify(uploadResultBinding.id)};node.textContent=value;return node}));renderDisplays(uploadId,data)});document.querySelector('#${controls.submit}').addEventListener('click',async()=>{main.dataset.activeCapabilityId=submitId;main.dataset.capabilityStatus='implemented';main.dataset.surfaceHeading=${JSON.stringify(submit.name)};main.dataset.primaryAction=${JSON.stringify(submit.name)};main.dataset.primaryOperationId=${JSON.stringify(submitOperation.id)};main.dataset.emptyState=${JSON.stringify(submit.presentation.surface.contentContract.emptyState)};document.querySelector('#${uploadInput.controlId}').removeAttribute('data-domain-input-id');${inputBindings.map(item=>`document.querySelector('#${item.controlId}').dataset.domainInputId=${JSON.stringify(item.requestPath.replace(/^body\./, ''))};`).join('')}state('empty');state('loading');result.dataset.resultStatus='processing';result.textContent='Processing submission';const body={${inputBindings.map((item) => `${JSON.stringify(item.requestPath.replace(/^body\./, ''))}:document.querySelector('#${item.controlId}').value`).join(',')},${JSON.stringify(submitOperation.dataDependencies[0].targetField.replace(/^request\./, ''))}:resourceIds};const response=await fetch(${JSON.stringify(submitOperation.path)},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok){state('failure');result.dataset.resultStatus='error';result.innerHTML='<span data-result-error="true">'+data.error+'</span>';return}state('success');result.dataset.resultStatus='success';result.replaceChildren(...data.items.map(value=>{const node=document.createElement('span');node.dataset.resultRegionId=${JSON.stringify(resultBinding.regionId)};node.dataset.resultBindingId=${JSON.stringify(resultBinding.id)};node.textContent=value;return node}));renderDisplays(submitId,data);document.querySelector('[data-history-state]').dataset.historyState='populated';document.querySelector('[data-history-state]').textContent=data.submissionId;const detailRegion=document.querySelector('[data-detail-region]');Promise.all(data.items.map(value=>fetch(value))).then(()=>{detailRegion.dataset.thumbsLoaded=String(data.items.length)})});document.querySelector('#${controls.planned}').addEventListener('click',()=>{main.dataset.activeCapabilityId=plannedId;main.dataset.capabilityStatus='planned';main.removeAttribute('data-primary-action');main.removeAttribute('data-primary-operation-id');main.removeAttribute('data-empty-state');main.dataset.surfaceHeading=${JSON.stringify(planned.name)};main.innerHTML='<section data-planned-surface="true"><h1>${planned.name}</h1><p>功能待实现（暂未开放）</p><button id="${controls.planned}" data-vr-id="${vr.planned}">${planned.name}</button></section>'});</script></body></html>\n`;
  const implementedHtml = uploadMultiple ? html.replace('type="file"', 'type="file" multiple').replace(`body.append(${JSON.stringify(uploadOperation.resourceTransfer.fileField)},event.target.files[0])`, `for(const file of event.target.files)body.append(${JSON.stringify(uploadOperation.resourceTransfer.fileField)},file)`) : html;
  writeFileSync(pagePath, implementedHtml.replace(` data-domain-input-id="files" type="file" multiple`, ` type="file" multiple`).replace(` data-domain-input-id="files" type="file"`, ` type="file"`));
  const sampleAsset = `${implementation}/web/pages/submission/assets/sample-result.svg`;
  if (existsSync(sampleAsset)) rmSync(sampleAsset);
  writeBrowserTest({ controls, inputBindings, uploadInput, submitCommand, uploadCommand, resultBinding, uploadResultBinding, displayBindings, submitOperation, uploadOperation });
}

function writeSemanticReview(packageDir, reviewerAgentId) {
  const request = readJSON(`${packageDir}/semantic-review-request.json`);
  const spec = readJSON(`${packageDir}/functional-spec.json`);
  const capabilitiesByPage = new Map();
  for (const capability of spec.capabilities || []) {
    const pageId = capability.presentation?.targetPageId;
    if (!pageId) continue;
    if (!capabilitiesByPage.has(pageId)) capabilitiesByPage.set(pageId, []);
    capabilitiesByPage.get(pageId).push(capability.id);
  }
  writeJSON(`${packageDir}/semantic-review.json`, {
    schemaVersion: '1.0',
    reviewerAgentId,
    requestDigest: request.requestDigest,
    status: 'approved',
    pageReviews: request.pageIds.map((pageId) => ({
      pageId,
      verdict: 'approved',
      capabilityIds: (capabilitiesByPage.get(pageId) || []).sort(),
      controlIds: request.controlIds.filter((id) => id.startsWith(`${pageId}:`)).sort(),
      closureAssessment: 'The neutral fixture capabilities form distinct trigger-input-operation-result closures.',
      evidenceAssessment: 'The authored closure accounts for the locked architecture and frontend semantic evidence.'
    }))
  });
}

function writeBrowserTest(data) {
  const render = `elements => elements.map(element => { const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); return { visible: style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0, tag: element.tagName.toLowerCase(), text: element.textContent.trim(), src: element.currentSrc || element.src || null, href: element.href || null, value: 'value' in element ? element.value : null }; })`;
  const script = `import { createRequire } from 'node:module';import { mkdirSync,writeFileSync } from 'node:fs';const require=createRequire(${JSON.stringify(`${piRoot}/package.json`)});const {chromium}=require('playwright');const challenge=JSON.parse(process.env.FRONTEND_UPLOAD_CHALLENGES)[${JSON.stringify(data.uploadOperation.id)}];const browser=await chromium.launch({headless:true});const context=await browser.newContext();await context.tracing.start({screenshots:true,snapshots:true,sources:true});const page=await context.newPage();const cases=[];mkdirSync('evidence/frontend',{recursive:true});const capture=async(item,control)=>{const artifact='evidence/frontend/'+item.id+'.png';await page.screenshot({path:artifact,fullPage:true});await control.count();await control.isVisible();if(item.event!=='initial-state')await control.isEnabled();await page.content();item.artifacts=[artifact];item.status='passed';cases.push(item)};await page.goto(process.env.BASE_URL+'/submission');await page.waitForSelector('[data-clean-session="true"]');await capture({id:'initial-submission',capabilityId:'initial:submission',bindingId:'initial-submission',locator:'main',pageId:'submission',pageUrl:process.env.BASE_URL+'/submission',mode:'display-only',event:'initial-state'},page.locator('main'));await page.goto(process.env.BASE_URL+'/submission?uploadFailure=1');const upload=page.locator('#${data.uploadInput.controlId}');await upload.setInputFiles(challenge.path);await page.waitForSelector('[data-upload-state] [data-state="failure"]');await capture({id:'browser-upload-failure',capabilityId:${JSON.stringify(upload.id)},bindingId:'binding-${upload.id}',locator:${JSON.stringify(data.uploadInput.controlId)},pageUrl:process.env.BASE_URL+'/submission',mode:'reuse-control',event:'upload',expectedOutcome:'failure'},upload);await page.goto(process.env.BASE_URL+'/submission');const uploadSuccess=page.locator('#${data.uploadInput.controlId}');await uploadSuccess.setInputFiles(challenge.path);await page.waitForSelector('[data-upload-state][data-result-status="success"] [data-result-binding-id]');await page.locator('[data-result-binding-id="${data.uploadResultBinding.id}"]').evaluateAll(${render});await page.locator('[data-result-region-id="${data.uploadResultBinding.regionId}"]:not([data-result-binding-id])').evaluateAll(${render});${data.displayBindings.filter((item) => item.capabilityId === upload.id).map((item) => `await page.locator('[data-display-binding-id="${item.id}"]').evaluateAll(${render});`).join('')}await capture({id:'browser-upload',capabilityId:${JSON.stringify(upload.id)},bindingId:'binding-${upload.id}',locator:${JSON.stringify(data.uploadInput.controlId)},pageUrl:process.env.BASE_URL+'/submission',mode:'reuse-control',event:'upload'},uploadSuccess);await page.goto(process.env.BASE_URL+'/submission');${data.inputBindings.map((item, index) => `await page.locator('#${item.controlId}').fill(${JSON.stringify(index === 0 ? 'brand-icon' : index === 1 ? 'submit-button' : '2')});`).join('')}const submitFailure=page.locator('#${data.controls.submit}');await submitFailure.click();await page.waitForSelector('[data-result-status="error"] [data-result-error="true"]');await capture({id:'browser-submit-failure',capabilityId:${JSON.stringify(submit.id)},bindingId:'binding-${submit.id}',locator:${JSON.stringify(data.controls.submit)},pageUrl:process.env.BASE_URL+'/submission',mode:'reuse-control',event:'click',expectedOutcome:'failure'},submitFailure);await page.goto(process.env.BASE_URL+'/submission');${data.inputBindings.map((item, index) => `await page.locator('#${item.controlId}').fill(${JSON.stringify(index === 0 ? 'workspace' : index === 1 ? 'submit-button' : '3')});`).join('')}const submitSuccess=page.locator('#${data.controls.submit}');await submitSuccess.click();await page.waitForSelector('[data-result-status="success"] [data-result-binding-id]');${data.displayBindings.filter((item) => item.capabilityId === submit.id).map((item) => `await page.locator('[data-display-binding-id="${item.id}"]').evaluateAll(${render});`).join('')}await page.locator('[data-result-binding-id="${data.resultBinding.id}"]').evaluateAll(${render});await page.locator('[data-result-region-id="${data.resultBinding.regionId}"]:not([data-result-binding-id])').evaluateAll(${render});await page.waitForSelector('[data-detail-region][data-thumbs-loaded]',{state:'attached'});await capture({id:'browser-submit',capabilityId:${JSON.stringify(submit.id)},bindingId:'binding-${submit.id}',locator:${JSON.stringify(data.controls.submit)},pageUrl:process.env.BASE_URL+'/submission',mode:'reuse-control',event:'click'},submitSuccess);await page.goto(process.env.BASE_URL+'/submission');const planned=page.locator('#${data.controls.planned}');await planned.click();await page.waitForSelector('[data-planned-surface="true"]');await capture({id:'browser-planned',capabilityId:${JSON.stringify(planned.id)},bindingId:'binding-${planned.id}',locator:${JSON.stringify(data.controls.planned)},pageUrl:process.env.BASE_URL+'/submission',mode:'reuse-control',event:'click'},planned);const traceArtifact='evidence/frontend/playwright-trace.zip';await context.tracing.stop({path:traceArtifact});await browser.close();writeFileSync(process.env.FRONTEND_RAW_REPORT,JSON.stringify({schemaVersion:'1.0',engine:'playwright',traceArtifact,cases},null,2));\n`;
  writeFileSync(`${implementation}/tests/browser-runtime.mjs`, script);
}

function writeBackendImplementation() {
  const submitOperation = submit?.operations?.[0]; const uploadOperation = upload?.operations?.[0];
  const assetField = submitOperation?.dataDependencies?.[0]?.targetField?.replace(/^request\./, '') || 'resourceIds';
  const providerApiOperation = (api.operations || []).find((item) => item.providerContract?.outputMode === 'independent-items');
  const maxParallel = Number(providerApiOperation?.providerContract?.concurrency?.maxParallel) || 16;
  // The same backend serves both levels. With no EXTERNAL_OBSERVER_URL (simulated) it self-produces the
  // items exactly as before. With one injected (the campaign integrated level) it makes one real bounded
  // outbound provider call per requested item, forwards the required inputs so ingress and egress value
  // digests match, and returns each provider result as an item. Provider timeout/unavailable are exercised
  // against isolated local fault endpoints so they never touch the campaign's concurrency observer.
  const source = `import {createHash,randomUUID} from 'node:crypto';import {createServer} from 'node:http';import {readFileSync} from 'node:fs';const web=readFileSync(new URL('../web/pages/submission/index.html',import.meta.url));const icon=readFileSync(new URL('../web/pages/submission/assets/icon.svg',import.meta.url));const APP_PORT=Number(process.env.PORT||4173);const INTEGRATION_SINK='/__integration_sink';const INTEGRATION_UNAVAILABLE='/__integration_unavailable';const PROVIDER_MAX_PARALLEL=${maxParallel};const readBody=request=>new Promise(resolve=>{const chunks=[];request.on('data',chunk=>chunks.push(chunk));request.on('end',()=>resolve(Buffer.concat(chunks)))});function multipartFile(bytes,contentType){const boundary=contentType.match(/boundary=([^;]+)/i)?.[1];if(!boundary)return bytes;const marker=Buffer.from('\\r\\n--'+boundary);const headerEnd=bytes.indexOf(Buffer.from('\\r\\n\\r\\n'));return headerEnd<0?bytes:bytes.subarray(headerEnd+4,bytes.indexOf(marker,headerEnd+4))}async function mapPool(total,limit,worker){const out=new Array(total);let next=0;async function run(){while(next<total){const index=next++;out[index]=await worker(index)}}await Promise.all(Array.from({length:Math.min(limit,total)},()=>run()));return out}async function callProvider(url,inputs,challenge,timeoutMs){let res;try{res=await fetch(url,{method:'POST',headers:Object.assign({'content-type':'application/json'},challenge?{'x-validation-challenge':challenge}:{}),body:JSON.stringify({inputs}),signal:timeoutMs?AbortSignal.timeout(timeoutMs):undefined})}catch(error){throw{kind:(error&&(error.name==='TimeoutError'||error.name==='AbortError'))?'timeout':'unavailable'}}if(res.status<200||res.status>=300)throw{kind:'unavailable'};const data=await res.json();if(!data||!data.externalResultId)throw{kind:'unavailable'};return data.externalResultId}export async function uploadResource(request,response){const bytes=await readBody(request);if(new URL(request.url,'http://local').searchParams.has('fail'))return json(response,422,{error:'INVALID_INPUT'});const file=multipartFile(bytes,String(request.headers['content-type']||''));const checksum=createHash('sha256').update(file).digest('hex');const id='resource-'+checksum.slice(0,12);return json(response,201,{assetIds:[id],assets:[{id,status:'available',checksum}]})}export async function createSubmission(request,response){const query=new URL(request.url,'http://local').searchParams;const body=JSON.parse((await readBody(request)).toString());if(body['submission-title']==='brand-icon')return json(response,422,{error:'INVALID_INPUT'});const count=Number(body['result-quantity']);const inputs=body[${JSON.stringify(assetField)}];if(!Array.isArray(inputs)||!count)return json(response,422,{error:'INVALID_INPUT'});const observer=process.env.EXTERNAL_OBSERVER_URL;if(observer){const challenge=process.env.VALIDATION_CHALLENGE_ID;const scenario=query.get('integrationScenario');if(scenario==='timeout'){try{await callProvider('http://127.0.0.1:'+APP_PORT+INTEGRATION_SINK,inputs,challenge,50)}catch(error){return json(response,504,{error:'PROVIDER_'+String(error.kind).toUpperCase()})}return json(response,504,{error:'PROVIDER_TIMEOUT'})}if(scenario==='unavailable'){try{await callProvider('http://127.0.0.1:'+APP_PORT+INTEGRATION_UNAVAILABLE,inputs,challenge)}catch(error){return json(response,503,{error:'PROVIDER_'+String(error.kind).toUpperCase()})}return json(response,503,{error:'PROVIDER_UNAVAILABLE'})}let items;try{items=await mapPool(count,PROVIDER_MAX_PARALLEL,()=>callProvider(observer,inputs,challenge,10000))}catch(error){return json(response,503,{error:'PROVIDER_'+String(error&&error.kind?error.kind:'unavailable').toUpperCase()})}const submissionId='submission-'+randomUUID().slice(0,8);return json(response,201,{submissionId,status:'succeeded',items})}const submissionId='submission-'+randomUUID().slice(0,8);return json(response,201,{submissionId,status:'succeeded',items:Array.from({length:count},(_,index)=>'/media/'+submissionId+'-'+(index+1)+'.txt')})}function json(response,status,value){response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(value))}createServer(async(request,response)=>{const path=new URL(request.url,'http://local').pathname;if(path==='/health')return json(response,200,{ok:true});if(path===INTEGRATION_SINK)return;if(path===INTEGRATION_UNAVAILABLE){response.writeHead(503,{'content-type':'application/json'});return response.end(JSON.stringify({error:'unavailable'}))}if(path===${JSON.stringify(uploadOperation?.path)}&&request.method==='POST')return uploadResource(request,response);if(path===${JSON.stringify(submitOperation?.path)}&&request.method==='POST')return createSubmission(request,response);if(path.startsWith('/media/')){response.writeHead(200,{'content-type':'text/plain; charset=utf-8'});return response.end('independent-media-item:'+path.slice(7))}if(path==='/assets/icon.svg'){response.writeHead(200,{'content-type':'image/svg+xml'});return response.end(icon)}response.writeHead(200,{'content-type':'text/html; charset=utf-8'});response.end(web)}).listen(APP_PORT);\n`;
  const operationTokenSource = source
    .replace("function multipartFile(bytes,contentType){const boundary=contentType.match(/boundary=([^;]+)/i)?.[1];if(!boundary)return bytes;const marker=Buffer.from('\\r\\n--'+boundary);const headerEnd=bytes.indexOf(Buffer.from('\\r\\n\\r\\n'));return headerEnd<0?bytes:bytes.subarray(headerEnd+4,bytes.indexOf(marker,headerEnd+4))}", "function multipartFiles(bytes,contentType){const boundary=contentType.match(/boundary=([^;]+)/i)?.[1];if(!boundary)return[bytes];return bytes.toString('binary').split('--'+boundary).slice(1,-1).flatMap(part=>{if(!/filename=\"/i.test(part))return[];const split=part.indexOf('\\r\\n\\r\\n');return split<0?[]:[Buffer.from(part.slice(split+4).replace(/\\r\\n$/,''),'binary')]})}")
    .replace("const file=multipartFile(bytes,String(request.headers['content-type']||''));const checksum=createHash('sha256').update(file).digest('hex');const id='resource-'+checksum.slice(0,12);return json(response,201,{assetIds:[id],assets:[{id,status:'available',checksum}]})", "const files=multipartFiles(bytes,String(request.headers['content-type']||''));const assets=files.map(file=>{const checksum=createHash('sha256').update(file).digest('hex');const id='resource-'+checksum.slice(0,12);return{id,status:'available',checksum,file}});return json(response,201,{assetIds:assets.map(item=>item.id),assets:assets.map(({file,...item})=>item)})")
    .replace(`const PROVIDER_MAX_PARALLEL=${maxParallel};`, `const PROVIDER_MAX_PARALLEL=${maxParallel};const RESOURCE_STORE=new Map();const OPERATION_TOKENS=JSON.parse(process.env.VALIDATION_OPERATION_TOKENS||'{}');`)
    .replace("return{id,status:'available',checksum,file}", "RESOURCE_STORE.set(id,file.toString('base64'));return{id,status:'available',checksum,file}")
    .replace(`const inputs=body[${JSON.stringify(assetField)}];if(!Array.isArray(inputs)||!count)`, `const resourceIds=body[${JSON.stringify(assetField)}];if(!Array.isArray(resourceIds)||!count||resourceIds.some(id=>!RESOURCE_STORE.has(id)))`)
    .replace("const observer=process.env.EXTERNAL_OBSERVER_URL;", "const inputs=resourceIds.map(id=>RESOURCE_STORE.get(id));const observer=process.env.EXTERNAL_OBSERVER_URL;")
    .replace('async function callProvider(url,inputs,challenge,timeoutMs){', `async function callProvider(url,inputs,challenge,timeoutMs){const operationToken=OPERATION_TOKENS[${JSON.stringify(submitOperation.id)}];`)
    .replace("Object.assign({'content-type':'application/json'},challenge?{'x-validation-challenge':challenge}:{})", "Object.assign({'content-type':'application/json'},challenge?{'x-validation-challenge':challenge}:{},operationToken?{'x-validation-operation-token':operationToken}:{})");
  writeFileSync(`${implementation}/backend/server.mjs`, operationTokenSource);
}

// Turn the implemented golden into a runnable campaign candidate: the campaign re-prepares a clean
// workspace and copies only these (non-protected) files, then runs campaign-setup.mjs (install) to complete
// the fresh BMAD stories and drop replaced business-sample templates in place. integratedAppEnv routes the
// application's external calls through the campaign observer with the challenge; integratedE2e drives the
// journey only through the observed ingress.
function writeCampaignCandidate() {
  cpSync(`${fixtures}/bmad-completion.mjs`, `${implementation}/bmad-completion.mjs`);
  cpSync(`${fixtures}/campaign-setup.mjs`, `${implementation}/campaign-setup.mjs`);
  cpSync(`${fixtures}/integrated-e2e.mjs`, `${implementation}/tests/integrated-e2e.mjs`);
  writeJSON(`${implementation}/campaign-contract.json`, {
    copy: ['backend', 'web', 'tests', 'migrations', 'Dockerfile', 'package.json', 'control-bindings.json', 'interaction-manifest.json', 'implementation-provenance.json', 'placeholder-resolution.json', 'frontend-runtime-config.json', 'campaign-setup.mjs', 'bmad-completion.mjs'],
    install: [{ command: 'node', args: ['campaign-setup.mjs'], cwd: '.' }],
    runtime: {
      app: { command: 'node', args: ['backend/server.mjs'], env: { PORT: '${APP_PORT}' } },
      integratedAppEnv: { EXTERNAL_OBSERVER_URL: '${EXTERNAL_OBSERVER_URL}', VALIDATION_CHALLENGE_ID: '${VALIDATION_CHALLENGE_ID}' },
      healthUrl: 'http://127.0.0.1:${APP_PORT}/health',
      startupTimeoutMs: 15000,
      integratedE2e: { command: 'node', args: ['tests/integrated-e2e.mjs'], env: { BASE_URL: '${OBSERVED_BASE_URL}' }, timeoutMs: 60000 },
    },
  });
}

function writeUnitEvidence() {
  const script = `import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';const plan=JSON.parse(readFileSync('implementation-plan.json'));const api=JSON.parse(readFileSync('inputs/handoff-api-contract.json'));const sample=schema=>schema?.const??schema?.enum?.[0]??(schema?.type==='object'?Object.fromEntries(Object.entries(schema.properties||{}).map(([key,value])=>[key,sample(value)])):schema?.type==='array'?[sample(schema.items)]:schema?.type==='integer'?1:schema?.type==='number'?1:schema?.type==='boolean'?true:'observed');const numeric=schema=>{const found=(schema?.enum||[]).find(value=>Number.isFinite(Number(value))&&Number(value)>=1);return found!==undefined?String(found):'2'};const countField=operation=>operation.finalProduct?.quantity?.sourceField;const requestBody=operation=>{const schema=operation.request?.bodySchema;if(schema?.type!=='object')return sample(schema);const field=countField(operation);return Object.fromEntries(Object.entries(schema.properties||{}).map(([key,value])=>[key,key===field?numeric(value):sample(value)]))};const responseBody=operation=>{const base=sample(operation.response?.bodySchema);const field=countField(operation);if(field&&base&&typeof base==='object'&&!Array.isArray(base)){const n=Number(numeric(operation.request?.bodySchema?.properties?.[field]));for(const[key,value]of Object.entries(base))if(Array.isArray(value))base[key]=Array.from({length:n},(_,index)=>value[0]&&typeof value[0]==='object'?value[0]:key+'-'+(index+1))}return base};const event=(operation,index,errorCode=null)=>({id:'event-'+operation.id+'-'+index,operationId:operation.id,request:{method:operation.method,route:operation.path,contentType:operation.request?.contentType||'application/json',path:sample(operation.request?.pathSchema),query:sample(operation.request?.querySchema),header:sample(operation.request?.headerSchema),body:requestBody(operation)},response:{status:errorCode?400:(operation.response?.successStatuses?.[0]||200),body:errorCode?{error:errorCode}:responseBody(operation)},authorization:{checked:true,allowed:!errorCode},...(errorCode?{errorCode}:{}),effects:errorCode?[]:(operation.effects||[]).map(item=>({...item,observed:true,before:null,after:{id:'observed'}})),...(operation.providerContract?.outputMode==='independent-items'&&!errorCode?{providerCalls:(Object.values(responseBody(operation)).filter(Array.isArray).sort((a,b)=>b.length-a.length)[0]||[]).map((_,index)=>({index,status:'succeeded'}))}:{}),transaction:{observed:true}});const events=api.operations.flatMap(operation=>[event(operation,0),...(operation.errors||[]).map((error,index)=>event(operation,index+1,typeof error==='object'?error.code:error))]);mkdirSync('evidence',{recursive:true});writeFileSync('evidence/golden-units.txt','passed\\n');writeFileSync('operation-events.json',JSON.stringify({schemaVersion:'1.0',events}));writeFileSync('unit-test-report.json',JSON.stringify({cases:plan.units.map(unit=>({id:'test-'+unit.id,status:'passed',unitIds:[unit.id],evidence:['evidence/golden-units.txt']}))}));\n`;
  writeFileSync(`${implementation}/tests/unit.mjs`, script);
}

function writeProvenance() { writeJSON(`${implementation}/implementation-provenance.json`, { schemaVersion: '1.0', backendSource: { status: 'implemented' }, operationSources: api.operations.map((operation) => ({ operationId: operation.id, files: [{ path: 'backend/server.mjs', symbol: operation.resourceTransfer ? 'uploadResource' : 'createSubmission' }] })) }); }

function writeFrontendContracts() {
  const submitOperation = submit.operations[0]; const uploadOperation = upload.operations[0];
  const submitInput = fieldPlan.bindings.find((item) => item.capabilityId === submit.id && item.kind === 'command'); const uploadInput = fieldPlan.bindings.find((item) => item.capabilityId === upload.id && item.kind === 'input');
  const bindings = [
    { id: `binding-${submit.id}`, capabilityId: submit.id, operationId: submitOperation.id, mode: submit.presentation.mode, runtimeEvidenceId: 'browser-submit', source: { path: 'web/pages/submission/index.html', locator: `control-${submit.id}` } },
    { id: `binding-${upload.id}`, capabilityId: upload.id, operationId: uploadOperation.id, mode: upload.presentation.mode, runtimeEvidenceId: 'browser-upload', source: { path: 'web/pages/submission/index.html', locator: uploadInput.controlId } },
    { id: `binding-${planned.id}`, capabilityId: planned.id, bindingType: 'activation', mode: planned.presentation.mode, runtimeEvidenceId: 'browser-planned', source: { path: 'web/pages/submission/index.html', locator: `control-${planned.id}` } }
  ];
  writeJSON(`${implementation}/control-bindings.json`, { schemaVersion: '1.0', status: 'implemented', bindings });
  writeJSON(`${implementation}/interaction-manifest.json`, { schemaVersion: '1.0', status: 'implemented', interactions: [
    { id: `interaction-${submit.id}`, capabilityId: submit.id, operationId: submitOperation.id, event: 'submit', evidenceId: 'browser-submit', status: 'verified' },
    { id: `interaction-${upload.id}`, capabilityId: upload.id, operationId: uploadOperation.id, event: 'upload', evidenceId: 'browser-upload', status: 'verified' },
    { id: `interaction-${planned.id}`, capabilityId: planned.id, event: 'click', evidenceId: 'browser-planned', status: 'planned' }
  ] });
  const config = readJSON(`${implementation}/frontend-runtime-config.json`); Object.assign(config, { status: 'implemented', baseUrl: 'http://127.0.0.1:${PORT}', start: { command: 'node', args: ['backend/server.mjs'] }, healthUrl: 'http://127.0.0.1:${PORT}/health', e2e: { command: 'node', args: ['tests/browser-runtime.mjs'], timeoutMs: 60000 } }); writeJSON(`${implementation}/frontend-runtime-config.json`, config);
  const resolution = readJSON(`${implementation}/placeholder-resolution.json`); resolution.status = 'implemented'; for (const item of resolution.items) if (item.resolution === 'pending') item.resolution = ({ 'api-data': 'replaced-by-api-data', 'user-input': 'replaced-by-user-input', 'empty-state': 'converted-to-empty-state' })[item.requiredReplacement]; resolution.items.push({ id: `placeholder-${submit.id}`, capabilityId: submit.id, classification: 'visual-placeholder', resolution: 'replaced-by-api-data', states: { empty: true, loading: true, error: true, success: true }, evidenceId: 'browser-submit' }, { id: `placeholder-${upload.id}`, capabilityId: upload.id, classification: 'visual-placeholder', resolution: 'replaced-by-user-input', evidenceId: 'browser-upload' }); writeJSON(`${implementation}/placeholder-resolution.json`, resolution);
}

function convertToHeadless(dir) { const spec = readJSON(`${dir}/functional-spec.json`); spec.capabilities = spec.capabilities.filter((item) => item.specificationStatus === 'complete'); for (const capability of spec.capabilities) capability.presentation = { mode: 'headless' }; const ids = new Set(spec.capabilities.map((item) => item.id)); spec.journeys = (spec.journeys || []).map((journey) => ({ ...journey, capabilityIds: journey.capabilityIds.filter((id) => ids.has(id)), operationIds: journey.operationIds.filter((id) => spec.capabilities.some((capability) => capability.operations.some((operation) => operation.id === id))), steps: journey.steps.filter((step) => ids.has(step.capabilityId)) })); writeJSON(`${dir}/functional-spec.json`, spec); const definitions = readJSON(`${dir}/capability-definitions.json`); definitions.capabilities = spec.capabilities; definitions.journeys = spec.journeys; writeJSON(`${dir}/capability-definitions.json`, definitions); const map = readJSON(`${dir}/page-function-map.json`); for (const page of map.pages) page.capabilityIds = page.capabilityIds.filter((id) => ids.has(id)); writeJSON(`${dir}/page-function-map.json`, map); const controls = readJSON(`${dir}/control-capability-map.json`); controls.mappings = controls.mappings.filter((item) => ids.has(item.capabilityId)); writeJSON(`${dir}/control-capability-map.json`, controls); const manifest = readJSON(`${dir}/manifest.json`); manifest.deliveryMode = 'complete'; manifest.productCompletionClaim = 'complete'; manifest.capabilitySummary = { ...manifest.capabilitySummary, total: spec.capabilities.length, complete: spec.capabilities.length, planned: 0 }; writeJSON(`${dir}/manifest.json`, manifest); }
function inputHtml(item) { const field = item.requestPath.replace(/^body\./, ''); return `<label>${item.controlId}<input id="${item.controlId}" data-vr-id="${releaseControlByInput.get(field) || field}" data-domain-input-id="${field}"></label>`; }
function convertToHeadlessPreservingContracts(dir) {
  const spec = readJSON(`${dir}/functional-spec.json`);
  spec.capabilities = spec.capabilities.filter((item) => item.specificationStatus === 'complete');
  for (const capability of spec.capabilities) capability.presentation = { ...capability.presentation, mode: 'headless' };
  const ids = new Set(spec.capabilities.map((item) => item.id));
  spec.journeys = (spec.journeys || []).map((journey) => ({ ...journey, capabilityIds: journey.capabilityIds.filter((id) => ids.has(id)), operationIds: journey.operationIds.filter((id) => spec.capabilities.some((capability) => capability.operations.some((operation) => operation.id === id))), steps: journey.steps.filter((step) => ids.has(step.capabilityId)) }));
  writeJSON(`${dir}/functional-spec.json`, spec);
  const definitions = readJSON(`${dir}/capability-definitions.json`); definitions.capabilities = spec.capabilities; definitions.journeys = spec.journeys; writeJSON(`${dir}/capability-definitions.json`, definitions);
  const map = readJSON(`${dir}/page-function-map.json`); for (const page of map.pages) page.capabilityIds = page.capabilityIds.filter((id) => ids.has(id)); writeJSON(`${dir}/page-function-map.json`, map);
  const controls = readJSON(`${dir}/control-capability-map.json`); controls.mappings = controls.mappings.filter((item) => ids.has(item.capabilityId)); writeJSON(`${dir}/control-capability-map.json`, controls);
  // Bookkeeping: dropping planned/non-complete capabilities orphans the evidence they anchored.
  // Disposition each now-unanchored indexed item (with a rationale) so the gate stays satisfied
  // for the reduced all-headless fixture.
  const index = readJSON(`${dir}/evidence-index.json`);
  const anchored = new Set();
  for (const capability of spec.capabilities) { for (const anchor of capability.evidenceAnchors || []) anchored.add(anchor); for (const question of ['userInput', 'systemBehavior', 'output', 'resultDestination', 'failures', 'downstreamUse']) for (const anchor of capability.closure?.[question]?.evidenceAnchors || []) anchored.add(anchor); }
  const dispositions = readJSON(`${dir}/evidence-dispositions.json`);
  const dispositioned = new Set(dispositions.dispositions.map((item) => item.evidenceId));
  for (const item of index.evidence) if (!anchored.has(item.id) && !dispositioned.has(item.id)) dispositions.dispositions.push({ evidenceId: item.id, reason: 'out-of-scope', rationale: 'Evidence for a capability excluded from the all-headless subset (planned or non-complete); retained in the index but owned by no headless capability closure.' });
  writeJSON(`${dir}/evidence-dispositions.json`, dispositions);
  // Every release control still needs a disposition, but the all-headless subset has no UI closure, so each
  // control is honestly ignored-with-reason (a headless capability lands through services and APIs, not a control).
  const ledger = readJSON(`${dir}/control-dispositions.json`);
  for (const entry of ledger.dispositions) { entry.disposition = 'ignored-with-reason'; entry.rationale = 'All-headless fixture: capabilities are implemented through services and APIs with no UI control closure.'; delete entry.capabilityId; delete entry.operationId; }
  writeJSON(`${dir}/control-dispositions.json`, ledger);
  const manifest = readJSON(`${dir}/manifest.json`); manifest.deliveryMode = 'complete'; manifest.productCompletionClaim = 'complete'; manifest.capabilitySummary = { ...manifest.capabilitySummary, total: spec.capabilities.length, complete: spec.capabilities.length, planned: 0 }; writeJSON(`${dir}/manifest.json`, manifest);
}
function overlayAuthoredClosure(dir) {
  const authored = `${fixtures}/authored-domain-23`;
  for (const file of ['functional-spec.json', 'capability-definitions.json', 'page-function-map.json', 'unresolved-items.json', 'evidence-dispositions.json', 'control-capability-map.json', 'control-dispositions.json']) cpSync(`${authored}/${file}`, `${dir}/${file}`);
  const manifest = readJSON(`${dir}/manifest.json`);
  const spec = readJSON(`${dir}/functional-spec.json`);
  // The control-disposition ledger is bound to the immutable release digest; the static authored fixture cannot
  // hardcode it, so bind it from the scaffold's semantic inventory (like the observed-interaction anchors below).
  const ledger = readJSON(`${dir}/control-dispositions.json`);
  const semanticInventory = readJSON(`${dir}/frontend-semantic-inventory.json`);
  if (semanticInventory.release?.releaseDigest) ledger.releaseDigest = semanticInventory.release.releaseDigest;
  writeJSON(`${dir}/control-dispositions.json`, ledger);
  manifest.schemaVersion = '2.3';
  manifest.controlDispositions = 'control-dispositions.json';
  manifest.evidenceIndex = 'evidence-index.json';
  manifest.authoringStatus = 'completed';
  manifest.deliveryMode = 'mixed';
  manifest.productCompletionClaim = 'partial';
  manifest.capabilitySummary = {
    total: spec.capabilities.length,
    complete: spec.capabilities.filter((item) => item.specificationStatus === 'complete').length,
    planned: spec.capabilities.filter((item) => item.specificationStatus === 'planned').length,
    draftPendingAuthoring: 0,
    blockedCapabilities: 0,
    openBlockers: 0,
  };
  writeJSON(`${dir}/manifest.json`, manifest);
  // The observed-interaction evidence ids are content-derived from the immutable release (F3), so
  // the static authored fixture cannot hardcode them. Anchor each observed interaction to the
  // capability that owns its trigger control, keeping the bookkeeping honest (an observed behavior
  // is evidence for the capability it drives, not an out-of-scope discard).
  const evidenceIndex = readJSON(`${dir}/evidence-index.json`);
  const controlMap = readJSON(`${dir}/control-capability-map.json`);
  const capabilityByControl = new Map((controlMap.mappings || []).filter((item) => item.controlId).map((item) => [item.controlId, item.capabilityId]));
  for (const item of evidenceIndex.evidence.filter((entry) => entry.kind === 'observed-interaction')) {
    const capability = spec.capabilities.find((entry) => entry.id === capabilityByControl.get(item.source?.controlId));
    if (capability?.closure?.systemBehavior && !capability.closure.systemBehavior.evidenceAnchors.includes(item.id)) capability.closure.systemBehavior.evidenceAnchors.push(item.id);
  }
  writeJSON(`${dir}/functional-spec.json`, spec);
  const definitions = readJSON(`${dir}/capability-definitions.json`);
  definitions.capabilities = spec.capabilities;
  writeJSON(`${dir}/capability-definitions.json`, definitions);
  const planning = readJSON(`${dir}/planning-artifacts.json`);
  planning.method = 'bmad-planning';
  for (const phase of planning.phases || []) if (phase.id !== 'independent-domain-review') phase.status = 'completed';
  writeJSON(`${dir}/planning-artifacts.json`, planning);
}
function run(script, args) { const result = spawnSync('node', [script, ...args], { encoding: 'utf8' }); if (result.status !== 0) throw new Error(`${script} failed\n${result.stdout}${result.stderr}`); }
function readJSON(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function writeJSON(path, value) { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
function option(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; }

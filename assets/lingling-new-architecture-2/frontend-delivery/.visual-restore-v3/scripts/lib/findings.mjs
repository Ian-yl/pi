import { createHash } from 'node:crypto';

const PRIORITY = ['P0', 'P1', 'P2', 'P3'];
const OPEN_STATUSES = new Set(['open', 'regressed', 'blocked']);

export function makeFinding(input = {}) {
  const detector = String(input.detector || 'unknown');
  const dimension = String(input.dimension || 'visual');
  const target = input.target || {};
  const code = String(input.code || input.kind || 'difference');
  const identity = [
    detector,
    dimension,
    code,
    target.elementId || '',
    target.selector || '',
    target.region || '',
    target.file || '',
    input.anchor || '',
  ].join('|');

  return {
    id: input.id || `${detector}:${dimension}:${shortHash(identity)}`,
    detector,
    code,
    dimension,
    severity: normalizeSeverity(input.severity),
    status: input.status || 'open',
    title: input.title || `${detector} ${dimension} difference`,
    target,
    expected: input.expected ?? null,
    actual: input.actual ?? null,
    threshold: input.threshold ?? null,
    confidence: clampConfidence(input.confidence),
    evidence: input.evidence || {},
    nextAction: input.nextAction || '',
    reason: input.reason || '',
    firstSeenAt: input.firstSeenAt || null,
    lastSeenAt: input.lastSeenAt || null,
    resolvedAt: input.resolvedAt || null,
  };
}

export function reconcileFindings(current, previous = [], { now = new Date().toISOString() } = {}) {
  const previousById = new Map(previous.map((finding) => [finding.id, finding]));
  const currentIds = new Set();
  const reconciled = [];

  for (const raw of current) {
    const finding = makeFinding(raw);
    if (currentIds.has(finding.id)) continue;
    currentIds.add(finding.id);
    const old = previousById.get(finding.id);
    const preservedStatus = old?.status === 'waived' || old?.status === 'known-noise';
    reconciled.push({
      ...finding,
      status: preservedStatus ? old.status : old?.status === 'fixed' ? 'regressed' : finding.status,
      reason: preservedStatus ? old.reason : finding.reason,
      firstSeenAt: old?.firstSeenAt || now,
      lastSeenAt: now,
      resolvedAt: null,
    });
  }

  for (const old of previous) {
    if (currentIds.has(old.id)) continue;
    reconciled.push({
      ...old,
      status: old.status === 'waived' || old.status === 'known-noise' ? old.status : 'fixed',
      resolvedAt: old.resolvedAt || now,
      lastSeenAt: old.lastSeenAt || now,
    });
  }

  return reconciled.sort(compareFindings);
}

export function summarizeFindings(findings) {
  const summary = {
    total: findings.length,
    open: 0,
    resolved: 0,
    bySeverity: {},
    byStatus: {},
    byDimension: {},
    byDetector: {},
  };
  for (const finding of findings) {
    const open = findingIsOpen(finding);
    if (open) summary.open++;
    else summary.resolved++;
    increment(summary.bySeverity, finding.severity);
    increment(summary.byStatus, finding.status);
    increment(summary.byDimension, finding.dimension);
    increment(summary.byDetector, finding.detector);
  }
  return summary;
}

export function findingIsOpen(finding) {
  return OPEN_STATUSES.has(finding?.status || 'open');
}

export function compareFindings(a, b) {
  const severity = PRIORITY.indexOf(a.severity) - PRIORITY.indexOf(b.severity);
  if (severity) return severity;
  const status = Number(!findingIsOpen(a)) - Number(!findingIsOpen(b));
  if (status) return status;
  return String(a.id).localeCompare(String(b.id));
}

export function shortHash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function normalizeSeverity(value) {
  const normalized = String(value || 'P2').toUpperCase();
  return PRIORITY.includes(normalized) ? normalized : 'P2';
}

function clampConfidence(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(1, number));
}

function increment(target, key) {
  const name = String(key || 'unknown');
  target[name] = (target[name] || 0) + 1;
}

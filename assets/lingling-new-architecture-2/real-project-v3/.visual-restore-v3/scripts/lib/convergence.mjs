// Page convergence stop-loss contract: round budget, plateau detection, residual composition report.
export const DEFAULT_CONVERGENCE = Object.freeze({
  maxRounds: 12,
  plateauRounds: 3,
  plateauEpsilonPp: 0.1,
});

export const RESIDUAL_ESCALATION_OPTIONS = Object.freeze([
  Object.freeze({ option: 'waive-findings', note: '对像素不可达的残余差异登记 findingId 与原因,豁免后再走门禁' }),
  Object.freeze({ option: 'recalibrate-targets', note: '按实测天花板重设 restore-plan 的 fullSimilarity/foregroundSimilarity 目标分' }),
  Object.freeze({ option: 'descope-page', note: '把该页移出本轮交付范围,单独排期处理' }),
]);

export function normalizeConvergence(value) {
  if (value === undefined || value === null) return { ...DEFAULT_CONVERGENCE };
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('convergence 必须是对象');
  return {
    maxRounds: positiveIntegerOption(value.maxRounds, 'convergence.maxRounds', DEFAULT_CONVERGENCE.maxRounds),
    plateauRounds: positiveIntegerOption(value.plateauRounds, 'convergence.plateauRounds', DEFAULT_CONVERGENCE.plateauRounds),
    plateauEpsilonPp: positiveNumberOption(value.plateauEpsilonPp, 'convergence.plateauEpsilonPp', DEFAULT_CONVERGENCE.plateauEpsilonPp),
  };
}

export function scoredSimilarities(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && typeof entry.similarity === 'number' && Number.isFinite(entry.similarity))
    .map((entry) => entry.similarity);
}

export function countScoredRounds(entries) {
  return scoredSimilarities(entries).length;
}

export function evaluateConvergence({
  entries = [],
  maxRounds = DEFAULT_CONVERGENCE.maxRounds,
  plateauRounds = DEFAULT_CONVERGENCE.plateauRounds,
  plateauEpsilonPp = DEFAULT_CONVERGENCE.plateauEpsilonPp,
  targetScore = null,
  targetForeground = null,
  foregroundScore = null,
  now = new Date().toISOString(),
} = {}) {
  const scores = scoredSimilarities(entries);
  const rounds = scores.length;
  const latestScore = rounds ? scores[rounds - 1] : null;
  const bestScore = rounds ? Math.max(...scores) : null;
  const windowImprovementPp = rounds >= plateauRounds + 1
    ? roundPp(bestUpTo(scores, rounds) - bestUpTo(scores, rounds - plateauRounds))
    : null;
  const result = {
    status: 'converging',
    rounds,
    maxRounds,
    plateauRounds,
    plateauEpsilonPp,
    bestScore,
    latestScore,
    windowImprovementPp,
    evaluatedAt: now,
  };
  if (!rounds) return result;
  const scoreMet = targetScore === null || latestScore >= targetScore;
  const foregroundMet = targetForeground === null || foregroundScore === null || foregroundScore >= targetForeground;
  if (scoreMet && foregroundMet) return { ...result, status: 'met' };
  if (rounds >= maxRounds) return { ...result, status: 'budget-exhausted' };
  if (windowImprovementPp !== null && windowImprovementPp < plateauEpsilonPp) return { ...result, status: 'plateaued' };
  return result;
}

export function formatConvergenceLine(convergence) {
  if (!convergence || !convergence.status) return null;
  const window = typeof convergence.windowImprovementPp === 'number'
    ? `, window ${convergence.windowImprovementPp >= 0 ? '+' : ''}${convergence.windowImprovementPp}pp`
    : '';
  const marker = convergence.status === 'plateaued' || convergence.status === 'budget-exhausted' ? '⚠ ' : '';
  return `${marker}convergence: ${convergence.status} (rounds ${convergence.rounds}/${convergence.maxRounds}${window})`;
}

export function buildResidualReport({
  name,
  convergence = null,
  targets = {},
  foreground = null,
  diffComponents = null,
  regionScores = null,
  inventorySummary = null,
  qualityTarget = null,
  topLimit = 20,
  now = new Date().toISOString(),
} = {}) {
  return {
    version: 1,
    name: name || 'unknown',
    generatedAt: now,
    status: convergence?.status || 'unknown',
    rounds: convergence?.rounds ?? 0,
    scores: {
      overall: {
        latest: finiteOrNull(convergence?.latestScore),
        best: finiteOrNull(convergence?.bestScore),
        target: finiteOrNull(targets.fullSimilarity),
      },
      foreground: {
        latest: finiteOrNull(foreground?.foregroundSimilarity),
        target: finiteOrNull(targets.foregroundSimilarity),
      },
    },
    topDiffComponents: residualDiffComponents(name, diffComponents, topLimit),
    regions: residualLowRegions(name, regionScores, finiteOrNull(targets.minRegionSimilarity)),
    classificationHints: residualClassificationHints({ regionScores, inventorySummary, qualityTarget, foreground }),
    escalationOptions: RESIDUAL_ESCALATION_OPTIONS.map((option) => ({ ...option })),
  };
}

function residualDiffComponents(name, diffComponents, topLimit) {
  const source = `output/${name}/diff-components.json`;
  if (!Array.isArray(diffComponents)) {
    return { source, unavailable: 'diff-components.json 缺失或不可解析' };
  }
  const items = diffComponents
    .filter((component) => component && typeof component === 'object')
    .slice()
    .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
    .slice(0, Math.max(1, Number(topLimit) || 1))
    .map((component) => ({
      count: finiteOrNull(component.count),
      x: finiteOrNull(component.x),
      y: finiteOrNull(component.y),
      width: finiteOrNull(component.width),
      height: finiteOrNull(component.height),
      region: component.region || null,
    }));
  return { source, total: diffComponents.length, items };
}

function residualLowRegions(name, regionScores, minRegionSimilarity) {
  const source = `output/${name}/region-score.json`;
  if (!Array.isArray(regionScores)) {
    return { source, unavailable: 'region-score.json 缺失或不可解析' };
  }
  const items = regionScores
    .filter((region) => region && typeof region.similarity === 'number')
    .map((region) => ({
      name: region.name || 'unknown',
      similarity: region.similarity,
      threshold: finiteOrNull(region.minSimilarity) ?? minRegionSimilarity,
      diffPct: finiteOrNull(region.diffPct),
      shareOfTotalDiff: finiteOrNull(region.shareOfTotalDiff),
      required: region.required !== false,
    }))
    .filter((region) => region.threshold !== null && region.similarity < region.threshold)
    .sort((a, b) => a.similarity - b.similarity);
  return { source, total: regionScores.length, items };
}

function residualClassificationHints({ regionScores, inventorySummary, qualityTarget, foreground }) {
  const hints = [];
  if (qualityTarget && qualityTarget !== 'png') {
    hints.push({
      code: 'jpeg-noise-floor',
      detail: '设计源为 JPEG/截图,文字边缘存在约 3-4% 压缩底噪,这部分 diff 不可消除',
    });
  }
  const shares = (Array.isArray(regionScores) ? regionScores : [])
    .filter((region) => region && typeof region.shareOfTotalDiff === 'number' && region.shareOfTotalDiff > 0)
    .sort((a, b) => b.shareOfTotalDiff - a.shareOfTotalDiff);
  if (shares.length) {
    const top = shares[0];
    hints.push({
      code: 'diff-concentration',
      detail: `区域 ${top.name} 占总 diff ${top.shareOfTotalDiff}%(相似度 ${top.similarity}%),剩余差异最集中`,
    });
  }
  const total = finiteOrNull(inventorySummary?.total);
  const textCount = finiteOrNull(inventorySummary?.byKind?.text);
  if (total !== null && total > 0 && textCount !== null) {
    const textPct = Math.round((100 * textCount) / total);
    if (textPct >= 40) {
      hints.push({
        code: 'text-dense-page',
        detail: `文字类元素占可见元素 ${textPct}%,字体渲染/抗锯齿噪声在残余 diff 中权重高`,
      });
    }
  }
  const salientRatio = finiteOrNull(foreground?.salientRatio);
  if (salientRatio !== null && salientRatio < 35) {
    hints.push({
      code: 'sparse-foreground',
      detail: `salient 前景仅占 ${salientRatio}%,全图分数被空白区抬高,评估以前景分为准`,
    });
  }
  return hints;
}

function bestUpTo(scores, count) {
  return Math.max(...scores.slice(0, count));
}

function roundPp(value) {
  return Number(value.toFixed(4));
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveIntegerOption(value, label, fallback) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} 必须是正整数`);
  return number;
}

function positiveNumberOption(value, label, fallback) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} 必须是正数`);
  return number;
}

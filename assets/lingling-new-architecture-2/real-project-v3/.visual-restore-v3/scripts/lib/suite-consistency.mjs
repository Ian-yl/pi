const DEFAULT_STYLE_PROPERTIES = Object.freeze([
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'color',
  'backgroundColor',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'borderTopColor',
  'borderRightColor',
  'borderBottomColor',
  'borderLeftColor',
  'borderTopLeftRadius',
  'borderTopRightRadius',
  'borderBottomRightRadius',
  'borderBottomLeftRadius',
  'boxShadow',
  'opacity',
]);

export function findInventoryComponent(inventory, auditId) {
  const expected = String(auditId || '');
  const matches = inventoryItems(inventory).filter((item) => {
    const direct = String(item?.auditId || '');
    const attribute = String(item?.attrs?.dataVrId || '');
    return direct === expected || attribute === expected;
  });

  if (matches.length === 0) {
    return { status: 'missing', auditId: expected, item: null, matches };
  }
  if (matches.length > 1) {
    return { status: 'duplicate', auditId: expected, item: null, matches };
  }
  return { status: 'found', auditId: expected, item: matches[0], matches };
}

export function compareComponentGroup({ component, pages, baselinePage = null } = {}) {
  const componentId = String(component?.id || component?.auditId || 'component');
  const auditId = String(component?.auditId || component?.id || '');
  const pageMap = normalizePageMap(pages);
  const requiredPages = uniqueStrings(
    component?.requiredPages?.length ? component.requiredPages : [...pageMap.keys()],
  );
  const selectedBaseline = String(
    baselinePage || component?.baselinePage || requiredPages[0] || [...pageMap.keys()][0] || '',
  );
  const targetPages = uniqueStrings([selectedBaseline, ...requiredPages]).filter(Boolean);
  const checks = [];
  const findings = [];
  const anchors = new Map();

  for (const page of targetPages) {
    if (!pageMap.has(page)) {
      checks.push(componentCheck(componentId, page, 'page', 'fail', {
        expected: 'page evidence present',
        actual: 'missing',
      }));
      findings.push(componentFinding(componentId, page, 'required-page-missing', 'P0', {
        expected: 'page evidence present',
        actual: 'missing',
      }));
      continue;
    }

    const anchor = findInventoryComponent(pageMap.get(page), auditId);
    anchors.set(page, anchor);
    if (anchor.status === 'missing') {
      checks.push(componentCheck(componentId, page, 'anchor', 'fail', {
        expected: `one ${auditId} anchor`,
        actual: 0,
      }));
      findings.push(componentFinding(componentId, page, 'required-component-missing', 'P0', {
        auditId,
        expected: 1,
        actual: 0,
      }));
    } else if (anchor.status === 'duplicate') {
      checks.push(componentCheck(componentId, page, 'anchor', 'fail', {
        expected: `one ${auditId} anchor`,
        actual: anchor.matches.length,
      }));
      findings.push(componentFinding(componentId, page, 'component-anchor-duplicate', 'P0', {
        auditId,
        expected: 1,
        actual: anchor.matches.length,
      }));
    } else {
      checks.push(componentCheck(componentId, page, 'anchor', 'pass', {
        expected: `one ${auditId} anchor`,
        actual: 1,
      }));
    }
  }

  const baselineAnchor = anchors.get(selectedBaseline);
  if (baselineAnchor?.status === 'found') {
    for (const page of targetPages) {
      if (page === selectedBaseline) continue;
      const actualAnchor = anchors.get(page);
      if (actualAnchor?.status !== 'found') continue;
      compareComponentPair({
        component,
        componentId,
        page,
        baselinePage: selectedBaseline,
        baseline: baselineAnchor.item,
        actual: actualAnchor.item,
        checks,
        findings,
      });
    }
  }

  return {
    componentId,
    auditId,
    baselinePage: selectedBaseline,
    pass: findings.length === 0,
    checks,
    findings,
  };
}

export function compareSharedRegion({ region, pageImages, PNG } = {}) {
  const regionId = String(region?.id || region?.name || 'region');
  const imageMap = normalizePageMap(pageImages);
  const requestedPages = uniqueStrings(
    region?.pages?.length ? region.pages : [...imageMap.keys()],
  );
  const baselinePage = String(region?.baselinePage || requestedPages[0] || '');
  const targetPages = uniqueStrings([baselinePage, ...requestedPages]).filter(Boolean);
  const checks = [];
  const findings = [];
  const decoded = new Map();
  const threshold = Number(region?.maxMeanAbsoluteDiff ?? region?.threshold);
  const rect = normalizeRect(region?.rect);

  if (!Number.isFinite(threshold) || threshold < 0) {
    findings.push(regionFinding(regionId, null, 'shared-region-invalid-threshold', 'P0', {
      expected: 'a non-negative maxMeanAbsoluteDiff',
      actual: region?.maxMeanAbsoluteDiff ?? region?.threshold ?? null,
    }));
  }
  if (!rect) {
    findings.push(regionFinding(regionId, null, 'shared-region-invalid-rect', 'P0', {
      expected: 'non-negative integer x/y and positive integer width/height',
      actual: region?.rect ?? null,
    }));
  }

  for (const page of targetPages) {
    if (!imageMap.has(page)) {
      findings.push(regionFinding(regionId, page, 'shared-region-page-image-missing', 'P0', {
        expected: 'page image present',
        actual: 'missing',
      }));
      checks.push(regionCheck(regionId, page, 'evidence', 'fail'));
      continue;
    }
    try {
      decoded.set(page, decodeImage(imageMap.get(page), PNG));
    } catch (error) {
      findings.push(regionFinding(regionId, page, 'shared-region-image-invalid', 'P0', {
        reason: error.message,
      }));
      checks.push(regionCheck(regionId, page, 'evidence', 'fail'));
    }
  }

  const baseline = decoded.get(baselinePage);
  if (baseline) {
    for (const [page, value] of decoded) {
      if (value.width !== baseline.width || value.height !== baseline.height) {
        findings.push(regionFinding(regionId, page, 'shared-region-image-size-mismatch', 'P0', {
          expected: { width: baseline.width, height: baseline.height },
          actual: { width: value.width, height: value.height },
        }));
        checks.push(regionCheck(regionId, page, 'image-size', 'fail'));
      }
    }
  }

  if (rect) {
    for (const [page, value] of decoded) {
      if (rect.x + rect.width > value.width || rect.y + rect.height > value.height) {
        findings.push(regionFinding(regionId, page, 'shared-region-out-of-bounds', 'P0', {
          expected: { width: value.width, height: value.height },
          actual: rect,
        }));
        checks.push(regionCheck(regionId, page, 'bounds', 'fail'));
      }
    }
  }

  if (!baseline || !rect || findings.some((finding) => finding.severity === 'P0')) {
    return { regionId, baselinePage, pass: false, checks, findings };
  }

  for (const page of targetPages) {
    if (page === baselinePage) continue;
    const actual = decoded.get(page);
    if (!actual) continue;
    const masks = masksForPage(region?.masks || [], page);
    const maskResult = buildMask(rect, masks);
    if (!maskResult.valid) {
      findings.push(regionFinding(regionId, page, maskResult.code, 'P0', {
        expected: 'valid region-local masks with remaining comparison pixels',
        actual: maskResult.actual,
      }));
      checks.push(regionCheck(regionId, page, 'mask', 'fail'));
      continue;
    }

    let difference = 0;
    let comparedPixels = 0;
    for (let localY = 0; localY < rect.height; localY++) {
      for (let localX = 0; localX < rect.width; localX++) {
        const localOffset = localY * rect.width + localX;
        if (maskResult.mask[localOffset]) continue;
        const x = rect.x + localX;
        const y = rect.y + localY;
        const offset = (y * baseline.width + x) * 4;
        difference += Math.abs(baseline.data[offset] - actual.data[offset]);
        difference += Math.abs(baseline.data[offset + 1] - actual.data[offset + 1]);
        difference += Math.abs(baseline.data[offset + 2] - actual.data[offset + 2]);
        comparedPixels++;
      }
    }

    const meanAbsoluteDifference = difference / (comparedPixels * 3);
    const status = meanAbsoluteDifference <= threshold ? 'pass' : 'fail';
    checks.push(regionCheck(regionId, page, 'rgb-difference', status, {
      baselinePage,
      threshold,
      meanAbsoluteDifference,
      comparedPixels,
      maskedPixels: rect.width * rect.height - comparedPixels,
    }));
    if (status === 'fail') {
      findings.push(regionFinding(regionId, page, 'shared-region-drift', 'P1', {
        baselinePage,
        expected: { maxMeanAbsoluteDiff: threshold },
        actual: { meanAbsoluteDifference },
      }));
    }
  }

  return {
    regionId,
    baselinePage,
    pass: findings.length === 0,
    checks,
    findings,
  };
}

export function evaluateSuiteConsistency({ plan, inventories, pageImages, PNG } = {}) {
  const plannedPages = (plan?.pages || []).map((page) => String(page?.name || page?.id || page)).filter(Boolean);
  const requiredPages = (plan?.pages || [])
    .filter((page) => typeof page !== 'object' || page?.required !== false)
    .map((page) => String(page?.name || page?.id || page))
    .filter(Boolean);
  const baselinePage = String(
    (typeof plan?.exemplar === 'string' ? plan.exemplar : plan?.exemplar?.page) ||
      plan?.exemplarPage || plan?.goldenPage || plan?.baselinePage || plannedPages[0] || '',
  );
  const components = plan?.shared?.components || plan?.components || [];
  const regions = plan?.consistency?.regions || plan?.sharedRegions || [];
  const componentResults = components.map((component) => {
    const componentRequiredPages = component.requiredPages?.length
      ? component.requiredPages
      : requiredPages;
    const componentBaselinePage = component.baselinePage || (
      componentRequiredPages.includes(baselinePage)
        ? baselinePage
        : componentRequiredPages[0]
    );
    return compareComponentGroup({
      component: {
        ...component,
        requiredPages: componentRequiredPages,
      },
      pages: inventories,
      baselinePage: componentBaselinePage,
    });
  });
  const regionResults = regions.map((region) => compareSharedRegion({
    region: {
      ...region,
      pages: region.pages?.length ? region.pages : plannedPages,
      baselinePage: region.baselinePage || baselinePage,
    },
    pageImages,
    PNG,
  }));
  const checks = [...componentResults, ...regionResults].flatMap((result) => result.checks);
  const findings = [...componentResults, ...regionResults].flatMap((result) => result.findings);

  return {
    pass: findings.length === 0,
    baselinePage,
    componentResults,
    regionResults,
    checks,
    findings,
    summary: {
      componentGroups: componentResults.length,
      sharedRegions: regionResults.length,
      checks: checks.length,
      passed: checks.filter((check) => check.status === 'pass').length,
      allowed: checks.filter((check) => check.status === 'allowed').length,
      failed: checks.filter((check) => check.status === 'fail').length,
      findings: findings.length,
      P0: findings.filter((finding) => finding.severity === 'P0').length,
      P1: findings.filter((finding) => finding.severity === 'P1').length,
    },
  };
}

function compareComponentPair({ component, componentId, page, baselinePage, baseline, actual, checks, findings }) {
  const variant = allowedVariantFor(component?.allowedVariants, page);
  const geometryTolerance = component?.geometryTolerance ?? component?.tolerance?.geometry ?? 1;
  const geometryDiff = compareGeometry(baseline.rect, actual.rect, geometryTolerance);
  if (variant.geometry) {
    checks.push(componentCheck(componentId, page, 'geometry', 'allowed', { baselinePage }));
  } else if (geometryDiff.length) {
    checks.push(componentCheck(componentId, page, 'geometry', 'fail', { baselinePage, differences: geometryDiff }));
    findings.push(componentFinding(componentId, page, 'component-geometry-drift', 'P1', {
      baselinePage,
      differences: geometryDiff,
      threshold: geometryTolerance,
    }));
  } else {
    checks.push(componentCheck(componentId, page, 'geometry', 'pass', { baselinePage }));
  }

  const properties = uniqueStrings(component?.styleProperties || component?.cssProperties || DEFAULT_STYLE_PROPERTIES);
  const ignoredProperties = new Set(variant.properties);
  const propertyDifferences = [];
  for (const property of properties) {
    if (ignoredProperties.has('*') || ignoredProperties.has(property)) {
      checks.push(componentCheck(componentId, page, `style:${property}`, 'allowed', { baselinePage, property }));
      continue;
    }
    const inventoryProperty = cssInventoryProperty(property);
    const expected = normalizeCssValue(baseline.css?.[inventoryProperty]);
    const observed = normalizeCssValue(actual.css?.[inventoryProperty]);
    if (expected === observed) {
      checks.push(componentCheck(componentId, page, `style:${property}`, 'pass', { baselinePage, property }));
    } else {
      checks.push(componentCheck(componentId, page, `style:${property}`, 'fail', {
        baselinePage,
        property,
        expected,
        actual: observed,
      }));
      propertyDifferences.push({ property, expected, actual: observed });
    }
  }
  if (propertyDifferences.length) {
    findings.push(componentFinding(componentId, page, 'component-style-drift', 'P1', {
      baselinePage,
      properties: propertyDifferences.map((difference) => difference.property),
      differences: propertyDifferences,
    }));
  }

  if (variant.text) {
    checks.push(componentCheck(componentId, page, 'text', 'allowed', { baselinePage }));
  } else {
    const expected = normalizeText(baseline.text);
    const observed = normalizeText(actual.text);
    if (expected === observed) {
      checks.push(componentCheck(componentId, page, 'text', 'pass', { baselinePage }));
    } else {
      checks.push(componentCheck(componentId, page, 'text', 'fail', { baselinePage, expected, actual: observed }));
      findings.push(componentFinding(componentId, page, 'component-text-drift', 'P1', {
        baselinePage,
        expected,
        actual: observed,
      }));
    }
  }
}

function compareGeometry(expected = {}, actual = {}, tolerance) {
  const differences = [];
  for (const property of ['x', 'y', 'width', 'height']) {
    const expectedValue = Number(expected?.[property]);
    const actualValue = Number(actual?.[property]);
    const propertyTolerance = typeof tolerance === 'object'
      ? Number(tolerance?.[property] ?? tolerance?.default ?? 1)
      : Number(tolerance);
    if (!Number.isFinite(expectedValue) || !Number.isFinite(actualValue) ||
        Math.abs(expectedValue - actualValue) > (Number.isFinite(propertyTolerance) ? propertyTolerance : 1)) {
      differences.push({
        property,
        expected: Number.isFinite(expectedValue) ? expectedValue : null,
        actual: Number.isFinite(actualValue) ? actualValue : null,
        delta: Number.isFinite(expectedValue) && Number.isFinite(actualValue)
          ? Math.abs(expectedValue - actualValue)
          : null,
        tolerance: Number.isFinite(propertyTolerance) ? propertyTolerance : 1,
      });
    }
  }
  return differences;
}

function allowedVariantFor(allowedVariants, page) {
  if (Array.isArray(allowedVariants)) {
    const matches = allowedVariants.filter((variant) => {
      if (typeof variant === 'string') return variant === page;
      return String(variant?.page || '') === page || variant?.pages?.map(String).includes(page);
    });
    return {
      properties: uniqueStrings(matches.flatMap((variant) => variant?.properties || variant?.ignore?.properties || [])),
      geometry: matches.some((variant) => variant === page || variant?.geometry === true || variant?.ignore?.geometry === true),
      text: matches.some((variant) => variant?.text === true || variant?.ignore?.text === true),
    };
  }
  const variant = allowedVariants?.[page] || {};
  return {
    properties: uniqueStrings(variant.properties || variant.ignore?.properties || []),
    geometry: variant.geometry === true || variant.ignore?.geometry === true,
    text: variant.text === true || variant.ignore?.text === true,
  };
}

function masksForPage(masks, page) {
  return masks
    .filter((mask) => !mask?.page || String(mask.page) === page)
    .filter((mask) => !mask?.pages || mask.pages.map(String).includes(page))
    .map((mask) => mask?.rect || mask);
}

function buildMask(regionRect, masks) {
  const mask = new Uint8Array(regionRect.width * regionRect.height);
  for (const raw of masks) {
    const rect = normalizeRect(raw);
    if (!rect) {
      return { valid: false, code: 'shared-region-mask-invalid', actual: raw };
    }
    if (rect.x + rect.width > regionRect.width || rect.y + rect.height > regionRect.height) {
      return { valid: false, code: 'shared-region-mask-out-of-bounds', actual: rect };
    }
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      mask.fill(1, y * regionRect.width + rect.x, y * regionRect.width + rect.x + rect.width);
    }
  }
  let maskedPixels = 0;
  for (const value of mask) maskedPixels += value;
  if (maskedPixels === mask.length) {
    return { valid: false, code: 'shared-region-fully-masked', actual: { maskedPixels } };
  }
  return { valid: true, mask };
}

function decodeImage(value, PNG) {
  if (value?.width > 0 && value?.height > 0 && value?.data) return value;
  if (!PNG?.sync?.read) throw new TypeError('PNG.sync.read is required for encoded page images');
  return PNG.sync.read(value);
}

function normalizeRect(value) {
  const rect = {
    x: Number(value?.x),
    y: Number(value?.y),
    width: Number(value?.width),
    height: Number(value?.height),
  };
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isInteger)) return null;
  if (rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0) return null;
  return rect;
}

function normalizePageMap(value) {
  if (value instanceof Map) return new Map(value);
  if (Array.isArray(value)) {
    return new Map(value.map((page, index) => [
      String(page?.name || page?.page || page?.id || index),
      page?.inventory ?? page?.image ?? page,
    ]));
  }
  return new Map(Object.entries(value || {}));
}

function inventoryItems(inventory) {
  if (Array.isArray(inventory)) return inventory;
  if (Array.isArray(inventory?.items)) return inventory.items;
  if (Array.isArray(inventory?.inventory?.items)) return inventory.inventory.items;
  return [];
}

function normalizeCssValue(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function cssInventoryProperty(property) {
  const name = String(property);
  if (name.startsWith('--')) return name;
  return name.replace(/-([a-z])/g, (_, character) => character.toUpperCase());
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function uniqueStrings(values) {
  return [...new Set((values || []).map(String).filter(Boolean))];
}

function componentCheck(componentId, page, kind, status, extra = {}) {
  return {
    id: `component:${componentId}:${page}:${kind}`,
    scope: 'component',
    componentId,
    page,
    kind,
    status,
    ...extra,
  };
}

function componentFinding(componentId, page, code, severity, extra = {}) {
  return {
    id: `suite-consistency:${code}:${componentId}:${page || 'suite'}`,
    detector: 'suite-consistency',
    scope: 'component',
    componentId,
    page,
    code,
    severity,
    status: 'open',
    ...extra,
  };
}

function regionCheck(regionId, page, kind, status, extra = {}) {
  return {
    id: `region:${regionId}:${page || 'suite'}:${kind}`,
    scope: 'shared-region',
    regionId,
    page,
    kind,
    status,
    ...extra,
  };
}

function regionFinding(regionId, page, code, severity, extra = {}) {
  return {
    id: `suite-consistency:${code}:${regionId}:${page || 'suite'}`,
    detector: 'suite-consistency',
    scope: 'shared-region',
    regionId,
    page,
    code,
    severity,
    status: 'open',
    ...extra,
  };
}

const EXTERNAL_CAPTURE_ADAPTERS = new Set(['url', 'http', 'external']);

export function resolveCaptureTargetMode(capture = {}) {
  const url = String(capture?.url || '');
  const adapter = String(capture?.adapter || 'static').toLowerCase();
  return /^https?:\/\//i.test(url) || EXTERNAL_CAPTURE_ADAPTERS.has(adapter)
    ? 'external'
    : 'static';
}

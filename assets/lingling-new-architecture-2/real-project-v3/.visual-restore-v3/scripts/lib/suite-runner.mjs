function validateInput({ pages, exemplar, concurrency, worker }) {
  if (!Array.isArray(pages) || pages.length === 0) throw new Error('Suite pages are required');
  if (!pages.some((page) => page?.name === exemplar)) throw new Error(`Suite exemplar is missing: ${exemplar}`);
  validatePoolInput({ pages, concurrency, worker });
}

function validatePoolInput({ pages, concurrency, worker }) {
  if (!Array.isArray(pages) || pages.length === 0) throw new Error('Suite pages are required');
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Suite concurrency must be a positive integer');
  if (typeof worker !== 'function') throw new Error('Suite worker must be a function');
  const names = pages.map((page) => page?.name);
  if (names.some((name) => typeof name !== 'string' || name.length === 0)) throw new Error('Every suite page needs a name');
  if (new Set(names).size !== names.length) throw new Error('Suite page names must be unique');
}

function failureFor(page, error) {
  return {
    page: page.name,
    ok: false,
    errorCode: typeof error?.code === 'string' ? error.code : 'suite_worker_failed',
    error: String(error?.message || 'Suite worker failed').slice(0, 500),
  };
}

async function execute(worker, page) {
  try {
    const result = await worker(page);
    return {
      page: page.name,
      ok: result?.ok !== false,
      ...(result || {}),
    };
  } catch (error) {
    return failureFor(page, error);
  }
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const consume = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await execute(worker, items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, consume));
  return results;
}

export async function runPagePool({ pages, concurrency = 2, worker }) {
  validatePoolInput({ pages, concurrency, worker });
  return runPool(pages, concurrency, worker);
}

export async function runExemplarFirst({ pages, exemplar, concurrency = 2, worker }) {
  validateInput({ pages, exemplar, concurrency, worker });
  const exemplarIndex = pages.findIndex((page) => page.name === exemplar);
  const exemplarResult = await execute(worker, pages[exemplarIndex]);
  const dependents = pages.filter((_, index) => index !== exemplarIndex);
  const dependentResults = await runPool(dependents, concurrency, worker);
  const byName = new Map([
    [exemplar, exemplarResult],
    ...dependentResults.map((result) => [result.page, result]),
  ]);
  return pages.map((page) => byName.get(page.name));
}

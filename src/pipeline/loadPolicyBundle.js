const { loadDbPolicySources } = require('./policy/loadDbPolicySources');
const { loadStaticPolicySources } = require('./policy/loadStaticPolicySources');
const { composePolicyBundle } = require('./policy/composePolicyBundle');

const POLICY_BUNDLE_TTL_MS = 10 * 60 * 1000; // 10 minutes

let policyBundleCache = {
  bundle: null,
  loadedAt: 0,
  inflight: null,
};

function bytesToMiB(bytes) {
  return Number((bytes / (1024 * 1024)).toFixed(2));
}

function isCacheFresh() {
  return (
    policyBundleCache.bundle &&
    (Date.now() - policyBundleCache.loadedAt) < POLICY_BUNDLE_TTL_MS
  );
}

function logDebug(logger, message, payload = {}) {
  console.log(message, payload);
  if (logger && typeof logger.debug === 'function') {
    logger.debug(message, payload);
  }
}

function logWarn(logger, message, payload = {}) {
  console.warn(message, payload);
  if (logger && typeof logger.warn === 'function') {
    logger.warn(message, payload);
  }
}

async function buildFreshPolicyBundle({ query, logger }) {
  const heapBefore = process.memoryUsage().heapUsed;
  const rssBefore = process.memoryUsage().rss;

  logDebug(logger, '[loadPolicyBundle] rebuilding bundle start', {
    cache_status: 'rebuild_start',
  });

  const [dbSources, staticPolicySources] = await Promise.all([
    loadDbPolicySources({ query }),
    Promise.resolve(loadStaticPolicySources()),
  ]);

  const policyBundle = composePolicyBundle({
    dbDictionaryRows: dbSources.dictionaryRows,
    dbEntityMetaRows: dbSources.entityMetaRows,
    staticPolicySources,
  });

  const heapAfter = process.memoryUsage().heapUsed;
  const rssAfter = process.memoryUsage().rss;
  const jsonBytes = Buffer.byteLength(JSON.stringify(policyBundle), 'utf8');

  logDebug(logger, '[loadPolicyBundle] rebuilding bundle complete', {
    cache_status: 'rebuilt',
    source_counts: policyBundle.meta?.source_counts,
    category_counts: policyBundle.meta?.category_counts,
    policy_bundle_json_bytes: jsonBytes,
    policy_bundle_json_mib: bytesToMiB(jsonBytes),
    heap_used_before_bytes: heapBefore,
    heap_used_after_bytes: heapAfter,
    heap_delta_bytes: heapAfter - heapBefore,
    heap_delta_mib: bytesToMiB(heapAfter - heapBefore),
    rss_before_bytes: rssBefore,
    rss_after_bytes: rssAfter,
    rss_delta_bytes: rssAfter - rssBefore,
    rss_delta_mib: bytesToMiB(rssAfter - rssBefore),
  });

  return policyBundle;
}

async function loadPolicyBundle(options = {}) {
  const { query, logger } = options;

  if (isCacheFresh()) {
    logDebug(logger, '[loadPolicyBundle] cache hit', {
      cache_status: 'hit',
      age_ms: Date.now() - policyBundleCache.loadedAt,
      ttl_ms: POLICY_BUNDLE_TTL_MS,
    });
    return policyBundleCache.bundle;
  }

  if (policyBundleCache.inflight) {
    logDebug(logger, '[loadPolicyBundle] awaiting inflight rebuild', {
      cache_status: 'await_inflight',
      age_ms: policyBundleCache.loadedAt
        ? (Date.now() - policyBundleCache.loadedAt)
        : null,
      ttl_ms: POLICY_BUNDLE_TTL_MS,
    });
    return policyBundleCache.inflight;
  }

  policyBundleCache.inflight = (async () => {
    const freshBundle = await buildFreshPolicyBundle({ query, logger });

    policyBundleCache.bundle = freshBundle;
    policyBundleCache.loadedAt = Date.now();

    logDebug(logger, '[loadPolicyBundle] cache stored', {
      cache_status: 'stored',
      loaded_at_ms: policyBundleCache.loadedAt,
      ttl_ms: POLICY_BUNDLE_TTL_MS,
    });

    return freshBundle;
  })();

  try {
    return await policyBundleCache.inflight;
  } catch (err) {
    if (policyBundleCache.bundle) {
      logWarn(logger, '[loadPolicyBundle] rebuild failed; serving stale cache', {
        cache_status: 'stale_fallback',
        error: err?.message || String(err),
        age_ms: Date.now() - policyBundleCache.loadedAt,
        ttl_ms: POLICY_BUNDLE_TTL_MS,
      });
      return policyBundleCache.bundle;
    }

    logWarn(logger, '[loadPolicyBundle] rebuild failed; no cached bundle available', {
      cache_status: 'rebuild_failed_no_cache',
      error: err?.message || String(err),
      ttl_ms: POLICY_BUNDLE_TTL_MS,
    });

    throw err;
  } finally {
    policyBundleCache.inflight = null;
  }
}

module.exports = {
  loadPolicyBundle,
};
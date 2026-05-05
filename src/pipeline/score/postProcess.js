// postProcess.js - private helper for scoreSuppressLane stage.
// Tier3 pair suppression, sample pools, and full-none truth bundle.

const { annotateStorageExplanationBundle } = require('./storageIntent');
const { annotateLaneAuditBundle, hasTitleOrOpEvidence } = require('./laneAudit');

function isObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function toStr(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

function uniqueBoundedStrings(arr, cap = 12) {
  const out = [];
  const seen = new Set();
  for (const v of safeArray(arr)) {
    const s = toStr(v).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

function stableKey(c) {
  return `${toStr(c.category)}||${toStr(c.canonical_slug)}||${toStr(c.dictionary_entity_type)}`;
}

function pushBounded(arr, obj, cap) {
  if (arr.length < cap) arr.push(obj);
}

function inc(obj, key, by = 1) {
  obj[key] = (obj[key] || 0) + by;
}

function cloneBoundedCandidateSample(c0, annotatePolicyAuditMirrors) {
  if (!isObject(c0)) return {};
  const c = { ...c0 };
  c.category = toStr(c.category) || null;
  c.canonical_slug = toStr(c.canonical_slug) || null;
  c.dictionary_entity_type = toStr(c.dictionary_entity_type) || null;
  c.storage_intent = toStr(c.storage_intent) || null;
  c.origins = safeArray(c.origins).map(toStr).filter(Boolean).slice(0, 6);
  c.storage_reasons = uniqueBoundedStrings(c.storage_reasons, 8);
  c.det_safe_tags = safeArray(c.det_safe_tags).map(toStr).filter(Boolean).slice(0, 6);
  c.det_owner_reasons = safeArray(c.det_owner_reasons).map(toStr).filter(Boolean).slice(0, 6);
  c.selection_reason_primary = toStr(c.selection_reason_primary || c.det_selected_reason || null) || null;
  c.suppression_reason_primary = toStr(c.suppression_reason_primary || c.det_suppressed_reason || null) || null;
  annotateStorageExplanationBundle(c);
  annotateLaneAuditBundle(c);
  annotatePolicyAuditMirrors(c);
  c.storage_reasons = uniqueBoundedStrings(c.storage_reasons, 8);
  c.storage_blockers = uniqueBoundedStrings(c.storage_blockers, 8);
  c.storage_reason_trace = uniqueBoundedStrings(c.storage_reason_trace, 8);
  c.selection_competition_reason = toStr(c.selection_competition_reason || null) || null;
  c.drop_reason_primary = toStr(c.drop_reason_primary || null) || null;
  c.drop_reason_family = toStr(c.drop_reason_family || null) || null;
  c.drop_explanation_trace = safeArray(c.drop_explanation_trace).map(toStr).filter(Boolean).slice(0, 6);
  c.same_canonical_det_selected_elsewhere = c.same_canonical_det_selected_elsewhere === true;
  c.same_canonical_det_selected_elsewhere_intent = toStr(c.same_canonical_det_selected_elsewhere_intent || null) || null;
  c.same_canonical_persisted_elsewhere = c.same_canonical_persisted_elsewhere === true;
  c.same_canonical_persisted_elsewhere_intent = toStr(c.same_canonical_persisted_elsewhere_intent || null) || null;
  c.same_canonical_selected_elsewhere = c.same_canonical_selected_elsewhere === true;
  c.same_canonical_selected_elsewhere_intent = toStr(c.same_canonical_selected_elsewhere_intent || null) || null;
  c.same_canonical_competition_summary = isObject(c.same_canonical_competition_summary) ? c.same_canonical_competition_summary : null;
  c.selection_competition_scope = toStr(c.selection_competition_scope || null) || null;
  c.selection_competition_reason_detail = toStr(c.selection_competition_reason_detail || null) || null;
  c.subject_support_signals = uniqueBoundedStrings(c.subject_support_signals || [], 20);
  c.secondary_example_signals = uniqueBoundedStrings(c.secondary_example_signals || [], 20);
  c.subject_tier_lane_mapping_live = c.subject_tier_lane_mapping_live === true;
  return c;
}

function buildRichSamplePools(selArr, supArr, topN, annotatePolicyAuditMirrors) {
  const sel = safeArray(selArr);
  const sup = safeArray(supArr);
  const topSup = sup.slice(0, topN);
  const clone = (c) => cloneBoundedCandidateSample(c, annotatePolicyAuditMirrors);
  const suppressedSamples = topSup.map((c) => {
    const s = clone(c);
    if (s && typeof s === 'object') s.subject_tier_lane_mapping_live = s.subject_tier_lane_mapping_live === true;
    return s;
  });

  const ragOk = sel.filter((c) => toStr(c?.storage_intent).toUpperCase() === 'RAG_OK').slice(0, 12).map(clone);
  const contextOnly = sel.filter((c) => toStr(c?.storage_intent).toUpperCase() === 'CONTEXT_ONLY').slice(0, 12).map(clone);
  const noneSelected = sel.filter((c) => toStr(c?.storage_intent).toUpperCase() === 'NONE').slice(0, 12).map(clone);
  const shadowSuppressed = topSup.filter((c) => {
    const lane = toStr(c?.det_lane).toUpperCase();
    const si = toStr(c?.storage_intent).toUpperCase();
    return lane === 'SHADOW' || si === 'NONE';
  }).slice(0, 12).map(clone);
  const shadowOrNone = noneSelected.length ? noneSelected : shadowSuppressed;
  const storageSelected = sel.filter((c) => {
    const si = toStr(c?.storage_intent).toUpperCase();
    return si === 'RAG_OK' || si === 'CONTEXT_ONLY';
  }).slice(0, 12).map(clone);

  return {
    det_selected_pre_samples: sel.slice(0, 12).map(clone),
    det_suppressed_top_pre_samples: suppressedSamples,
    rag_ok_samples: ragOk,
    context_only_samples: contextOnly,
    shadow_or_none_samples: shadowOrNone,
    storage_selected_samples: storageSelected,
    storage_context_only_samples: contextOnly,
    storage_none_samples: shadowOrNone,
  };
}

function buildFullNoneTruthBundle(selArr, supArr) {
  const sel = safeArray(selArr);
  const sup = safeArray(supArr);
  const noneFull = sel.filter((c) => toStr(c?.storage_intent).toUpperCase() === 'NONE').concat(sup.filter((c) => toStr(c?.storage_intent).toUpperCase() === 'NONE'));
  const noneReasonCounts = {};
  const noneBlockerCounts = {};
  for (const c of noneFull) {
    const reasonPrimary = toStr(c?.suppression_reason_primary || c?.det_suppressed_reason || c?.storage_reason_primary).trim();
    if (reasonPrimary) inc(noneReasonCounts, reasonPrimary);
    for (const b of safeArray(c?.storage_blockers).map(toStr).filter(Boolean)) inc(noneBlockerCounts, b);
  }
  return {
    det_storage_none_full: noneFull,
    det_storage_none_full_n: noneFull.length,
    det_storage_none_full_reason_counts: noneReasonCounts,
    det_storage_none_full_blocker_counts: noneBlockerCounts,
  };
}

function applyTier3PairSuppression({
  selected,
  suppressed,
  contradictionPairs,
  stableKey: sk,
  pushBounded: pb,
  hasTitleOrOpEvidence: htoe,
  buildSelectedCanonicalIndex,
  annotateSuppressedDropReason,
}) {
  let tier3_pair_suppressed_n = 0;
  const tier3_pair_suppressed_samples = [];

  if (contradictionPairs <= 0 || selected.length < 2) {
    return { tier3_pair_suppressed_n, tier3_pair_suppressed_samples };
  }

  const byCat = {};
  for (const s of selected) {
    const cat = toStr(s.category) || 'unknown';
    if (!byCat[cat]) byCat[cat] = [];
    byCat[cat].push(s);
  }
  const keepSelected = [];
  const movedToSuppressed = [];
  for (const cat of Object.keys(byCat)) {
    const arr = byCat[cat].slice().sort((a, b) => {
      const ds = (b.det_score ?? 0) - (a.det_score ?? 0);
      if (ds !== 0) return ds;
      const ak = sk(a);
      const bk = sk(b);
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    });
    if (arr.length < 2) {
      keepSelected.push(...arr);
      continue;
    }
    const top1 = arr[0];
    const top2 = arr[1];
    const top1HasTO = htoe(top1.evidence);
    const top2HasTO = htoe(top2.evidence);
    if (top1HasTO && !top2HasTO) {
      tier3_pair_suppressed_n += 1;
      const moved = { ...top2 };
      delete moved.det_selected_reason;
      moved.det_suppressed_reason = 'suppress:tier3_pair_correction_suppressed';
      movedToSuppressed.push(moved);
      keepSelected.push(top1, ...arr.slice(2));
      pb(tier3_pair_suppressed_samples, { category: cat, top1: sk(top1), top2: sk(top2), top1_has_title_op: true, top2_has_title_op: false, contradiction_pairs: contradictionPairs }, 10);
    } else {
      keepSelected.push(...arr);
    }
  }
  selected.length = 0;
  selected.push(...keepSelected);
  const newSelectedIndex = buildSelectedCanonicalIndex(keepSelected);
  for (const m of movedToSuppressed) annotateSuppressedDropReason(m, newSelectedIndex);
  suppressed.push(...movedToSuppressed);
  selected.sort((a, b) => {
    const ds = (b.det_score ?? 0) - (a.det_score ?? 0);
    if (ds !== 0) return ds;
    const ak = sk(a);
    const bk = sk(b);
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });

  return { tier3_pair_suppressed_n, tier3_pair_suppressed_samples };
}

module.exports = {
  applyTier3PairSuppression,
  cloneBoundedCandidateSample,
  buildRichSamplePools,
  buildFullNoneTruthBundle,
};

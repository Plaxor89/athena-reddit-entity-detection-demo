// scoreSuppressLaneTelemetry.js — selected/suppressed canonical index, storage recomputation, drop reasons.
// Extracted from scoreSuppressLane.js (structure only; behavior frozen).

const { stableKey } = require('./scoreSuppressLanePolicy');
const {
  safeArray,
  hasTitleOrOpEvidence,
  hasCommentEvidence,
  prefixOf,
} = require('./scoreSuppressLaneCandidateHelpers');

function toStr(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

function inc(obj, key, by = 1) {
  obj[key] = (obj[key] || 0) + by;
}

function pushBounded(arr, obj, cap) {
  if (arr.length < cap) arr.push(obj);
}

function buildSelectedCanonicalIndex(selectedArr) {
  const idx = {};
  for (const c of safeArray(selectedArr)) {
    const slug = toStr(c?.canonical_slug);
    if (!slug) continue;
    if (!idx[slug]) idx[slug] = { RAG_OK: 0, CONTEXT_ONLY: 0, NONE: 0, det_selected_any: 0, persisted_any: 0 };
    const intent = toStr(c?.storage_intent || 'NONE');
    if (intent === 'RAG_OK' || intent === 'CONTEXT_ONLY' || intent === 'NONE') idx[slug][intent] += 1;
    idx[slug].det_selected_any += 1;
    if (intent === 'RAG_OK' || intent === 'CONTEXT_ONLY') idx[slug].persisted_any += 1;
  }
  return idx;
}

/**
 * Recompute storage_intent_counts, storage_block_reason_counts, and storage_samples from selected only.
 * Aligns with n8n: run after applySubjectStrengthTierLaneMapping so counts/samples reflect post-mapping state.
 */
function recomputeSelectedStorageTelemetry(selected) {
  const counts = { RAG_OK: 0, CONTEXT_ONLY: 0, NONE: 0 };
  const blockers = {};
  const samples = { RAG_OK: [], CONTEXT_ONLY: [], NONE: [] };
  for (const c of safeArray(selected)) {
    const intent = toStr(c?.storage_intent).toUpperCase();
    if (intent === 'RAG_OK' || intent === 'CONTEXT_ONLY' || intent === 'NONE') counts[intent] = (counts[intent] || 0) + 1;
    else counts.NONE = (counts.NONE || 0) + 1;
    for (const r of safeArray(c?.storage_reasons)) {
      if (toStr(r).startsWith('storage:block_')) inc(blockers, toStr(r));
    }
    const bucket = intent === 'RAG_OK' || intent === 'CONTEXT_ONLY' || intent === 'NONE' ? intent : 'CONTEXT_ONLY';
    const ev = safeArray(c?.evidence);
    pushBounded(samples[bucket], {
      key: stableKey(c),
      storage_intent: intent || 'NONE',
      storage_reasons: safeArray(c?.storage_reasons).slice(0, 7),
      lane: c?.det_lane || null,
      has_title_op: hasTitleOrOpEvidence(ev),
      comment_only: hasCommentEvidence(ev) && !hasTitleOrOpEvidence(ev),
      topicality_strong: c?.det_topicality_strong === true,
    }, 10);
  }
  return { counts, blockers, samples };
}

function sameCanonicalLegacyIntent(summary) {
  const s = summary && typeof summary === 'object' ? summary : {};
  if (Number(s.RAG_OK || 0) > 0) return 'RAG_OK';
  if (Number(s.CONTEXT_ONLY || 0) > 0) return 'CONTEXT_ONLY';
  if (Number(s.det_selected_any || 0) > 0) return 'SELECTED';
  return null;
}

function sameCanonicalDetIntent(summary) {
  const s = summary && typeof summary === 'object' ? summary : {};
  if (Number(s.RAG_OK || 0) > 0) return 'RAG_OK';
  if (Number(s.CONTEXT_ONLY || 0) > 0) return 'CONTEXT_ONLY';
  if (Number(s.NONE || 0) > 0) return 'NONE';
  if (Number(s.det_selected_any || 0) > 0) return 'SELECTED';
  return null;
}

function buildSameCanonicalCompetitionSummary(summary) {
  const s = summary && typeof summary === 'object' ? summary : {};
  return {
    det_selected_any: Number(s.det_selected_any || 0),
    persisted_any: Number(s.persisted_any || 0),
    storage_counts: { RAG_OK: Number(s.RAG_OK || 0), CONTEXT_ONLY: Number(s.CONTEXT_ONLY || 0), NONE: Number(s.NONE || 0) },
  };
}

function annotateSuppressedDropReason(outCand, selectedCanonicalIndex) {
  const slug = toStr(outCand?.canonical_slug);
  const selectedSummary = selectedCanonicalIndex[slug] || { RAG_OK: 0, CONTEXT_ONLY: 0, NONE: 0, det_selected_any: 0, persisted_any: 0 };
  const legacySelectedElsewhereIntent = sameCanonicalLegacyIntent(selectedSummary);
  const detSelectedElsewhereIntent = sameCanonicalDetIntent(selectedSummary);
  const persistedElsewhereIntent = Number(selectedSummary.RAG_OK || 0) > 0 ? 'RAG_OK' : (Number(selectedSummary.CONTEXT_ONLY || 0) > 0 ? 'CONTEXT_ONLY' : null);
  const detSelectedElsewhere = Number(selectedSummary.det_selected_any || 0) > 0;
  const persistedElsewhere = Number(selectedSummary.persisted_any || 0) > 0;
  const storageReasons = safeArray(outCand?.storage_reasons).map(toStr).filter(Boolean);
  const ev = safeArray(outCand?.evidence);
  const hasTitleOp = hasTitleOrOpEvidence(ev);
  const commentOnly = outCand?.evidence_summary?.comment_only === true || (hasCommentEvidence(ev) && !hasTitleOp);
  let dropPrimary = '';
  let family = '';
  let competitionReason = null;
  if (detSelectedElsewhereIntent) {
    competitionReason = `same_canonical_selected_elsewhere:${legacySelectedElsewhereIntent}`;
    dropPrimary = competitionReason;
    family = 'selection_competition';
  } else if (toStr(outCand?.det_suppressed_reason)) {
    dropPrimary = toStr(outCand.det_suppressed_reason);
    family = prefixOf(dropPrimary);
  } else {
    const storageBlock = storageReasons.find((r) => toStr(r).startsWith('storage:block_'));
    if (storageBlock) { dropPrimary = storageBlock; family = 'storage_block'; }
    else if (commentOnly) { dropPrimary = 'shadow:comment_only_tail'; family = 'comment_tail'; }
    else if (toStr(outCand?.category).match(/^(role|mode|rank|platform|queue)$/i) && !hasTitleOp) { dropPrimary = 'shadow:concept_tail_low_context'; family = 'concept_tail'; }
    else if (storageReasons.includes('storage:none_not_selected')) { dropPrimary = 'shadow:none_not_selected'; family = 'shadow'; }
    else { dropPrimary = 'shadow:no_explicit_reason_surface'; family = 'shadow'; }
  }
  const trace = [];
  if (competitionReason) trace.push(competitionReason);
  if (toStr(outCand?.det_suppressed_reason)) trace.push(toStr(outCand.det_suppressed_reason));
  for (const r of storageReasons) {
    if (trace.length >= 3) break;
    if (!trace.includes(r)) trace.push(r);
  }
  outCand.same_canonical_det_selected_elsewhere = detSelectedElsewhere;
  outCand.same_canonical_det_selected_elsewhere_intent = detSelectedElsewhereIntent || null;
  outCand.same_canonical_persisted_elsewhere = persistedElsewhere;
  outCand.same_canonical_persisted_elsewhere_intent = persistedElsewhereIntent || null;
  outCand.same_canonical_selected_elsewhere = detSelectedElsewhere;
  outCand.same_canonical_selected_elsewhere_intent = legacySelectedElsewhereIntent || null;
  outCand.same_canonical_competition_summary = buildSameCanonicalCompetitionSummary(selectedSummary);
  outCand.selection_competition_scope = competitionReason ? 'deterministic_selection' : null;
  outCand.selection_competition_reason_detail = detSelectedElsewhereIntent ? `same_canonical_det_selected_elsewhere:${detSelectedElsewhereIntent}` : null;
  outCand.selection_competition_reason = competitionReason;
  outCand.drop_reason_primary = dropPrimary;
  outCand.drop_reason_family = family || prefixOf(dropPrimary);
  outCand.drop_explanation_trace = trace;
}

module.exports = {
  buildSelectedCanonicalIndex,
  recomputeSelectedStorageTelemetry,
  annotateSuppressedDropReason,
};

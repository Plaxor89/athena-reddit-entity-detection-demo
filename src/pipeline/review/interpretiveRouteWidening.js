/**
 * Narrow interpretive LMM widening (route-only; does not touch deterministic posture).
 * Predicate families validated on the 200-item posture-review export — tightened variant
 * without cross-title (Marvel Rivals) routing.
 *
 * @see docs/LANE_AND_STORAGE_POLICY.md — buildReviewDecision owns review routing.
 */

const { DEFAULT_MAX_LMM_REVIEW_CANDIDATES_PER_POST } = require('./resolveReviewConstants');

function isObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}
function safeArray(x) {
  return Array.isArray(x) ? x : [];
}
function toStr(v) {
  return v === null || v === undefined ? '' : String(v);
}

function postTitleRaw(j) {
  if (!isObject(j?.detect) || !isObject(j.detect.sources)) return '';
  const t = j.detect.sources.title;
  if (typeof t === 'string') return t;
  if (t && typeof t.raw === 'string') return t.raw;
  return '';
}

function ragDbg(j) {
  if (isObject(j?.score_suppress_lane_meta?.rag_centrality_debug_summary)) {
    return j.score_suppress_lane_meta.rag_centrality_debug_summary;
  }
  if (isObject(j?.rag_centrality_debug_summary)) return j.rag_centrality_debug_summary;
  return {};
}

function selectedLen(j) {
  return safeArray(j.det_selected_pre).length;
}

/** Promoted posture only — not reviewer reinterpretation of RAW_ONLY / NO_DETECTION. */
function wideningPostureOk(j) {
  const si = toStr(j.deterministic_storage_intent).toUpperCase();
  if (si !== 'RAG_OK' && si !== 'CONTEXT_ONLY') return false;
  if (toStr(j.deterministic_detection_outcome) === 'NO_DETECTION') return false;
  return true;
}

/** Block widening only when every promoted row is det-safe (hands-off); mixed profiles may still merit interpretive routing. */
function allSelectedDetSafeBlocksReview(j) {
  const sel = safeArray(j.det_selected_pre);
  if (!sel.length) return false;
  return sel.every((c) => c?.det_safe_blocks_review === true);
}

/** Title-driven comparison signals (tightened — avoids "playing against it" style noise). */
const COMPARE_TITLE_RE =
  /\bvs\.?\b|versus|\bpick [\w\s'-]{3,50} over\b|compared to|better than|\bVS\b|matchup|skins we got|theme for/i;

function explicitComparisonTitleAndDbg(titleText, dbg) {
  const t = toStr(titleText);
  if (!t.trim()) return false;
  if (COMPARE_TITLE_RE.test(t)) return true;
  if (dbg.dbg_title_explicit_comparison_like !== true) return false;
  const tlow = t.toLowerCase();
  return (
    /\bvs\.?\b|versus|pick .{3,50} over|skins we got|theme for|matchup/i.test(t) ||
    /\b(junker|rein|bap|kiri|hero|perk|skin|tank|duel|jq|ana|mercy|baptiste|kiriko)\b/i.test(tlow)
  );
}

function isPatchUpdateBundle(j) {
  const n = selectedLen(j);
  const dbg = ragDbg(j);
  const bundle = dbg.dbg_is_broad_bundle_or_gallery === true;
  const newsish = dbg.dbg_is_news_update_shape === true;
  const t = postTitleRaw(j).toLowerCase();
  const titlePatch = /patch note|mid-season|retail patch|update -|hero update/i.test(t);
  if (!bundle) return false;
  if (n >= 10 && (newsish || titlePatch)) return true;
  if (n >= 8 && titlePatch) return true;
  return false;
}

function isCrossoverSkinBundle(j) {
  const n = selectedLen(j);
  if (n < 4) return false;
  const t = postTitleRaw(j).toLowerCase();
  const cross = /nier|automata|crossover|collab|\boverwatch x\b| x nier/i.test(t);
  const skin = /skin|skins|cosmetic|2b -|a2 -/i.test(t);
  return cross && skin;
}

function isMetaStatMulti(j) {
  const si = toStr(j.deterministic_storage_intent).toUpperCase();
  if (si !== 'CONTEXT_ONLY') return false;
  const dbg = ragDbg(j);
  if (dbg.dbg_is_broad_bundle_or_gallery !== true) return false;
  const n = selectedLen(j);
  if (n < 6) return false;
  const ragN = Number(dbg.dbg_rag_candidate_n ?? 0);
  return ragN >= 4;
}

function isExplicitComparison(j) {
  return explicitComparisonTitleAndDbg(postTitleRaw(j), ragDbg(j));
}

const FAMILY_PREDICATES = [
  ['patch_bundle', isPatchUpdateBundle],
  ['crossover_skins', isCrossoverSkinBundle],
  ['meta_stat_multi', isMetaStatMulti],
  ['explicit_comparison', isExplicitComparison],
];

/**
 * @param {object} j - score + slot + gating merged item (same shape as evaluateRoutePatch input)
 * @returns {{ family: string, candidates: object[] } | null}
 */
function evaluateInterpretiveRouteWidening(j) {
  if (!isObject(j)) return null;
  if (!wideningPostureOk(j)) return null;
  if (selectedLen(j) < 1) return null;
  if (allSelectedDetSafeBlocksReview(j)) return null;

  const cap = DEFAULT_MAX_LMM_REVIEW_CANDIDATES_PER_POST;
  const candidates = safeArray(j.det_selected_pre).slice(0, cap);

  for (const [family, pred] of FAMILY_PREDICATES) {
    if (pred(j)) return { family, candidates };
  }
  return null;
}

module.exports = {
  evaluateInterpretiveRouteWidening,
};

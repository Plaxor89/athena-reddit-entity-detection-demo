// scoreSuppressLanePolicy.js — item-level policy lane resolution + implementation lane primitives + RAG debug promotion.
// Extracted from scoreSuppressLane.js (structure only; behavior frozen).
//
// Three layers (see docs/LANE_AND_STORAGE_POLICY.md §17): (1) row implementation band HARD|HIGH|SOFT|SHADOW via laneFor/minLane;
// (2) row storage truth in storageIntent.js; (3) item posture via deterministic_storage_intent (packaged posture).
// deterministic_lane constants here are nested diagnostic/invariant classes, not consumer posture.
// minLane and laneFor embed score cutoffs and lattice order — frozen score-semantic helpers, not cleanup/rename targets.

function isObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function toStr(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function stableKey(c) {
  return `${toStr(c.category)}||${toStr(c.canonical_slug)}||${toStr(c.dictionary_entity_type)}`;
}

const LANE_ORDER = { SHADOW: 0, SOFT: 1, HIGH: 2, HARD: 3 };
const LANE_NAMES = ['SHADOW', 'SOFT', 'HIGH', 'HARD'];

function normalizeLaneName(x) {
  const s = toStr(x).trim().toUpperCase();
  if (!s) return null;
  if (LANE_ORDER[s] !== undefined) return s;
  return null;
}

/**
 * Minimum of two implementation-band names under LANE_ORDER (lower = weaker band). Used only for caps.
 * Frozen score-semantic: changing order or semantics changes promotion boundaries — not a casual refactor target.
 */
function minLane(a, b) {
  const aa = normalizeLaneName(a);
  const bb = normalizeLaneName(b);
  if (!aa) return bb;
  if (!bb) return aa;
  return LANE_NAMES[Math.min(LANE_ORDER[aa], LANE_ORDER[bb])];
}

/**
 * Maps clamped score + ceiling maxLane to row implementation band (det_lane). Thresholds inside are score-semantic.
 * Frozen helper: not naming cleanup — altering cutoffs changes who is SHADOW vs HARD, etc.
 */
function laneFor(score, maxLane) {
  let lane = 'HIGH';
  if (score >= 0.85) lane = 'HARD';
  else if (score >= 0.65) lane = 'HIGH';
  else if (score >= 0.40) lane = 'SOFT';
  else lane = 'SHADOW';

  const maxOrd = LANE_ORDER[normalizeLaneName(maxLane)] ?? LANE_ORDER.HIGH;
  const capped = LANE_NAMES[Math.min(LANE_ORDER[lane], maxOrd)];
  return capped;
}

// docs/LANE_AND_STORAGE_POLICY.md — adopted lane + storage-intent vocabulary (exact strings).
const POLICY_LANE_HARD_ELIGIBLE = 'HARD_ELIGIBLE';
const POLICY_LANE_SOFT_ELIGIBLE = 'SOFT_ELIGIBLE';
const POLICY_LANE_SHADOW = 'SHADOW';
const POLICY_STORAGE_RAG_OK = 'RAG_OK';
const POLICY_STORAGE_CONTEXT_ONLY = 'CONTEXT_ONLY';
const POLICY_STORAGE_RAW_ONLY = 'RAW_ONLY';

const POLICY_LANE_RANK = {
  [POLICY_LANE_SHADOW]: 0,
  [POLICY_LANE_SOFT_ELIGIBLE]: 1,
  [POLICY_LANE_HARD_ELIGIBLE]: 2,
};

/** Maps row implementation band (det_lane) → policy class for deterministic_lane summary (diagnostic, not packaged posture). */
function policyLaneClassFromDetLane(detLane) {
  const L = normalizeLaneName(detLane);
  if (L === 'HARD') return POLICY_LANE_HARD_ELIGIBLE;
  if (L === 'HIGH' || L === 'SOFT') return POLICY_LANE_SOFT_ELIGIBLE;
  if (L === 'SHADOW') return POLICY_LANE_SHADOW;
  return null;
}

/**
 * Strongest policy class from final selected rows (assigned to deterministic_lane: HARD_ELIGIBLE | SOFT_ELIGIBLE | SHADOW).
 * That output is nested diagnostic/invariant vocabulary — not the consumer posture field (posture); pair with
 * deterministic_storage_intent / storage recounts for item truth. No silent fallbacks — if any row cannot
 * resolve a valid implementation lane, returns violation (LANE_AND_STORAGE_POLICY.md / tuning).
 */
function resolveDeterministicPolicyLaneFromSelected(selectedRows, postId) {
  if (!Array.isArray(selectedRows) || selectedRows.length === 0) {
    return { policyLane: null, violation: null };
  }
  const badRows = [];
  let best = null;
  let bestR = -1;
  for (const c of selectedRows) {
    let implLane = normalizeLaneName(c?.det_lane);
    if (
      !implLane &&
      Number.isFinite(Number(c?.det_score)) &&
      toStr(c?.det_max_lane).trim() !== ''
    ) {
      implLane = laneFor(clamp(Number(c.det_score), 0, 1), c.det_max_lane);
    }
    if (!implLane || LANE_ORDER[implLane] === undefined) {
      badRows.push({
        stable_key: stableKey(c),
        det_lane: c?.det_lane ?? null,
        det_score: c?.det_score ?? null,
        det_max_lane: c?.det_max_lane ?? null,
      });
      continue;
    }
    const p = policyLaneClassFromDetLane(implLane);
    if (!p || POLICY_LANE_RANK[p] === undefined) {
      badRows.push({
        stable_key: stableKey(c),
        det_lane: c?.det_lane ?? null,
        resolved_impl_lane: implLane,
        reason: 'implementation_lane_maps_to_no_policy_class',
      });
      continue;
    }
    const r = POLICY_LANE_RANK[p];
    if (r > bestR) {
      bestR = r;
      best = p;
    }
  }
  if (badRows.length > 0) {
    return {
      policyLane: null,
      violation: {
        code: 'DETERMINISTIC_POLICY_LANE_INVARIANT_FAILED',
        message:
          'Selected row(s) lack a resolvable implementation lane (det_lane or det_score+det_max_lane → HARD|HIGH|SOFT|SHADOW).',
        post_id: postId != null ? toStr(postId) : null,
        rows: badRows,
      },
    };
  }
  if (bestR < 0) {
    return {
      policyLane: null,
      violation: {
        code: 'DETERMINISTIC_POLICY_LANE_INVARIANT_FAILED',
        message: 'Selected pool non-empty but no policy lane was derived.',
        post_id: postId != null ? toStr(postId) : null,
        rows: [],
      },
    };
  }
  return { policyLane: best, violation: null };
}

/**
 * LANE_AND_STORAGE_POLICY.md §6 — item-level invariant (lane dictates storage at service-policy layer).
 * HARD_ELIGIBLE↔RAG_OK, SOFT_ELIGIBLE↔CONTEXT_ONLY, SHADOW↔RAW_ONLY.
 */
function policyStorageIntentInvariantForLane(laneClass) {
  if (laneClass === POLICY_LANE_HARD_ELIGIBLE) return POLICY_STORAGE_RAG_OK;
  if (laneClass === POLICY_LANE_SOFT_ELIGIBLE) return POLICY_STORAGE_CONTEXT_ONLY;
  if (laneClass === POLICY_LANE_SHADOW) return POLICY_STORAGE_RAW_ONLY;
  return null;
}

/** n8n promotes only these keys from rag_centrality_debug_summary to top level; post_shape stays nested */
const RAG_DEBUG_PROMOTED_KEYS = [
  'dbg_is_broad_review_or_impressions',
  'dbg_is_general_topic_with_entity_examples',
  'dbg_is_direct_question_shape',
  'dbg_is_stat_meta_shape',
  'dbg_is_help_howto_shape',
  'dbg_is_news_update_shape',
  'dbg_has_entity_title_head',
  'dbg_has_answer_slot_subject',
  'dbg_broad_shape_trigger_sources',
  'dbg_direct_subject_trigger_sources',
  'dbg_title_primary_trigger_sources',
  'hero_primary_cardinality_dbg',
  'hero_primary_keep_n_dbg',
  'hero_primary_cap_reason_dbg',
  'multi_hero_resolver_needed_dbg',
  'hero_primary_candidates_dbg',
];
const RAG_DEBUG_ARRAY_KEYS = new Set(['dbg_broad_shape_trigger_sources', 'dbg_direct_subject_trigger_sources', 'dbg_title_primary_trigger_sources', 'hero_primary_candidates_dbg']);

function explicitRagCentralityDebugKeys(dbg) {
  const out = {};
  for (const k of RAG_DEBUG_PROMOTED_KEYS) {
    const v = isObject(dbg) && k in dbg ? dbg[k] : undefined;
    out[k] = Array.isArray(v) ? v : (RAG_DEBUG_ARRAY_KEYS.has(k) ? [] : (v ?? null));
  }
  return out;
}

module.exports = {
  isObject,
  toStr,
  clamp,
  stableKey,
  LANE_ORDER,
  LANE_NAMES,
  normalizeLaneName,
  minLane,
  laneFor,
  POLICY_LANE_HARD_ELIGIBLE,
  POLICY_LANE_SOFT_ELIGIBLE,
  POLICY_LANE_SHADOW,
  POLICY_STORAGE_RAG_OK,
  POLICY_STORAGE_CONTEXT_ONLY,
  POLICY_STORAGE_RAW_ONLY,
  POLICY_LANE_RANK,
  policyLaneClassFromDetLane,
  resolveDeterministicPolicyLaneFromSelected,
  policyStorageIntentInvariantForLane,
  RAG_DEBUG_PROMOTED_KEYS,
  RAG_DEBUG_ARRAY_KEYS,
  explicitRagCentralityDebugKeys,
};

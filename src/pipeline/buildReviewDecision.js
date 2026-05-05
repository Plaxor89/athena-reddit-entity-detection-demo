// buildReviewDecision.js
//
// Semantic authority for review routing after scoreSuppressLane.
// Minimal v0 authority contract only; optional debug is omitted by default.

const { resolveReviewConstants, getCollisionsRegistry } = require('./review/resolveReviewConstants');
const { buildSlotStagePatch } = require('./review/slotStage');
const { applyReviewShortlistGatingPatch } = require('./review/gatingStage');
const { evaluateRoutePatch } = require('./review/routeDecision');

function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

/**
 * Deep clone request item via JSON (sufficient for pipeline objects; avoids mutating caller score output).
 * @param {object} scoreOutput
 */
function cloneScoreOutput(scoreOutput) {
  try {
    return JSON.parse(JSON.stringify(scoreOutput));
  } catch {
    return { ...scoreOutput };
  }
}

function mergeReviewReasonCodes({ gateReasonCode, slotReasonKeys, postGateCandidates }) {
  const set = new Set();
  const gc = String(gateReasonCode || '').trim();
  if (gc) set.add(gc);
  for (const k of slotReasonKeys || []) {
    const s = String(k || '').trim();
    if (s) set.add(s);
  }
  for (const c of postGateCandidates || []) {
    const rr = c?.review_meta?.review_reason;
    if (rr) set.add(String(rr).trim());
  }
  return Array.from(set).filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function toRouteBlockersMinimal(blockedBy) {
  if (!Array.isArray(blockedBy)) return [];
  return blockedBy
    .map((b) => {
      const reason_code = String(b.reason_code || '').trim();
      if (!reason_code) return null;
      const familyRaw = b.family != null ? String(b.family).trim() : '';
      const out = { reason_code };
      if (familyRaw) out.family = familyRaw;
      return out;
    })
    .filter(Boolean);
}

function toStableKey(c) {
  return `${String(c?.category ?? '')}||${String(c?.canonical_slug ?? '')}||${String(c?.dictionary_entity_type ?? '')}`;
}

/**
 * @param {object} scoreOutput - scoreSuppressLane output for one item
 * @param {object} policyBundle - from loadPolicyBundle()
 * @returns {object} minimal v0 review decision authority
 */
function buildReviewDecision(scoreOutput, policyBundle) {
  const j = cloneScoreOutput(scoreOutput);
  const constants = resolveReviewConstants(policyBundle);
  const collisions = getCollisionsRegistry(policyBundle);

  Object.assign(j, buildSlotStagePatch(j, collisions, constants));
  Object.assign(j, applyReviewShortlistGatingPatch(j));
  Object.assign(j, evaluateRoutePatch(j));

  const postGate = safeArray(j.lmm_review_candidates_pre);
  const rd = j.route_decision && typeof j.route_decision === 'object' ? j.route_decision : {};
  const actionable = j.needs_lmm_review === true;

  const detSelectedN = Array.isArray(j.det_selected_pre) ? j.det_selected_pre.length : 0;
  const should_route_review = actionable === true;
  const should_route_deterministic = actionable !== true && detSelectedN > 0;
  /** What the orchestrator should do next — not item-level policy posture (lane/storage). */
  const downstream_action = should_route_review
    ? 'review'
    : should_route_deterministic
      ? 'deterministic_followup'
      : 'no_further_action';

  const slotKeys = safeArray(j.lmm_review_reason_codes_pre?.keys);

  const review_shortlist = postGate.map((c) => {
    const stable_key = toStableKey(c);
    const meta = c.review_gating_meta && typeof c.review_gating_meta === 'object' ? c.review_gating_meta : {};
    const row = { stable_key };
    if (meta.review_gate_decision != null && String(meta.review_gate_decision).trim() !== '') {
      row.review_gate_decision = String(meta.review_gate_decision);
    }
    if (meta.review_survived_gating === true || meta.review_survived_gating === false) {
      row.review_survived_gating = meta.review_survived_gating;
    }
    return row;
  });

  const review_reason_codes = mergeReviewReasonCodes({
    gateReasonCode: rd.reason_code,
    slotReasonKeys: slotKeys,
    postGateCandidates: postGate,
  });

  const route_blockers = actionable ? [] : toRouteBlockersMinimal(safeArray(rd.blocked_by));

  return {
    review_decision_contract_version: '2026-03-26.minimal-v2',
    needs_lmm_review: actionable,
    should_route_review,
    should_route_deterministic,
    downstream_action,
    review_reason_codes,
    route_worthy: rd.route_worthy === true,
    route_primary_reason_code: actionable ? null : (rd.route_drop_reason_primary != null ? String(rd.route_drop_reason_primary) : null),
    route_primary_reason_family: actionable ? null : (rd.route_drop_reason_family != null ? String(rd.route_drop_reason_family) : null),
    route_blockers,
    review_shortlist,
  };
}

module.exports = {
  buildReviewDecision,
};

// buildDownstreamContract.js
//
// Packaging only.
// Preserves full authoritative upstream outputs and exposes a cleaner
// one-item-per-post contract for single-item callers.
// No business logic, no re-scoring, no re-routing, no lane/storage recompute.
// downstream_action mirrors review: next workflow step, not lane/storage posture.
// Legacy lane-first summary (deterministic_lane) lives only under nested deterministic.

/**
 * @param {unknown} x
 * @returns {object}
 */
function deepCloneJson(x) {
  try {
    return JSON.parse(JSON.stringify(x));
  } catch {
    return x !== null && typeof x === 'object' ? { ...x } : {};
  }
}

function normalizeHandoffArray(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

function postIdFromScore(score) {
  if (!score || typeof score !== 'object') return null;
  return score.post_id ?? score.id ?? null;
}

function reviewShortlistFromReview(review) {
  if (!review || typeof review !== 'object') return [];
  if (Array.isArray(review.review_shortlist)) return deepCloneJson(review.review_shortlist);
  if (Array.isArray(review.lmm_review_candidates)) return deepCloneJson(review.lmm_review_candidates);
  return [];
}

function buildPerPostContract(score, review) {
  const deterministic = deepCloneJson(score);
  const reviewDecision = deepCloneJson(review);
  const mirroredDeterministicStorageIntent =
    typeof score.deterministic_storage_intent === 'string' ? score.deterministic_storage_intent : null;

  return {
    contract_version: 'detector.downstream.v3',
    post_id: postIdFromScore(score),

    posture: mirroredDeterministicStorageIntent,
    storage_intent: mirroredDeterministicStorageIntent,
    deterministic_detection_outcome:
      typeof score.deterministic_detection_outcome === 'string'
        ? score.deterministic_detection_outcome
        : null,
    deterministic_selected_count: Array.isArray(score.det_selected_pre) ? score.det_selected_pre.length : 0,
    needs_lmm_review: reviewDecision?.needs_lmm_review === true,
    review_shortlist: reviewShortlistFromReview(reviewDecision),
    should_route_review: reviewDecision?.should_route_review === true,
    should_route_deterministic: reviewDecision?.should_route_deterministic === true,
    downstream_action:
      typeof reviewDecision?.downstream_action === 'string'
        ? reviewDecision.downstream_action
        : 'no_further_action',
    deterministic_policy_invariant_violation:
      score.deterministic_policy_invariant_violation != null &&
      typeof score.deterministic_policy_invariant_violation === 'object'
        ? deepCloneJson(score.deterministic_policy_invariant_violation)
        : null,
    deterministic_item_explanation:
      score.deterministic_item_explanation != null && typeof score.deterministic_item_explanation === 'object'
        ? deepCloneJson(score.deterministic_item_explanation)
        : null,

    // preserve full upstream authority outputs
    deterministic,
    review: reviewDecision,
  };
}

/**
 * @param {object} downstreamHandoff
 * @param {object|object[]} downstreamHandoff.scoreSuppressLane
 * @param {object|object[]} downstreamHandoff.buildReviewDecision
 * @returns {object}
 */
function buildDownstreamContract(downstreamHandoff) {
  const h = downstreamHandoff && typeof downstreamHandoff === 'object' ? downstreamHandoff : {};
  const scores = normalizeHandoffArray(h.scoreSuppressLane);
  const reviews = normalizeHandoffArray(h.buildReviewDecision);

  if (scores.length !== reviews.length) {
    throw new Error(
      `buildDownstreamContract: scoreSuppressLane length (${scores.length}) !== buildReviewDecision length (${reviews.length})`,
    );
  }

  const items = scores.map((score, i) => buildPerPostContract(score, reviews[i]));

  if (items.length === 1) {
    return items[0];
  }

  return {
    contract_version: 'detector.downstream.v3',
    meta: {
      is_batch: true,
      item_count: items.length,
    },
    items,
  };
}

module.exports = {
  buildDownstreamContract,
};
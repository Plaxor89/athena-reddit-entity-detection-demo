/**
 * Central defaults for review slot/gating/route (n8n policy_constants analogue).
 * Future: read from policyBundle.policyMeta.review_constants when present.
 */

const DEFAULT_SHORTLIST_PER_CATEGORY = 3;
const DEFAULT_MAX_LMM_REVIEW_CANDIDATES_PER_POST = 6;
const DEFAULT_AMBIGUITY_TOP2_MARGIN_MAX = 0.1;

function isObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

/**
 * Collision registry shape matches score/normalize: policyMeta.alias_collision_registry
 * (n8n Review Slot Builder used policy_bundle.collisions).
 */
function getCollisionsRegistry(policyBundle) {
  const pm = isObject(policyBundle?.policyMeta) ? policyBundle.policyMeta : {};
  return isObject(pm.alias_collision_registry) ? pm.alias_collision_registry : {};
}

/**
 * @param {object} policyBundle
 * @returns {{ perCatCap: number, totalCap: number, marginMax: number }}
 */
function resolveReviewConstants(policyBundle) {
  const pm = isObject(policyBundle?.policyMeta) ? policyBundle.policyMeta : {};
  const rc = isObject(pm.review_constants) ? pm.review_constants : {};

  const perCat = Number(rc.shortlist_per_category);
  const total = Number(rc.max_lmm_review_candidates_per_post);
  const margin = Number(rc.ambiguity_top2_margin_max);

  return {
    perCatCap: Number.isFinite(perCat) ? perCat : DEFAULT_SHORTLIST_PER_CATEGORY,
    totalCap: Number.isFinite(total) ? total : DEFAULT_MAX_LMM_REVIEW_CANDIDATES_PER_POST,
    marginMax: Number.isFinite(margin) ? margin : DEFAULT_AMBIGUITY_TOP2_MARGIN_MAX,
  };
}

module.exports = {
  resolveReviewConstants,
  getCollisionsRegistry,
  DEFAULT_SHORTLIST_PER_CATEGORY,
  DEFAULT_MAX_LMM_REVIEW_CANDIDATES_PER_POST,
  DEFAULT_AMBIGUITY_TOP2_MARGIN_MAX,
};

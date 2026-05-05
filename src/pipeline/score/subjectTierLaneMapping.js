// subjectTierLaneMapping.js - Subject strength tier → row storage rewrites (historical "lane" in the name only).
// Ports applySubjectStrengthTierLaneMapping from n8n Det Score + Suppress + Lane.
// Rewrites row storage truth (storage_intent, storage_reasons, storage_* dbg) for protected candidates; does not
// recompute det_lane / implementation band. scoreSuppressLane later recomputes storage telemetry and item
// deterministic_storage_intent after this pass; this module only adjusts per-row storage for subject tiers
// (see LANE_AND_STORAGE_POLICY.md §17).

const { annotateStorageExplanationBundle } = require('./storageIntent');
const { annotateLaneAuditBundle } = require('./laneAudit');
const {
  annotateSubjecthoodBundle,
  extractStorageHardBlockers,
  deriveFallbackSubjecthoodTier,
  candidateHasSubjecthoodHighRiskBypass,
  candidateHasCreatorCreditVisualShowcaseBlock,
  candidateCanRescueDirectGameplayPrimary,
  candidateHasDirectTitleSubjectLockRescue,
  candidateHasBroadResidueDirectPrimaryOverride,
} = require('./subjecthood');
const {
  getDirectSubjectPolicySignals,
  titleNormDirectSubjectQuestionPattern,
} = require('./directSubjectPolicySignals');
const ragCentrality = require('./ragCentrality');
const {
  candidatePolicyRescueBlockReasons,
  candidateEffectivePolicySummary,
  getUpstreamRescueModulation,
  candidateHasDirectAnswerableRescue,
  titleQuestionLike,
} = ragCentrality;

function isObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function toStr(v) {
  return v === null || v === undefined ? '' : String(v);
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

function candidateCategoryLower(c) {
  return toStr(c?.category || c?.entity_type || c?.dictionary_entity_type).toLowerCase();
}

function isProtectedCategory(cat) {
  const c = toStr(cat).toLowerCase();
  return c === 'hero' || c === 'map' || c === 'ability' || c === 'perk';
}

function prefixOf(reason) {
  const s = toStr(reason);
  const i = s.indexOf(':');
  return i > 0 ? s.slice(0, i) : 'other';
}

/**
 * When promoting with subject_hard_primary_high_risk_bypass:
 * - narrow_high_risk_bypass_dbg === true: strip storage:context_only and storage:block_high_risk (minimal output)
 * - narrow_high_risk_bypass_dbg === false: preserve them (authority records full trace)
 */
function applySubjecthoodPromoteToRagOk(target, reasonPrimary = 'storage:rag_ok:subject_hard_primary', itemJson = null) {
  if (!isObject(target)) return target;
  const primary = toStr(reasonPrimary).trim() || 'storage:rag_ok:subject_hard_primary';
  const isHighRiskBypassPromote = reasonPrimary && String(reasonPrimary).includes('high_risk_bypass');
  const keepBareContextAndBlockers =
    isHighRiskBypassPromote &&
    target.narrow_high_risk_bypass_dbg === false;
  const existingReasons = safeArray(target?.storage_reasons)
    .map(toStr)
    .filter(Boolean)
    .filter(
      (r) => {
        if (r.startsWith('storage:rag_ok:') || r.startsWith('storage:context_only:') || r.startsWith('storage:none'))
          return false;
        if (!keepBareContextAndBlockers && (r === 'storage:context_only' || r.startsWith('storage:block_')))
          return false;
        return true;
      }
    );

  target.storage_intent = 'RAG_OK';
  target.storage_reasons = uniqueBoundedStrings(
    [primary, 'storage:rag_ok_topicality_strong', ...existingReasons],
    12
  );

  target.storage_reason_primary = null;
  target.storage_blockers = [];
  target.storage_reason_family = null;
  target.storage_reason_trace = [];
  target.storage_decision_primary = null;
  target.storage_decision_family = null;
  target.storage_blocker_primary = null;
  target.storage_blocker_family = null;

  const existingPath = safeArray(target?.storage_promotion_path_dbg)
    .map(toStr)
    .filter(Boolean)
    .filter(
      (v) =>
        !v.startsWith('storage:rag_ok:') &&
        !v.startsWith('storage:context_only:') &&
        !v.startsWith('storage:none')
    );
  target.storage_promotion_path_dbg = uniqueBoundedStrings(
    [...existingPath, primary, 'subjecthood:tier:HARD_PRIMARY'],
    12
  );

  const existingBlocks = safeArray(target?.storage_block_signals_dbg)
    .map(toStr)
    .filter(Boolean)
    .filter((v) => !v.startsWith('block:subjecthood_'));
  target.storage_block_signals_dbg = uniqueBoundedStrings(existingBlocks, 12);

  annotateStorageExplanationBundle(target);
  annotateLaneAuditBundle(target);
  if (target._annotatePolicyAuditMirrors) target._annotatePolicyAuditMirrors(target);
  return target;
}

function applySubjecthoodContextOnlyRewrite(
  target,
  reasonPrimary = 'storage:context_only:subject_true_secondary',
  profileTag = 'subjecthood_true_secondary'
) {
  if (!isObject(target)) return target;
  const primary = toStr(reasonPrimary).trim() || 'storage:context_only:subject_true_secondary';
  const existingReasons = safeArray(target?.storage_reasons)
    .map(toStr)
    .filter(Boolean)
    .filter(
      (r) =>
        !r.startsWith('storage:rag_ok:') &&
        !r.startsWith('storage:context_only:') &&
        !r.startsWith('storage:none')
    );

  target.storage_intent = 'CONTEXT_ONLY';
  target.storage_reasons = uniqueBoundedStrings([primary, ...existingReasons], 12);
  target.storage_reason_primary = null;
  target.storage_blockers = [];
  target.storage_reason_family = null;
  target.storage_reason_trace = [];
  target.storage_decision_primary = null;
  target.storage_decision_family = null;
  target.storage_blocker_primary = null;
  target.storage_blocker_family = null;

  const existingPath = safeArray(target?.storage_promotion_path_dbg)
    .map(toStr)
    .filter(Boolean)
    .filter(
      (v) =>
        !v.startsWith('storage:rag_ok:') &&
        !v.startsWith('storage:context_only:') &&
        !v.startsWith('storage:none')
    );
  target.storage_promotion_path_dbg = uniqueBoundedStrings(
    [...existingPath, primary, 'subjecthood:tier:TRUE_SECONDARY', `subjecthood:profile:${toStr(profileTag).trim() || 'subjecthood_true_secondary'}`],
    12
  );

  const existingBlocks = safeArray(target?.storage_block_signals_dbg)
    .map(toStr)
    .filter(Boolean)
    .filter((v) => !v.startsWith('block:subjecthood_'));
  target.storage_block_signals_dbg = uniqueBoundedStrings(
    [
      ...existingBlocks,
      'block:subjecthood_tier',
      'block:subjecthood_tier:TRUE_SECONDARY',
      `block:subjecthood_tier_reason:${primary}`,
    ],
    12
  );

  annotateStorageExplanationBundle(target);
  annotateLaneAuditBundle(target);
  if (target._annotatePolicyAuditMirrors) target._annotatePolicyAuditMirrors(target);
  return target;
}

function applySubjecthoodNoneRewrite(target, reasonPrimary = 'storage:none_subjecthood_telemetry_only') {
  if (!isObject(target)) return target;
  const primary = toStr(reasonPrimary).trim() || 'storage:none_subjecthood_telemetry_only';
  const existingReasons = safeArray(target?.storage_reasons)
    .map(toStr)
    .filter(Boolean)
    .filter(
      (r) =>
        !r.startsWith('storage:rag_ok:') &&
        !r.startsWith('storage:context_only:') &&
        !r.startsWith('storage:none') &&
        !['storage:block_lane_soft', 'storage:block_lane_high'].includes(r)
    );

  target.storage_intent = 'NONE';
  target.storage_reasons = uniqueBoundedStrings([primary, ...existingReasons], 12);

  target.storage_reason_primary = null;
  target.storage_blockers = [];
  target.storage_reason_family = null;
  target.storage_reason_trace = [];
  target.storage_decision_primary = null;
  target.storage_decision_family = null;
  target.storage_blocker_primary = null;
  target.storage_blocker_family = null;

  const existingPath = safeArray(target?.storage_promotion_path_dbg)
    .map(toStr)
    .filter(Boolean)
    .filter(
      (v) =>
        !v.startsWith('storage:rag_ok:') &&
        !v.startsWith('storage:context_only:') &&
        !v.startsWith('storage:none')
    );
  target.storage_promotion_path_dbg = uniqueBoundedStrings(
    [...existingPath, primary, 'subjecthood:tier:TELEMETRY_ONLY'],
    12
  );

  const existingBlocks = safeArray(target?.storage_block_signals_dbg)
    .map(toStr)
    .filter(Boolean)
    .filter(
      (v) =>
        !v.startsWith('block:subjecthood_') &&
        !['storage:block_lane_soft', 'storage:block_lane_high'].includes(v)
    );
  target.storage_block_signals_dbg = uniqueBoundedStrings(
    [
      ...existingBlocks,
      'block:subjecthood_tier',
      'block:subjecthood_tier:TELEMETRY_ONLY',
      `block:subjecthood_tier_reason:${primary}`,
    ],
    12
  );

  annotateStorageExplanationBundle(target);
  annotateLaneAuditBundle(target);
  if (target._annotatePolicyAuditMirrors) target._annotatePolicyAuditMirrors(target);
  return target;
}

/**
 * Subject-strength tier mapping: rewrites row storage truth (layer 2) on selected rows for protected categories.
 * Row implementation band (det_lane) is unchanged here; storage may diverge from band after subjecthood authority.
 * Not responsible for setting item posture (layer 3); the same scoreSuppressLane return path recomputes counts and
 * deterministic_storage_intent after subject-tier rewrites.
 *
 * @param {Array} selected - det_selected array
 * @param {object} j - item JSON (detect, post_id, etc.)
 * @param {{ annotatePolicyAuditMirrors?: (target: object) => void }} opts - optional annotatePolicyAuditMirrors
 * @returns {{ changed: boolean, live: boolean }}
 */
function applySubjectStrengthTierLaneMapping(selected, j, opts = {}) {
  let changed = false;
  let live = false;
  const annotatePolicyAuditMirrors = opts.annotatePolicyAuditMirrors || (() => {});

  const legacyContextOnlyReasons = new Set([
    'storage:context_only',
    'storage:context_only:general_topic_example_not_primary',
    'storage:context_only:primary_centrality_insufficient',
    'storage:context_only:broad_bundle_true_secondary',
    'storage:context_only:side_speculation_not_primary',
  ]);

  for (const c of safeArray(selected)) {
    if (!isObject(c)) continue;
    c.subject_tier_lane_mapping_live = false;
    c.subjecthood_authority_applied_dbg = false;
    c.subjecthood_authority_reason_dbg = null;

    const category = candidateCategoryLower(c);
    if (!isProtectedCategory(category)) continue;

    c._annotatePolicyAuditMirrors = annotatePolicyAuditMirrors;
    annotateSubjecthoodBundle(c, j, selected);
    if (!toStr(c.subjecthood_authority_source_dbg).trim()) c.subjecthood_authority_source_dbg = 'subjecthood_authority_live';

    let tier = toStr(c?.subject_strength_tier || c?.subject_strength_tier_dbg);
    if (!tier) {
      const fallbackTier = deriveFallbackSubjecthoodTier(c, j, selected);
      if (fallbackTier) {
        c.subject_strength_tier = fallbackTier;
        c.subject_strength_tier_dbg = fallbackTier;
        c.subjecthood_annotation_present_dbg = true;
        c.subjecthood_authority_source_dbg = 'fallback_subjecthood_tier';
        tier = fallbackTier;
      }
    }
    const signals = getDirectSubjectPolicySignals(j);
    // Title-head / direct-subject question (not policyQuestionAnswerable): aligns with subjecthood high-risk bypass.
    const titleHeadDirectQuestionLike =
      titleNormDirectSubjectQuestionPattern(signals.titleNorm) ||
      titleQuestionLike(signals.titleNorm);
    const broadOpinionReviewLikeThread =
      signals.policyReviewOrOpinionLike === true || signals.broadReviewLike === true;
    const vibecheckOrIdentityFramingTitleHead = /\b(vibecheck|impressions|thoughts on)\b|\bas a\b/i.test(
      signals.titleNorm
    );
    // Matches computeSubjectStrengthTierDbg / subject:question_like_thread — do not treat as pure showcase.
    const questionLikeFromSignals =
      signals.policyQuestionAnswerable === true ||
      signals.upstreamQuestionLike === true ||
      signals.upstreamDirectAnswerablePrior === true;
    const currentIntent = toStr(c?.storage_intent).toUpperCase();
    const primaryReason = toStr(c?.storage_reason_primary || safeArray(c?.storage_reasons).filter(Boolean)[0] || '');
    const hardBlockers = extractStorageHardBlockers(c?.storage_reasons);
    // Centrality demotion writes tokens to storage_promotion_path_dbg, then annotateLaneAuditBundle
    // rebuilds that path and removes them. det_centrality_demotion_applied survives that rebuild.
    const hasCentralityDemotionLatch =
      c?.det_centrality_demotion_applied === true ||
      safeArray(c?.storage_promotion_path_dbg).some((v) => toStr(v).startsWith('centrality_shape:'));
    const broadSecondaryLocked = safeArray(c?.secondary_example_signals).some((v) =>
      [
        'secondary:bundle_thread',
        'secondary:comparison_thread',
        'secondary:co-mentioned_with_multiple_protected_entities',
        'secondary:explicit_secondary_example',
      ].includes(toStr(v))
    );
    const creativeSecondary =
      c?.subject_creative_showcase_dbg === true ||
      safeArray(c?.secondary_example_signals).some((v) =>
        [
          'secondary:creative_showcase_secondary',
          'secondary:creative_showcase_thread',
          'secondary:cosmetic_visual_thread',
          'secondary:visual_presentation_thread',
          'secondary:meme_or_joke_thread',
          'secondary:minimal_media_showcase_title',
        ].includes(toStr(v))
      );
    const genericNoise = c?.subject_generic_common_word_noise_dbg === true;
    const directGameplayPrimaryRescue = candidateCanRescueDirectGameplayPrimary(c, j, selected, signals);

    let survivingHardBlockers = hardBlockers.slice();
    const subjectHighRiskBypass = candidateHasSubjecthoodHighRiskBypass(c, j, selected, signals);
    if (subjectHighRiskBypass) {
      survivingHardBlockers = survivingHardBlockers.filter((r) => r !== 'storage:block_high_risk');
    }

    const markAuthority = (reason) => {
      c.subjecthood_annotation_present_dbg = true;
      if (!toStr(c?.subject_strength_tier || c?.subject_strength_tier_dbg).trim()) {
        const fallbackTier = deriveFallbackSubjecthoodTier(c, j, selected);
        if (fallbackTier) {
          c.subject_strength_tier = fallbackTier;
          c.subject_strength_tier_dbg = fallbackTier;
        }
      }
      c.subjecthood_authority_applied_dbg = true;
      c.subjecthood_authority_reason_dbg = toStr(reason).trim() || null;
      c.subject_tier_lane_mapping_live = true;
      c.subject_showcase_veto_dbg = c.subject_showcase_veto_dbg === true;
      c.direct_gameplay_primary_rescue_dbg = directGameplayPrimaryRescue === true;
      c.direct_title_subject_lock_rescue_dbg = candidateHasDirectTitleSubjectLockRescue(c, j, selected, signals) === true;
      c.direct_answerable_rescue_dbg = candidateHasDirectAnswerableRescue(c, j, signals, selected) === true;
      c.broad_residue_direct_primary_override_dbg = candidateHasBroadResidueDirectPrimaryOverride(c, j, selected, signals) === true;
      c.system_wrapper_primary_demoter_dbg = ragCentrality.candidateHasSystemWrapperChallengeDemoter(c, j, signals) === true;
      const rescueModulation = getUpstreamRescueModulation(signals);
      c.upstream_rescue_modulation_dbg = {
        prior_confidence: rescueModulation.prior_confidence,
        reliability_weight: rescueModulation.reliability_weight,
        dampeners: rescueModulation.dampeners,
        boosters: rescueModulation.boosters,
        net_delta: rescueModulation.net_delta,
        patch_bundle_anti_rescue: rescueModulation.patch_bundle_anti_rescue === true,
        showcase_media_anti_bypass: rescueModulation.showcase_media_anti_bypass === true,
        weak_rescue_blocked: rescueModulation.weak_rescue_blocked === true,
        strong_dampening: rescueModulation.strong_dampening === true,
        reasons: uniqueBoundedStrings(rescueModulation.reasons, 12),
        blockers: uniqueBoundedStrings(rescueModulation.blockers, 8),
      };
      c.creator_credit_showcase_dbg = c.creator_credit_showcase_dbg === true;
      c.effective_candidate_policy_dbg = candidateEffectivePolicySummary(c);
      c.candidate_policy_rescue_block_dbg = candidatePolicyRescueBlockReasons(c, j, signals, { mode: 'authority' });
      changed = true;
      live = true;
    };

    if (genericNoise) {
      if (
        currentIntent === 'RAG_OK' ||
        currentIntent === 'CONTEXT_ONLY' ||
        primaryReason !== 'storage:none_subjecthood_telemetry_only'
      ) {
        applySubjecthoodNoneRewrite(c, 'storage:none_subjecthood_telemetry_only');
        markAuthority('storage:none_subjecthood_telemetry_only');
      }
      continue;
    }

    if (tier === 'HARD_PRIMARY') {
      if (hasCentralityDemotionLatch) continue;
      const creatorCreditVisualBlock = candidateHasCreatorCreditVisualShowcaseBlock(c, j, selected, signals);
      if (
        (creatorCreditVisualBlock || creativeSecondary) &&
        !directGameplayPrimaryRescue &&
        !candidateHasDirectTitleSubjectLockRescue(c, j, selected, signals) &&
        !questionLikeFromSignals &&
        c?.subject_class_a_p6c_creative_carve_dbg !== true
      ) {
        c.subject_showcase_veto_dbg = true;
        const desiredReason = 'storage:context_only:cosmetic_showcase_not_primary';
        const alreadyOwned =
          primaryReason === desiredReason || safeArray(c?.storage_reasons).map(toStr).includes(desiredReason);
        if (currentIntent === 'RAG_OK' || currentIntent === 'CONTEXT_ONLY' || !alreadyOwned) {
          applySubjecthoodContextOnlyRewrite(c, desiredReason, 'creative_showcase_secondary');
          markAuthority(desiredReason);
        }
        continue;
      }
      if (
        broadSecondaryLocked &&
        !subjectHighRiskBypass &&
        !directGameplayPrimaryRescue &&
        currentIntent !== 'RAG_OK'
      )
        continue;
      // Demote title-primary HARD_PRIMARY rows for the same narrow cluster as subjecthood bypass (vibecheck /
      // impressions / “as a … main” heads) when the thread is broad-opinion-shaped and not title-direct question.
      if (broadOpinionReviewLikeThread && !titleHeadDirectQuestionLike && vibecheckOrIdentityFramingTitleHead) {
        const desiredReason = 'storage:context_only:primary_centrality_insufficient';
        const alreadyOwned =
          primaryReason === desiredReason || safeArray(c?.storage_reasons).map(toStr).includes(desiredReason);
        if (currentIntent === 'RAG_OK' || currentIntent === 'CONTEXT_ONLY' || !alreadyOwned) {
          applySubjecthoodContextOnlyRewrite(c, desiredReason, 'broad_opinion_no_title_question');
          markAuthority(desiredReason);
        }
        continue;
      }
      if (survivingHardBlockers.length > 0) continue;

      const desiredReason = subjectHighRiskBypass
        ? 'storage:rag_ok:subject_hard_primary_high_risk_bypass'
        : 'storage:rag_ok:subject_hard_primary';
      const alreadyOwned =
        primaryReason === desiredReason || safeArray(c?.storage_reasons).map(toStr).includes(desiredReason);
      if (currentIntent !== 'RAG_OK' || !alreadyOwned) {
        applySubjecthoodPromoteToRagOk(c, desiredReason, j);
        markAuthority(desiredReason);
      }
      continue;
    }

    if (tier === 'TRUE_SECONDARY') {
      const ragOkSelectedN = safeArray(selected).filter(
        (x) => toStr(x?.storage_intent).toUpperCase() === 'RAG_OK'
      ).length;
      const headlinePrimaryForNews =
        ragCentrality.candidateHasStrictProtectedTitlePrimary(c, j, signals) ||
        (ragCentrality.candidateMatchesTitleSubject(c, signals.titleNorm) &&
          ragCentrality.candidateHasPresumptiveDirectPrimary(c, j, signals, selected));
      if (
        signals.policyNewsLike === true &&
        ragOkSelectedN === 1 &&
        currentIntent === 'RAG_OK' &&
        !hasCentralityDemotionLatch &&
        headlinePrimaryForNews &&
        !candidateHasCreatorCreditVisualShowcaseBlock(c, j, selected, signals)
      ) {
        const desiredReason = subjectHighRiskBypass
          ? 'storage:rag_ok:subject_hard_primary_high_risk_bypass'
          : 'storage:rag_ok:subject_hard_primary';
        const alreadyOwned =
          primaryReason === desiredReason || safeArray(c?.storage_reasons).map(toStr).includes(desiredReason);
        if (!alreadyOwned) {
          applySubjecthoodPromoteToRagOk(c, desiredReason, j);
          markAuthority(desiredReason);
        }
        continue;
      }
      const desiredReason = 'storage:context_only:subject_true_secondary';
      const alreadyOwned =
        primaryReason === desiredReason || safeArray(c?.storage_reasons).map(toStr).includes(desiredReason);
      const rewriteAllowed =
        currentIntent === 'RAG_OK' ||
        (currentIntent === 'CONTEXT_ONLY' &&
          (legacyContextOnlyReasons.has(primaryReason) || !primaryReason));
      if (rewriteAllowed && !alreadyOwned) {
        applySubjecthoodContextOnlyRewrite(
          c,
          desiredReason,
          creativeSecondary ? 'creative_showcase_secondary' : 'true_secondary'
        );
        markAuthority(desiredReason);
      }
      continue;
    }

    if (tier === 'TELEMETRY_ONLY') {
      const desiredReason = 'storage:none_subjecthood_telemetry_only';
      const alreadyOwned =
        primaryReason === desiredReason || safeArray(c?.storage_reasons).map(toStr).includes(desiredReason);
      if (
        (currentIntent === 'RAG_OK' || currentIntent === 'CONTEXT_ONLY' || currentIntent === 'NONE') &&
        !alreadyOwned
      ) {
        applySubjecthoodNoneRewrite(c, desiredReason);
        markAuthority(desiredReason);
      }
    }
  }

  for (const c of safeArray(selected)) {
    if (c && typeof c === 'object' && c._annotatePolicyAuditMirrors) delete c._annotatePolicyAuditMirrors;
  }

  return { changed, live };
}

module.exports = {
  applySubjectStrengthTierLaneMapping,
};

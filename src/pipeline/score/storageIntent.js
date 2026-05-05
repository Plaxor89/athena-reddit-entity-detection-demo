// storageIntent.js - private helper for scoreSuppressLane stage.
// Storage reason derivation and explanation annotations only (row storage truth — layer 2 of three; see LANE_AND_STORAGE_POLICY.md §17).
// storage:block_lane_* strings document eligibility vs row implementation band; they are not top-level item posture (RAG_OK/…/RAW_ONLY).
// suppress:shadow_lane is assigned in scoreSuppressLane, not here.

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

function prefixOf(reason) {
  const s = toStr(reason);
  const i = s.indexOf(':');
  return i > 0 ? s.slice(0, i) : 'other';
}

function riskRank(risk) {
  const r = toStr(risk).toUpperCase();
  if (r === 'HIGH' || r === 'RISKY') return 3;
  if (r === 'MEDIUM' || r === 'MED') return 2;
  if (r) return 1;
  return 0;
}

function packGateIsHardBlock(gate) {
  const g = toStr(gate).trim().toLowerCase();
  if (!g) return false;
  return g.includes('deny') || g.includes('block') || g.includes('reject');
}

function deriveStorageBlockers(reasons) {
  return uniqueBoundedStrings(safeArray(reasons).filter((r) => toStr(r).startsWith('storage:block_')), 12);
}

function deriveStorageReasonFamily(primary, blockers) {
  const p = toStr(primary).trim();
  if (!p) return safeArray(blockers).length ? 'storage_block' : null;
  if (p.startsWith('storage:rag_ok:') || p === 'storage:rag_ok_topicality_strong') return 'rag_ok';
  if (p.startsWith('storage:context_only')) return 'context_only';
  if (p.startsWith('storage:none')) return 'none';
  if (p.startsWith('storage:block_')) return 'storage_block';
  return prefixOf(p);
}

function firstReasonByPrefixes(reasons, prefixes) {
  const arr = safeArray(reasons).map(toStr).filter(Boolean);
  const prefs = safeArray(prefixes).map(toStr).filter(Boolean);
  for (const p of prefs) {
    for (const r of arr) {
      if (r === p || r.startsWith(p)) return r;
    }
  }
  return '';
}

function deriveStorageReasonTrace(reasons, primary, blockers, cap = 8) {
  const out = [];
  const seen = new Set();
  for (const v of [primary, ...safeArray(blockers), ...safeArray(reasons)]) {
    const s = toStr(v).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

function annotateStorageExplanationBundle(target) {
  if (!target || typeof target !== 'object') return;
  const reasons = uniqueBoundedStrings(target.storage_reasons, 12);
  const primary = toStr(
    target.storage_reason_primary ||
    firstReasonByPrefixes(reasons, ['storage:rag_ok:', 'storage:context_only:', 'storage:none', 'storage:block_']) ||
    ''
  ).trim() || null;
  const blockers = deriveStorageBlockers(reasons);
  const family = deriveStorageReasonFamily(primary, blockers);
  const trace = deriveStorageReasonTrace(reasons, primary, blockers, 8);
  target.storage_reasons = reasons;
  target.storage_reason_primary = primary;
  target.storage_blockers = blockers;
  target.storage_reason_family = family;
  target.storage_reason_trace = trace;
}

function normalizeReasonToken(s) {
  return toStr(s)
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 48);
}

function isProtectedCategory(catRaw) {
  const c = toStr(catRaw).toLowerCase();
  return c === 'hero' || c === 'map' || c === 'ability' || c === 'perk';
}

function isHeroOrMapCategory(catRaw) {
  const c = toStr(catRaw).toLowerCase();
  return c === 'hero' || c === 'map';
}

function isAbilityOrPerkCategory(catRaw) {
  const c = toStr(catRaw).toLowerCase();
  return c === 'ability' || c === 'perk';
}

/**
 * Derives row storage_intent + storage_reasons for one selected candidate. `lane` is row implementation band
 * (same family as det_lane: HARD|HIGH|SOFT|SHADOW), not item posture. Tokens such as storage:block_lane_* tie
 * storage reasoning to that band; do not read them as packaged consumer posture.
 */
function computeStorageIntentSimple({
  selected,
  lane,
  hasTitleOp,
  commentOnly,
  topicalityStrong,
  isCollision,
  isCommonWord,
  isOffDomainCollision,
  risk,
  pack,
  directiveBlockRag,
  hasExact,
  fuzzyOnly,
  equivalenceKind,
  intent,
  ownerScopeRequired,
  ownerEvidence,
  protectedContext,
  ownerCtxStrength,
  category,
  detMatchKind,
  candidate,
  itemJson,
  score,
}) {
  if (selected !== true) return { intent: 'NONE', reasons: ['storage:none_not_selected'] };

  const reasons = [];
  const cat = toStr(category).toLowerCase();
  const exactCanonical = toStr(detMatchKind).toUpperCase() === 'EXACT_CANONICAL';
  const protectedCat = isProtectedCategory(cat);
  const protectedHeroMap = isHeroOrMapCategory(cat);
  const rr = riskRank(risk);

  if (fuzzyOnly === true) reasons.push('storage:block_fuzzy_only');
  if (fuzzyOnly === true && !toStr(equivalenceKind).trim()) reasons.push('storage:block_equivalence_failed');
  if (hasExact === false) reasons.push('storage:block_no_exact_origin');
  if (!hasTitleOp) reasons.push('storage:block_missing_title_op');

  const intentEv = intent && typeof intent === 'object' ? intent : null;
  if (intentEv?.applicable === true) {
    if (intentEv.pass_intent_anchor === false) reasons.push('storage:block_missing_intent_anchor');
    if (intentEv.pass_negative_anchor_gate === false) {
      reasons.push(`storage:block_concept_neg_anchor:${normalizeReasonToken(intentEv.anchor_group || 'concept')}`);
    }
  }

  if (ownerScopeRequired === true) {
    const ownerStatus = toStr(ownerEvidence?.owner_status).toUpperCase();
    const ownerCtx = toStr(ownerCtxStrength).toUpperCase() || 'WEAK';
    if (ownerStatus === 'UNKNOWN') reasons.push('storage:block_missing_owner_scope');
    else if (ownerStatus === 'CONFLICT') reasons.push('storage:block_owner_scope_conflict');
    else if (ownerCtx === 'WEAK') reasons.push('storage:block_owner_scope_weak_context');
    const ownerLevel = toStr(ownerEvidence?.owner_required_level).toUpperCase();
    const ownerReadyTier2 = ownerEvidence?.owner_context_ready_tier2 === true;
    const ownerReadyTier3 = ownerEvidence?.owner_context_ready_tier3 === true;
    if (ownerLevel === 'TIER2' && !ownerReadyTier2) reasons.push('storage:block_tier2_missing_context');
    if (ownerLevel === 'TIER3' && !ownerReadyTier3) reasons.push('storage:block_tier3_missing_context');
  }

  if (commentOnly) reasons.push('storage:block_comment_only');
  if (!topicalityStrong) reasons.push('storage:block_topicality_not_strong');
  if (directiveBlockRag === true) reasons.push('storage:block_alias_directive_block_rag');
  if (isOffDomainCollision) reasons.push('storage:block_off_domain_collision');
  if (isCollision) reasons.push('storage:block_collision_ambiguous');
  if (isCommonWord) reasons.push('storage:block_common_word_alias');
  if (pack?.pack_risky_alias_escaped === true) reasons.push('storage:block_pack_risky_alias_escaped');
  if (pack?.pack_gate && packGateIsHardBlock(pack.pack_gate)) reasons.push('storage:block_pack_gate');
  if (rr === 3) reasons.push('storage:block_high_risk');

  const blockers = reasons.filter((r) => r.startsWith('storage:block_'));
  // storage:block_lane_* — implementation/storage reasoning (band vs RAG eligibility), not §3.1 posture labels.
  const hardBlockers = blockers.filter((r) => !['storage:block_lane_soft', 'storage:block_lane_high'].includes(r));

  if (!protectedCat) {
    if (lane === 'SHADOW') reasons.push('storage:block_lane_shadow');
    if (lane === 'SOFT') reasons.push('storage:block_lane_soft');
    if (lane === 'HIGH' && hardBlockers.length > 0) reasons.push('storage:block_lane_high');
    if (hardBlockers.length === 0 && lane === 'HARD' && hasTitleOp && !commentOnly && topicalityStrong && directiveBlockRag !== true) {
      const primaryVariant = exactCanonical ? 'storage:rag_ok:hard_primary_exact_canonical' : 'storage:rag_ok:hard_primary_exact_other';
      return { intent: 'RAG_OK', reasons: ['storage:rag_ok:hard_primary_exact', primaryVariant, 'storage:rag_ok_topicality_strong'] };
    }
    if (hardBlockers.length === 0 && lane === 'HIGH' && hasTitleOp && !commentOnly && topicalityStrong) {
      const highLaneReason = protectedHeroMap
        ? 'storage:rag_ok:protected_exact_primary_high_lane'
        : 'storage:rag_ok:protected_owner_exact_primary_high_lane';
      return { intent: 'RAG_OK', reasons: [highLaneReason, 'storage:rag_ok:exact_canonical', 'storage:rag_ok_topicality_strong'] };
    }
    return { intent: 'CONTEXT_ONLY', reasons: ['storage:context_only'].concat(reasons.slice(0, 12)) };
  }

  if (!candidate || !itemJson) {
    if (hardBlockers.length === 0 && lane === 'HARD' && hasTitleOp && !commentOnly && topicalityStrong && directiveBlockRag !== true) {
      const primaryVariant = exactCanonical ? 'storage:rag_ok:hard_primary_exact_canonical' : 'storage:rag_ok:hard_primary_exact_other';
      return { intent: 'RAG_OK', reasons: ['storage:rag_ok:hard_primary_exact', primaryVariant, 'storage:rag_ok_topicality_strong'] };
    }
    if (hardBlockers.length === 0 && lane === 'HIGH' && hasTitleOp && !commentOnly && topicalityStrong) {
      const highLaneReason = protectedHeroMap
        ? 'storage:rag_ok:protected_exact_primary_high_lane'
        : 'storage:rag_ok:protected_owner_exact_primary_high_lane';
      return { intent: 'RAG_OK', reasons: [highLaneReason, 'storage:rag_ok:exact_canonical', 'storage:rag_ok_topicality_strong'] };
    }
    return { intent: 'CONTEXT_ONLY', reasons: ['storage:context_only'].concat(reasons.slice(0, 12)) };
  }

  const { computeProtectedDeterministicStageProfile } = require('./protectedStageProfile');
  const ownerStatus = toStr(ownerEvidence?.owner_status).toUpperCase();
  const ownerCtx = toStr(ownerCtxStrength).toUpperCase() || 'WEAK';
  const ownerExactSupport = ownerEvidence?.owner_exact_title_op_support === true || ownerEvidence?.owner_same_source_exact_canonical === true;
  const ownerTitleSupport = ownerEvidence?.owner_title_op_support === true;
  const ownerReadyTier2 = ownerEvidence?.owner_context_ready_tier2 === true;
  const ownerReadyTier3 = ownerEvidence?.owner_context_ready_tier3 === true;
  const protectedPass = protectedContext?.pass_protected_context === true || protectedContext?.protected_context === true || protectedContext?.protected_primary === true;

  const stage = computeProtectedDeterministicStageProfile({
    candidate,
    itemJson,
    category,
    detMatchKind,
    hasExact,
    hasTitleOp,
    commentOnly,
    topicalityStrong,
    fuzzyOnly,
    score,
    risk,
    directiveBlockRag,
    isCollision,
    isCommonWord,
    isOffDomainCollision,
    pack,
    intentEvidence: intent,
    ownerScopeRequired,
    ownerStatus,
    ownerCtx,
    protectedContext,
    ownerExactSupport,
    ownerTitleSupport,
    ownerReadyTier2,
    ownerReadyTier3,
    protectedPass,
  });
  if (candidate && typeof candidate === 'object') Object.assign(candidate, stage);

  const protectedPrimaryHighLaneEligible =
    lane === 'HIGH' &&
    stage.truth_eligible_dbg === true &&
    stage.primary_subject_eligible_dbg === true &&
    (rr !== 3 || stage.narrow_high_risk_bypass_dbg === true) &&
    (!Number.isFinite(score) || score >= 0.62);

  const protectedDirectSubjectKeep =
    stage.truth_eligible_dbg === true &&
    stage.primary_subject_eligible_dbg === true &&
    (!Number.isFinite(score) || score >= 0.55);

  const ragLaneEligible =
    (lane === 'HARD' && stage.primary_subject_eligible_dbg === true) ||
    protectedPrimaryHighLaneEligible ||
    (lane !== 'SHADOW' && protectedDirectSubjectKeep && !stage.broad_multi_protected_dbg);

  // Dynamic storage:block_lane_<band> — encodes band-based eligibility on protected path; still not item posture.
  if (!ragLaneEligible && !protectedDirectSubjectKeep) reasons.push(`storage:block_lane_${toStr(lane).toLowerCase()}`);
  if (rr === 3 && stage.narrow_high_risk_bypass_dbg !== true) reasons.push('storage:block_high_risk');

  const protectedBlockers = reasons.filter((r) => r.startsWith('storage:block_'));
  const protectedHardBlockers = protectedBlockers.filter((r) => !['storage:block_lane_soft', 'storage:block_lane_high'].includes(r));

  if (stage.secondary_example_profile_dbg === true && stage.primary_subject_eligible_dbg !== true) {
    return { intent: 'CONTEXT_ONLY', reasons: ['storage:context_only:general_topic_example_not_primary'] };
  }

  const ragOkAllowed =
    protectedHardBlockers.length === 0 &&
    stage.truth_eligible_dbg === true &&
    stage.primary_subject_eligible_dbg === true &&
    ragLaneEligible &&
    (rr !== 3 || stage.narrow_high_risk_bypass_dbg === true);

  if (ragOkAllowed) {
    if (lane === 'HARD') {
      const primaryVariant = exactCanonical ? 'storage:rag_ok:hard_primary_exact_canonical' : 'storage:rag_ok:hard_primary_exact_other';
      return {
        intent: 'RAG_OK',
        reasons: ['storage:rag_ok:hard_primary_exact', primaryVariant, 'storage:rag_ok_topicality_strong'],
      };
    }
    // Raw: for protected ragOkAllowed, any non-HARD lane (HIGH, SOFT) gets the protected variant
    const protectedVariant = protectedHeroMap
      ? 'storage:rag_ok:protected_exact_primary_high_lane'
      : 'storage:rag_ok:protected_owner_exact_primary_high_lane';
    return { intent: 'RAG_OK', reasons: [protectedVariant, 'storage:rag_ok:exact_canonical', 'storage:rag_ok_topicality_strong'] };
  }

  return { intent: 'CONTEXT_ONLY', reasons: ['storage:context_only'].concat(reasons.slice(0, 12)) };
}

module.exports = {
  computeStorageIntentSimple,
  deriveStorageBlockers,
  deriveStorageReasonFamily,
  firstReasonByPrefixes,
  deriveStorageReasonTrace,
  annotateStorageExplanationBundle,
  isProtectedCategory,
  isHeroOrMapCategory,
  isAbilityOrPerkCategory,
  packGateIsHardBlock,
  riskRank,
};

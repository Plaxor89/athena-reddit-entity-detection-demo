// protectedStageProfile.js - Protected deterministic stage profile for hero/map/ability/perk.
// Used by computeStorageIntent for protected categories.

const { getDirectSubjectPolicySignals, getOpText, normalizeFreeText } = require('./directSubjectPolicySignals');
const {
  isProtectedCategory,
  isHeroOrMapCategory,
  isAbilityOrPerkCategory,
  packGateIsHardBlock,
  riskRank,
} = require('./storageIntent');
const {
  candidateMatchesTitleSubject,
  candidateHasStrictProtectedTitlePrimary,
  candidateEligibleForAnswerSlotSubjectRescue,
  candidateHasOwnedSurfaceSubjectSupport,
  ragCentralitySubjecthoodSummaryForCandidate,
  hasTitleOrOpEvidence,
  hasCommentEvidence,
  countEvidenceBySourceType,
  titleSubjectCategoryLike,
  titleQuestionLike,
  titleDirectShapeLike,
  broadGeneralComparisonThreadLike,
} = require('./ragCentrality');

function isObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

function toStr(v) {
  return v === null || v === undefined ? '' : String(v);
}

function computeRepeatSameCanonicalN(c) {
  const ev = safeArray(c?.evidence);
  const titleEv = countEvidenceBySourceType(ev, 'title') > 0 ? 1 : 0;
  const opEv = countEvidenceBySourceType(ev, 'op') > 0 ? 1 : 0;
  const commentEv = countEvidenceBySourceType(ev, 'comment') > 0 ? 1 : 0;
  return titleEv + opEv + commentEv;
}

function ownerContextStrength(ownerEvidence, protectedContext) {
  const raw = toStr(ownerEvidence?.owner_context_strength).toUpperCase();
  if (raw === 'STRONG' || raw === 'MEDIUM' || raw === 'WEAK' || raw === 'CONFLICT') return raw;
  if (
    protectedContext?.protected_exact_context === true ||
    protectedContext?.protected_context === true ||
    protectedContext?.pass_protected_context === true ||
    ownerEvidence?.owner_exact_title_op_support === true
  )
    return 'STRONG';
  if (
    ownerEvidence?.owner_same_source_unlock === true ||
    ownerEvidence?.owner_second_context === true ||
    ownerEvidence?.owner_title_op_support === true ||
    protectedContext?.protected_title_op_context === true
  )
    return 'MEDIUM';
  return 'WEAK';
}

function originsHasExact(originsArr) {
  return safeArray(originsArr).map(toStr).includes('exact');
}

function isFuzzyOnly(origins) {
  const s = new Set(safeArray(origins).map(toStr));
  return s.has('fuzzy') && !s.has('exact');
}

function computeProtectedDeterministicStageProfile({
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
  intentEvidence,
  ownerScopeRequired,
  ownerStatus,
  ownerCtx,
  protectedContext,
  ownerExactSupport,
  ownerTitleSupport,
  ownerReadyTier2,
  ownerReadyTier3,
  protectedPass,
}) {
  const cat = toStr(category).toLowerCase();
  const protectedCat = isProtectedCategory(cat);
  const protectedHeroMap = isHeroOrMapCategory(cat);
  const protectedAbilityPerk = isAbilityOrPerkCategory(cat);
  const exactCanonical = toStr(detMatchKind).toUpperCase() === 'EXACT_CANONICAL';
  const rr = riskRank(risk);
  const signals = getDirectSubjectPolicySignals(itemJson);
  const titleNorm = signals.titleNorm;
  const opNorm = normalizeFreeText(getOpText(itemJson));

  const candidatesNorm = itemJson?.entity_candidates_resolved ?? itemJson?.candidates_norm ?? [];
  const candidatePool = safeArray(candidatesNorm).filter((x) => {
    if (!isObject(x)) return false;
    const xcat = toStr(x?.category || x?.entity_type || x?.dictionary_entity_type).toLowerCase();
    if (!isProtectedCategory(xcat)) return false;
    const mk = toStr(x?.det_match_kind || x?.match_kind || '').toUpperCase();
    const xExact = mk === 'EXACT_CANONICAL';
    const xEv = safeArray(x?.evidence);
    const xHasTitleOp = x?.evidence_summary?.has_title_op === true || hasTitleOrOpEvidence(xEv);
    const xCommentOnly = x?.det_comment_only === true || (hasCommentEvidence(xEv) && !xHasTitleOp);
    const xTopicalityStrong = x?.det_topicality_strong === true;
    return xExact && xHasTitleOp && !xCommentOnly && xTopicalityStrong;
  });
  const protectedRelevantN = candidatePool.length;
  const singleProtectedRelevant = protectedRelevantN <= 1;
  const broadLike = !!(
    signals.policyReviewOrOpinionLike === true ||
    signals.broadReviewLike === true ||
    signals.policyBroadGeneral === true ||
    signals.broadBundleLike === true ||
    signals.explicitComparisonLike === true ||
    signals.title_explicit_comparison_like === true ||
    signals.policyNewsLike === true
  );
  const broadMultiProtected = broadLike && protectedRelevantN >= 2;

  const titleMention = candidateMatchesTitleSubject(candidate, titleNorm);
  const strictTitlePrimary = candidateHasStrictProtectedTitlePrimary(candidate, itemJson, signals);
  const answerSlotKeep = candidateEligibleForAnswerSlotSubjectRescue(candidate, signals, titleNorm);
  const ownedSurfaceSupport = candidateHasOwnedSurfaceSubjectSupport(candidate, itemJson, signals);
  const repeatSameCanonicalN = computeRepeatSameCanonicalN(candidate);
  const summary = ragCentralitySubjecthoodSummaryForCandidate(
    candidate,
    itemJson,
    candidatePool,
    signals
  );
  const strongerCompeting = !!summary.strongerCompetingKey;

  const directQuestionLike = signals.directSubjectQuestionLike === true || titleQuestionLike(titleNorm);
  const directContentLike =
    signals.directSubjectContentLike === true || titleDirectShapeLike(titleNorm, opNorm);
  const statMetaLike = /\b(win[- ]rate|pick[- ]rate|stats?|meta|performance|buff|nerf|rework)\b/.test(
    `${titleNorm} ${opNorm}`.trim()
  );
  const helpHowtoLike =
    /\b(how do i|help|guide|tips?|question|bug|issue|fix|counter|counters?|playstyle|viable|niche|pickup|pick up)\b/.test(
      `${titleNorm} ${opNorm}`.trim()
    ) || signals.policyQuestionAnswerable === true;
  const newsUpdateLike =
    signals.policyNewsLike === true ||
    /\b(news|update|announce|announcement|release|released|coming|patch notes?|highlight|intro)\b/.test(
      `${titleNorm} ${opNorm}`.trim()
    );
  const creativeConceptLike = /\b(concept|fan concept|mythic weapon|mythic|fanart|art|joke|meme|what if)\b/.test(
    `${titleNorm} ${opNorm}`.trim()
  );
  const sharedBundleLike =
    signals.broadBundleLike === true ||
    (signals.policyNewsLike === true && protectedRelevantN >= 2);

  const deterministicTruthBlocked =
    !hasExact ||
    !hasTitleOp ||
    commentOnly ||
    topicalityStrong !== true ||
    fuzzyOnly ||
    directiveBlockRag === true ||
    isOffDomainCollision ||
    isCollision ||
    isCommonWord ||
    (intentEvidence?.applicable === true && intentEvidence.pass_intent_anchor === false) ||
    (intentEvidence?.applicable === true && intentEvidence.pass_negative_anchor_gate === false) ||
    (ownerScopeRequired === true && ['UNKNOWN', 'CONFLICT'].includes(ownerStatus)) ||
    pack?.pack_risky_alias_escaped === true ||
    (pack?.pack_gate && packGateIsHardBlock(pack.pack_gate));

  let truthScore = 0;
  if (exactCanonical) truthScore += 6;
  if (hasExact) truthScore += 3;
  if (hasTitleOp) truthScore += 2;
  if (!commentOnly) truthScore += 1;
  if (topicalityStrong === true) truthScore += 2;
  if (!fuzzyOnly) truthScore += 1;
  if (
    protectedAbilityPerk &&
    ownerScopeRequired === true &&
    ownerStatus === 'KNOWN' &&
    ownerCtx !== 'WEAK' &&
    (ownerExactSupport || ownerTitleSupport || ownerReadyTier2 || ownerReadyTier3 || protectedPass)
  )
    truthScore += 2;
  if (deterministicTruthBlocked) truthScore = Math.min(truthScore, 0);
  const truthEligible = protectedCat && truthScore >= 10 && !deterministicTruthBlocked;

  let primaryScore = 0;
  if (strictTitlePrimary) primaryScore += 8;
  if (answerSlotKeep) primaryScore += 6;
  if (ownedSurfaceSupport) primaryScore += 4;
  if (repeatSameCanonicalN >= 2) primaryScore += 3;
  if (titleMention) primaryScore += 2;
  const heroDirectPrimaryLike =
    cat === 'hero' &&
    !strongerCompeting &&
    (helpHowtoLike ||
      statMetaLike ||
      newsUpdateLike ||
      directQuestionLike ||
      directContentLike);
  if (summary.strongDominantWinner) primaryScore += 2;
  if (protectedHeroMap && directContentLike) primaryScore += 2;
  if (cat === 'hero' && helpHowtoLike) primaryScore += 4;
  if (cat === 'hero' && statMetaLike) primaryScore += 4;
  if (cat === 'hero' && newsUpdateLike) primaryScore += 3;
  if (heroDirectPrimaryLike && summary.titleAnchoredPrimary) primaryScore += 4;
  if (heroDirectPrimaryLike && singleProtectedRelevant) primaryScore += 2;
  if (cat === 'map' && strictTitlePrimary) primaryScore += 3;
  if (broadLike && !strictTitlePrimary && !answerSlotKeep) primaryScore -= 3;
  if (broadMultiProtected) primaryScore -= 6;
  if (sharedBundleLike && !strictTitlePrimary && !answerSlotKeep) primaryScore -= 4;
  if (creativeConceptLike && !strictTitlePrimary && !answerSlotKeep) primaryScore -= 4;
  if (strongerCompeting) primaryScore -= 4;
  if (cat === 'map' && broadLike && !strictTitlePrimary) primaryScore -= 5;

  const sharedBundlePrimaryDisallowed =
    sharedBundleLike &&
    protectedRelevantN >= 2 &&
    !strictTitlePrimary &&
    !answerSlotKeep;

  const heroPrimaryEligible =
    protectedHeroMap &&
    cat === 'hero' &&
    !creativeConceptLike &&
    !sharedBundlePrimaryDisallowed &&
    (strictTitlePrimary ||
      answerSlotKeep ||
      (titleMention &&
        (helpHowtoLike ||
          statMetaLike ||
          newsUpdateLike ||
          directQuestionLike ||
          directContentLike) &&
        !strongerCompeting &&
        !sharedBundleLike) ||
      (summary.titleAnchoredPrimary &&
        !sharedBundleLike &&
        heroDirectPrimaryLike &&
        primaryScore >= 4) ||
      (singleProtectedRelevant &&
        !broadMultiProtected &&
        heroDirectPrimaryLike &&
        primaryScore >= 3));
  const mapPrimaryEligible =
    protectedHeroMap &&
    cat === 'map' &&
    (strictTitlePrimary ||
      answerSlotKeep ||
      (titleMention && newsUpdateLike && !broadLike && !strongerCompeting));
  const abilityPerkPrimaryEligible =
    protectedAbilityPerk &&
    ownerScopeRequired === true &&
    ownerStatus === 'KNOWN' &&
    ownerCtx !== 'WEAK' &&
    (ownerExactSupport || ownerTitleSupport || ownerReadyTier2 || ownerReadyTier3 || protectedPass) &&
    (strictTitlePrimary || answerSlotKeep || ownedSurfaceSupport);

  const primarySubjectEligible =
    truthEligible &&
    !broadMultiProtected &&
    (heroPrimaryEligible || mapPrimaryEligible || abilityPerkPrimaryEligible);

  let secondaryScore = 0;
  if (signals.policyBroadGeneral === true) secondaryScore += 3;
  if (signals.broadReviewLike === true || signals.policyReviewOrOpinionLike === true)
    secondaryScore += 3;
  if (signals.explicitComparisonLike === true || signals.title_explicit_comparison_like === true)
    secondaryScore += 4;
  if (signals.broadBundleLike === true) secondaryScore += 4;
  if (sharedBundleLike) secondaryScore += 4;
  if (creativeConceptLike && !strictTitlePrimary) secondaryScore += 4;
  if (signals.policyNewsLike === true && broadMultiProtected) secondaryScore += 2;
  if (broadMultiProtected) secondaryScore += 4;
  if (!strictTitlePrimary) secondaryScore += 2;
  if (!primarySubjectEligible) secondaryScore += 2;
  if (!titleMention) secondaryScore += 1;
  if (strongerCompeting) secondaryScore += 2;
  if (cat === 'map' && broadLike && !strictTitlePrimary) secondaryScore += 3;

  const secondaryExampleProfile =
    truthEligible &&
    !primarySubjectEligible &&
    (secondaryScore >= 6 ||
      (broadMultiProtected && !strictTitlePrimary && !answerSlotKeep) ||
      (signals.explicitComparisonLike === true && !strictTitlePrimary) ||
      (signals.policyBroadGeneral === true && !strictTitlePrimary && !answerSlotKeep));

  const narrowHighRiskBypass =
    rr === 3 &&
    truthEligible &&
    protectedHeroMap &&
    titleMention &&
    !creativeConceptLike &&
    !strongerCompeting &&
    ((directContentLike && !broadLike && !broadMultiProtected) ||
      (strictTitlePrimary &&
        singleProtectedRelevant &&
        (helpHowtoLike ||
          statMetaLike ||
          newsUpdateLike ||
          directQuestionLike ||
          directContentLike) &&
        !sharedBundleLike));

  let highRiskBlockSubtype = null;
  if (rr === 3) {
    if (creativeConceptLike) highRiskBlockSubtype = 'block_high_risk:unsafe_visual_ambiguity';
    else if (
      signals.explicitComparisonLike === true ||
      broadMultiProtected ||
      strongerCompeting
    )
      highRiskBlockSubtype = 'block_high_risk:speculative';
    else if (
      titleMention &&
      (helpHowtoLike ||
        statMetaLike ||
        newsUpdateLike ||
        directQuestionLike ||
        directContentLike)
    )
      highRiskBlockSubtype = 'block_high_risk:low_context_exact';
    else highRiskBlockSubtype = 'block_high_risk:speculative';
  }
  const blockerWins = rr === 3 && !narrowHighRiskBypass;

  return {
    truth_score_dbg: truthScore,
    truth_eligible_dbg: truthEligible === true,
    primary_subject_score_dbg: primaryScore,
    primary_subject_eligible_dbg: primarySubjectEligible === true,
    secondary_example_score_dbg: secondaryScore,
    secondary_example_profile_dbg: secondaryExampleProfile === true,
    high_risk_block_wins_dbg: blockerWins === true,
    high_risk_block_subtype_dbg: highRiskBlockSubtype,
    narrow_high_risk_bypass_dbg: narrowHighRiskBypass === true,
    narrow_high_risk_bypass_reason_dbg: narrowHighRiskBypass
      ? 'block_high_risk_bypass:direct_gameplay_primary'
      : null,
    broad_multi_protected_dbg: broadMultiProtected === true,
    protected_relevant_n_dbg: protectedRelevantN,
    strict_title_primary_dbg: strictTitlePrimary === true,
    title_mention_dbg: titleMention === true,
    stronger_competing_protected_subject_dbg: strongerCompeting === true,
  };
}

module.exports = {
  computeProtectedDeterministicStageProfile,
};

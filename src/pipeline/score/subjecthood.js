// subjecthood.js - Subject strength tier, annotation, and summaries.

const {
  getDirectSubjectPolicySignals,
  titleNormDirectSubjectQuestionPattern,
  getOpText,
  getTitleText,
  normalizeFreeText,
  firstNonEmptyString,
  getClassifierHasMediaEvidence,
} = require('./directSubjectPolicySignals');
const { isProtectedCategory } = require('./storageIntent');
const ragCentrality = require('./ragCentrality');
const {
  getUpstreamRescueModulation,
  candidateCategoryLower,
  candidateMatchesTitleSubject,
  candidateMatchesOpSubject,
  candidateHasStrictProtectedTitlePrimary,
  candidateHasStrictProtectedTitlePrimaryRaw,
  candidateEligibleForAnswerSlotSubjectRescue,
  candidateHasProtectedDirectSubjectKeep,
  candidateHasOwnerEvidencePrimaryRescueBase,
  candidatePolicyBlocksAggressiveRescue,
  candidateDirectSubjectStrengthDbg,
  candidateProtectedDirectSubjectKeepBaseState,
  candidateHasPresumptiveDirectPrimary,
  candidateHasExplicitSecondaryExampleEvidence,
  candidateHasDirectAnswerableRescue,
  hasTitleOrOpEvidence,
  hasCommentEvidence,
  countEvidenceBySourceType,
  computeRepeatSameCanonicalN,
  computeSameOwnerSupportN,
  computeOwnerEvidenceStrength,
  ragCentralitySubjecthoodSummaryForCandidate,
  broadMultiProtectedThreadLike,
  countProtectedEntityMentionsInText,
  titleAnchoredDirectSubjectQuestionRelaxesMultiProtectedSurface,
  mapEnvironmentFeedbackThreadLike,
} = ragCentrality;

function isObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

function toStr(v) {
  return v === null || v === undefined ? '' : String(v);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
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

function candidateCreativeShowcaseSignals(c, j, signalsOverride = null) {
  if (!isObject(c)) return [];
  const signals = isObject(signalsOverride) ? signalsOverride : getDirectSubjectPolicySignals(j);
  const titleNorm = signals.titleNorm;
  const opNorm = normalizeFreeText(getOpText(j));
  const text = `${titleNorm} ${opNorm}`.trim();
  const catLower = candidateCategoryLower(c);
  const candidateOwnsTitle = candidateMatchesTitleSubject(c, titleNorm);
  const titleInterrogative = ragCentrality.titleQuestionLike(titleNorm);
  const loreOrEventOutcomeFrame =
    /\b(lore|canon|story|corrupt|captured|talon|what if|does this mean|would('?ve)?|won the event|rewarded|almost lose)\b/.test(
      text
    );
  const mapEnvironmentFeedbackCtx = mapEnvironmentFeedbackThreadLike(
    catLower,
    candidateOwnsTitle,
    titleNorm,
    opNorm
  );
  const incidentalCosmeticInLoreTitleThread =
    candidateOwnsTitle &&
    titleInterrogative &&
    loreOrEventOutcomeFrame &&
    !/\b(fanart|showcase|gallery|concept art|cosplay|comic|render|splash art)\b/.test(text);
  const out = [];
  if (
    /\b(fanart|artwork|art dump|art post|comic|comic dub|comic strip|cosplay|concept art|concept skin|mythic weapon concept|weapon concept|skin concept|showcase|gallery|render|splash art|poster|cover art)\b/.test(
      text
    )
  )
    out.push('secondary:creative_showcase_thread');
  if (
    /\b(skin|cosmetic|highlight intro|victory pose|spray|emote|voice line|souvenir|weapon skin|mythic weapon|mythic skin|bundle price|shop|store|comic issue|comic page)\b/.test(
      text
    ) &&
    !incidentalCosmeticInLoreTitleThread &&
    !mapEnvironmentFeedbackCtx
  )
    out.push('secondary:cosmetic_visual_thread');
  if (
    /\b(model|face model|jawline|hair|visual|look(s)? like|vibes|cute|beautiful|pretty|neck|pose)\b/.test(text) &&
    !(mapEnvironmentFeedbackCtx && /\bpretty\s+(bad|good|terrible|awful|similar|much|sure|clear|rough|wild|crazy|obvious|hard|close)\b/.test(text))
  )
    out.push('secondary:visual_presentation_thread');
  if (/\b(meme|shitpost|joke|template)\b/.test(text)) out.push('secondary:meme_or_joke_thread');
  const hasMediaEvidence =
    signals.upstreamHasMediaEvidence === true || getClassifierHasMediaEvidence(j) === true;
  const titleOnly = titleNorm && !opNorm;
  const shortTitle = titleNorm && titleNorm.split(/\s+/).filter(Boolean).length <= 6;
  const gameplayish = /\b(bug|issue|fix|broken|buff|nerf|rework|viable|niche|guide|tips?|help|how do i|counter|counters?|win[- ]rate|pick[- ]rate|stats?|meta|performance|patch notes?|update|announcement|released|coming|role|identity|matchup|advice)\b/.test(
    text
  );
  if (hasMediaEvidence && titleOnly && shortTitle && candidateOwnsTitle && !gameplayish)
    out.push('secondary:minimal_media_showcase_title');
  const creatorCreditTitle = /(\(\s*by\s+@?[a-z0-9_\.\-]+\s*\)|\bby\s+@?[a-z0-9_\.\-]+\b|\bart\s+by\b|\bcredit\s*:\s*@?[a-z0-9_\.\-]+\b|\bsource\s*:\s*(?:@?[a-z0-9_\.\-]+|x\.com|twitter|pixiv|instagram|ig)\b)/i.test(
    titleNorm
  );
  const creatorCreditBody = /(\bart\s+by\b|\bcredit\s*:\s*@?[a-z0-9_\.\-]+\b|\bsource\s*:\s*(?:@?[a-z0-9_\.\-]+|x\.com|twitter|pixiv|instagram|ig)\b)/i.test(
    opNorm
  );
  const creatorCredit = creatorCreditTitle || creatorCreditBody;
  if ((creatorCredit || signals.upstreamShowcaseVisualPrior === true) && candidateOwnsTitle && !gameplayish)
    out.push('secondary:creator_credit_visual_title');
  if (
    (creatorCredit || signals.upstreamShowcaseVisualPrior === true) &&
    hasMediaEvidence &&
    shortTitle &&
    candidateOwnsTitle &&
    !gameplayish
  )
    out.push('secondary:creator_credit_media_showcase');
  return uniqueBoundedStrings(out, 12);
}

function candidateHasCreatorCreditVisualShowcaseBlock(c, j, selectedPool = [], signalsOverride = null) {
  if (!isObject(c)) return false;
  const signals = isObject(signalsOverride) ? signalsOverride : getDirectSubjectPolicySignals(j);
  const creativeSignals = candidateCreativeShowcaseSignals(c, j, signals);
  const creatorCreditLike =
    creativeSignals.includes('secondary:creator_credit_visual_title') ||
    creativeSignals.includes('secondary:creator_credit_media_showcase');
  if (!creatorCreditLike) return false;
  const titleNorm = signals.titleNorm;
  const opNorm = normalizeFreeText(getOpText(j));
  const text = `${titleNorm} ${opNorm}`.trim();
  const gameplayish = /\b(bug|issue|fix|broken|buff|nerf|rework|viable|niche|guide|tips?|help|how do i|counter|counters?|win[- ]rate|pick[- ]rate|stats?|meta|performance|patch notes?|update|announcement|released|coming|role|identity|matchup|advice)\b/.test(
    text
  );
  const titleLock =
    candidateMatchesTitleSubject(c, titleNorm) ||
    candidateHasStrictProtectedTitlePrimary(c, j, signals) ||
    candidateEligibleForAnswerSlotSubjectRescue(c, signals, titleNorm);
  const broadMulti = broadMultiProtectedThreadLike(signals, selectedPool);
  return creatorCreditLike && titleLock && !gameplayish && !broadMulti;
}

function candidateIsCreativeShowcaseSecondary(c, j, selectedPool = [], signalsOverride = null) {
  if (!isObject(c)) return false;
  const signals = isObject(signalsOverride) ? signalsOverride : getDirectSubjectPolicySignals(j);
  const creativeSignals = candidateCreativeShowcaseSignals(c, j, signals);
  if (!creativeSignals.length) return false;
  const titleNorm = signals.titleNorm;
  const strictTitlePrimary = candidateHasStrictProtectedTitlePrimary(c, j, signals);
  const directKeep = candidateHasProtectedDirectSubjectKeep(c, j, signals, selectedPool);
  const titleText = `${titleNorm} ${normalizeFreeText(getOpText(j))}`.trim();
  const gameplayish = /\b(bug|issue|fix|broken|buff|nerf|rework|viable|niche|guide|tips?|help|how do i|counter|counters?|win[- ]rate|pick[- ]rate|stats?|meta|performance|patch notes?|update|announcement|released|coming)\b/.test(
    titleText
  );
  if (candidateHasCreatorCreditVisualShowcaseBlock(c, j, selectedPool, signals) && !gameplayish)
    return true;
  if (gameplayish && strictTitlePrimary && directKeep) return false;
  return true;
}

function candidateIsGameplayUpdatePrimary(c, j, selectedPool = [], signalsOverride = null) {
  if (!isObject(c)) return false;
  const signals = isObject(signalsOverride) ? signalsOverride : getDirectSubjectPolicySignals(j);
  const titleNorm = signals.titleNorm;
  const opNorm = normalizeFreeText(getOpText(j));
  const text = `${titleNorm} ${opNorm}`.trim();
  const directKeep = candidateHasProtectedDirectSubjectKeep(c, j, signals, selectedPool);
  const strictTitlePrimary = candidateHasStrictProtectedTitlePrimary(c, j, signals);
  const answerSlotOwner = candidateEligibleForAnswerSlotSubjectRescue(c, signals, titleNorm);
  const directAnswerableRescue = candidateHasDirectAnswerableRescue(c, j, signals, selectedPool);
  const ownerEvidencePrimaryRescue = candidateHasOwnerEvidencePrimaryRescueBase(
    c,
    j,
    signals,
    selectedPool
  );
  const directShape =
    signals.directSubjectQuestionLike === true ||
    signals.directSubjectContentLike === true ||
    ragCentrality.titleSubjectCategoryLike(titleNorm) ||
    ragCentrality.titleQuestionLike(titleNorm) ||
    ragCentrality.titleDirectShapeLike(titleNorm, opNorm);
  const gameplayish = /\b(bug|issue|fix|broken|buff|nerf|rework|viable|niche|guide|tips?|help|how do i|counter|counters?|win[- ]rate|pick[- ]rate|stats?|meta|performance|patch notes?|update|announcement|released|coming|role|identity|matchup|advice|ui|hud|indicator|icon|tooltip|ignite|burn|qol|quality of life|major perk|minor perk|bruiser)\b/.test(
    text
  );
  const creativeSecondary = candidateIsCreativeShowcaseSecondary(c, j, selectedPool, signals);
  const systemWrapperBlocked = ragCentrality.candidateHasSystemWrapperChallengeDemoter(c, j, signals);
  return (
    !creativeSecondary &&
    !systemWrapperBlocked &&
    gameplayish &&
    (strictTitlePrimary ||
      answerSlotOwner ||
      directAnswerableRescue ||
      ownerEvidencePrimaryRescue ||
      directKeep ||
      directShape ||
      signals.upstreamDirectAnswerablePrior === true ||
      signals.upstreamSubjectLockPrior === true)
  );
}

function candidateIsGenericCommonWordProtectedNoise(c, j, signalsOverride = null) {
  if (!isObject(c)) return false;
  const signals = isObject(signalsOverride) ? signalsOverride : getDirectSubjectPolicySignals(j);
  const label = normalizeFreeText(
    c?.label_dbg || c?.label || c?.canonical_name || c?.canonical_slug
  );
  const entityKey = normalizeFreeText(c?.entity_key_dbg || c?.entity_key);
  const cat = candidateCategoryLower(c);
  const titleNorm = signals.titleNorm;
  const opNorm = normalizeFreeText(getOpText(j));
  const text = `${titleNorm} ${opNorm}`.trim();
  if (cat === 'perk' && (label === 'balance' || entityKey === 'perk||balance||perk')) {
    const explicitOwnedPerkFrame = /\b(balance perk|perk called balance|the perk balance|unlock balance|equip balance|balance is disabled|balance got buffed|balance got nerfed)\b/.test(
      text
    );
    return !explicitOwnedPerkFrame;
  }
  return false;
}

function candidateHasSingleSubjectDirectDesignBugRescue(
  c,
  j,
  selectedPool = [],
  signalsOverride = null,
  supportOverride = null
) {
  if (!isObject(c)) return false;
  if (!isProtectedCategory(candidateCategoryLower(c))) return false;
  const signals = isObject(signalsOverride) ? signalsOverride : getDirectSubjectPolicySignals(j);
  if (candidatePolicyBlocksAggressiveRescue(c, j, signals, { mode: 'direct_design_bug' }))
    return false;
  const modulation = getUpstreamRescueModulation(signals);
  if (modulation.showcase_media_anti_bypass) return false;
  if (candidateHasCreatorCreditVisualShowcaseBlock(c, j, selectedPool, signals)) return false;
  if (require('./ragCentrality').candidateHasSystemWrapperChallengeDemoter(c, j, signals))
    return false;
  if (ragCentrality.candidateHasNonExclusiveBroadPrimaryBlock(c, j, selectedPool, signals))
    return false;
  const support = Array.isArray(supportOverride)
    ? supportOverride.map(toStr)
    : safeArray(c?.subject_support_signals).map(toStr);
  const strictTitlePrimary = candidateHasStrictProtectedTitlePrimary(c, j, signals);
  const answerSlotOwner = candidateEligibleForAnswerSlotSubjectRescue(c, signals, signals.titleNorm);
  const directAnswerableRescue = candidateHasDirectAnswerableRescue(c, j, signals, selectedPool);
  const ownerEvidencePrimaryRescue = candidateHasOwnerEvidencePrimaryRescueBase(
    c,
    j,
    signals,
    selectedPool
  );
  const titleMention = candidateMatchesTitleSubject(c, signals.titleNorm);
  const noStrongerCompeting =
    !toStr(c?.stronger_competing_protected_subject_key).trim() &&
    c?.stronger_competing_dbg !== true &&
    support.includes('subject:no_stronger_competing_protected_subject');
  const exactishPrimary =
    strictTitlePrimary ||
    answerSlotOwner ||
    directAnswerableRescue ||
    ownerEvidencePrimaryRescue ||
    titleMention ||
    support.includes('subject:title_exact') ||
    support.includes('subject:op_exact') ||
    (support.includes('subject:title_anchored_primary') && Number(c?.repeat_same_canonical_n || 0) >= 1);
  const text_ = `${signals.titleNorm} ${normalizeFreeText(getOpText(j))}`.trim();
  const directDesignBugLike = /\b(needs? serious changes?|needs? changes?|bug|issue|broken|fix|fixed|buff|nerf|rework|role|identity|bruiser|niche|viable|qol|quality of life|indicator|icon|tooltip|ignite|burn|major perk|minor perk|update|patch notes?|design)\b/.test(
    text_
  );
  const creativeSecondary = candidateIsCreativeShowcaseSecondary(c, j, selectedPool, signals);
  const patchBundleBlocked =
    modulation.patch_bundle_anti_rescue &&
    !strictTitlePrimary &&
    !answerSlotOwner &&
    !ownerEvidencePrimaryRescue;
  const directStrength = Number.isFinite(c?.subject_direct_subject_strength_dbg)
    ? c.subject_direct_subject_strength_dbg
    : candidateDirectSubjectStrengthDbg(c, j, selectedPool);
  const threshold = clamp(
    ((signals.upstreamSubjectLockPrior === true || signals.upstreamDirectAnswerablePrior === true)
      ? 4
      : 5) + (modulation?.net_delta ?? 0),
    4,
    7
  );
  return (
    !creativeSecondary &&
    !patchBundleBlocked &&
    directDesignBugLike &&
    exactishPrimary &&
    noStrongerCompeting &&
    directStrength >= threshold
  );
}

function candidateSubjectSupportScore(c, j, selectedPool = []) {
  const signals = getDirectSubjectPolicySignals(j);
  const titleNorm = signals.titleNorm;
  const opNorm = normalizeFreeText(getOpText(j));
  const support = [];
  const ev = safeArray(c?.evidence);
  const hasTitle = countEvidenceBySourceType(ev, 'title') > 0;
  const hasOp = countEvidenceBySourceType(ev, 'op') > 0;
  const hasComment = countEvidenceBySourceType(ev, 'comment') > 0;
  const exactCanonical = toStr(c?.det_match_kind || c?.match_kind).toUpperCase() === 'EXACT_CANONICAL';
  const sameOwnerSupportN = computeSameOwnerSupportN(c);
  const repeatSameCanonicalN = computeRepeatSameCanonicalN(c);
  const answerSlotOwner = candidateEligibleForAnswerSlotSubjectRescue(c, signals, titleNorm);
  const directAnswerableRescue = candidateHasDirectAnswerableRescue(c, j, signals, selectedPool);
  const strictTitlePrimary = candidateHasStrictProtectedTitlePrimary(c, j, signals);
  const titleExact = exactCanonical && candidateMatchesTitleSubject(c, titleNorm);
  const titleAliasSafe =
    !exactCanonical &&
    candidateMatchesTitleSubject(c, titleNorm) &&
    c?.det_equivalence_pass === true;
  const opExact = exactCanonical && candidateMatchesOpSubject(c, opNorm);
  const ownerEvidence = isObject(c?.owner_evidence) ? c.owner_evidence : {};
  const ownerEvidenceStrength = computeOwnerEvidenceStrength(c);
  const ownerEvidencePrimaryRescue = candidateHasOwnerEvidencePrimaryRescueBase(
    c,
    j,
    signals,
    selectedPool
  );
  const titleOwnedSurface = candidateMatchesTitleSubject(c, titleNorm) && sameOwnerSupportN > 0;
  const opOwnedSurface = candidateMatchesOpSubject(c, opNorm) && sameOwnerSupportN > 0;
  const summary = ragCentralitySubjecthoodSummaryForCandidate(c, j, selectedPool, signals);
  if (titleExact) support.push('subject:title_exact');
  if (titleAliasSafe) support.push('subject:title_alias_safe');
  if (opExact) support.push('subject:op_exact');
  if (titleOwnedSurface) support.push('subject:title_owned_surface');
  if (opOwnedSurface) support.push('subject:op_owned_surface');
  if (answerSlotOwner) support.push('subject:answer_slot_owner');
  if (directAnswerableRescue) support.push('subject:direct_answerable_rescue');
  if (ownerEvidence?.owner_exact_title_op_support === true)
    support.push('subject:owner_exact_title_op_support');
  if (ownerEvidence?.owner_same_source_exact_canonical === true)
    support.push('subject:owner_same_source_exact_canonical');
  if (ownerEvidence?.owner_title_op_support === true) support.push('subject:owner_title_op_support');
  if (ownerEvidence?.same_hero_context_unlock === true) support.push('subject:same_hero_context_unlock');
  if (ownerEvidence?.owner_context_ready_tier2 === true)
    support.push('subject:owner_context_ready_tier2');
  if (ownerEvidence?.owner_context_ready_tier3 === true)
    support.push('subject:owner_context_ready_tier3');
  if (ownerEvidencePrimaryRescue) support.push('subject:owner_evidence_primary_rescue');
  if (ownerEvidenceStrength >= 4) support.push('subject:owner_evidence_strong');
  if (!candidatePolicyBlocksAggressiveRescue(c, j, signals, { mode: 'subject_support' }))
    support.push('subject:candidate_policy_rescue_safe');
  const questionLikeFromSignals =
    signals.policyQuestionAnswerable === true ||
    signals.upstreamQuestionLike === true ||
    signals.upstreamDirectAnswerablePrior === true;
  if (questionLikeFromSignals) support.push('subject:question_like_thread');
  if (signals.policyNewsLike === true) {
    support.push('subject:news_update_thread');
  }
  const supportForRescue = [...support];
  if (!summary.strongerCompetingKey)
    supportForRescue.push('subject:no_stronger_competing_protected_subject');
  if (strictTitlePrimary || summary.titleAnchoredPrimary)
    supportForRescue.push('subject:title_anchored_primary');
  if (candidateHasSingleSubjectDirectDesignBugRescue(c, j, selectedPool, signals, supportForRescue))
    support.push('subject:direct_protected_design_or_bug_candidate');
  if (signals.policySubjectFavoring === true) support.push('subject:subject_favoring_thread_policy');
  if (!summary.strongerCompetingKey)
    support.push('subject:no_stronger_competing_protected_subject');
  if (repeatSameCanonicalN >= 2) support.push('subject:repeat_same_canonical');
  if (hasComment && sameOwnerSupportN > 0) support.push('subject:comment_corroborated_same_owner');
  if (summary.strongDominantWinner) support.push('subject:strong_dominant_winner');
  if (strictTitlePrimary || summary.titleAnchoredPrimary)
    support.push('subject:title_anchored_primary');
  return {
    subject_support_signals: uniqueBoundedStrings(support, 20),
    same_owner_support_n: sameOwnerSupportN,
    repeat_same_canonical_n: repeatSameCanonicalN,
    stronger_competing_protected_subject_key: summary.strongerCompetingKey || null,
  };
}

function computeSecondaryExampleSignals(c, j, selectedPool = []) {
  const signals = getDirectSubjectPolicySignals(j);
  const out = [];
  const titleNorm = signals.titleNorm;
  const strictTitlePrimary = candidateHasStrictProtectedTitlePrimary(c, j, signals);
  const base = candidateProtectedDirectSubjectKeepBaseState(c, j, signals, selectedPool);
  const directKeep = candidateHasProtectedDirectSubjectKeep(c, j, signals, selectedPool);
  const presumptivePrimary = candidateHasPresumptiveDirectPrimary(c, j, signals, selectedPool, base);
  const hasCommentOnly = hasCommentEvidence(c?.evidence) && !hasTitleOrOpEvidence(c?.evidence);
  const protectedSelected = safeArray(selectedPool).filter((x) =>
    isProtectedCategory(x?.category || x?.entity_type || x?.dictionary_entity_type)
  );
  const broadMultiProtected = broadMultiProtectedThreadLike(signals, selectedPool);
  if (!presumptivePrimary && (signals.policyReviewOrOpinionLike === true || signals.broadReviewLike === true))
    out.push('secondary:broad_review_thread');
  if (!presumptivePrimary && signals.policyBroadGeneral === true)
    out.push('secondary:broad_general_thread');
  if (
    !presumptivePrimary &&
    signals.broadBundleLike === true &&
    !titleAnchoredDirectSubjectQuestionRelaxesMultiProtectedSurface(signals, selectedPool)
  )
    out.push('secondary:bundle_thread');
  if (
    !presumptivePrimary &&
    (signals.title_explicit_comparison_like === true || signals.explicitComparisonLike === true)
  )
    out.push('secondary:comparison_thread');
  if (!strictTitlePrimary && !directKeep) out.push('secondary:not_title_primary');
  const mapCoMentionWaived = mapEnvironmentFeedbackThreadLike(
    candidateCategoryLower(c),
    candidateMatchesTitleSubject(c, titleNorm),
    titleNorm,
    normalizeFreeText(getOpText(j))
  );
  if (
    (broadMultiProtected || protectedSelected.length >= 2) &&
    !titleAnchoredDirectSubjectQuestionRelaxesMultiProtectedSurface(signals, selectedPool) &&
    !mapCoMentionWaived
  )
    out.push('secondary:co-mentioned_with_multiple_protected_entities');
  if (
    !presumptivePrimary &&
    (signals.policyReviewOrOpinionLike === true || signals.broadReviewLike === true) &&
    !strictTitlePrimary
  )
    out.push('secondary:example_inside_impressions_thread');
  if (hasCommentOnly) out.push('secondary:comment_only_support');
  if (
    !presumptivePrimary &&
    !candidateMatchesTitleSubject(c, titleNorm) &&
    hasTitleOrOpEvidence(c?.evidence)
  )
    out.push('secondary:weak_non_title_support');
  const creativeSignals = candidateCreativeShowcaseSignals(c, j, signals);
  for (const sig of creativeSignals) out.push(sig);
  if (candidateIsCreativeShowcaseSecondary(c, j, selectedPool, signals))
    out.push('secondary:creative_showcase_secondary');
  if (candidateHasExplicitSecondaryExampleEvidence(c, j, signals, selectedPool, base))
    out.push('secondary:explicit_secondary_example');
  return uniqueBoundedStrings(out, 24);
}

function broadResidueSignalsOnly(secondary) {
  const allowed = new Set([
    'secondary:broad_general_thread',
    'secondary:broad_review_thread',
    'secondary:bundle_thread',
    'secondary:comparison_thread',
    'secondary:example_inside_impressions_thread',
    'secondary:not_title_primary',
    'secondary:weak_non_title_support',
    'secondary:explicit_secondary_example',
    'secondary:co-mentioned_with_multiple_protected_entities',
  ]);
  return safeArray(secondary).every((s) => allowed.has(toStr(s)));
}

function estimateBroadResidueDirectStrength(c, j, signals, support = null) {
  const supportArr = Array.isArray(support) ? support.map(toStr) : safeArray(c?.subject_support_signals).map(toStr);
  const sig = signals || getDirectSubjectPolicySignals(j);
  const titleNorm = sig?.titleNorm || normalizeFreeText(getTitleText(j));
  const opNorm = normalizeFreeText(getOpText(j));
  const exactCanonical = toStr(c?.det_match_kind || c?.match_kind).toUpperCase() === 'EXACT_CANONICAL';
  const titleMention = candidateMatchesTitleSubject(c, titleNorm);
  const opMention = candidateMatchesOpSubject(c, opNorm);
  const sameOwnerSupportN = computeSameOwnerSupportN(c);
  const repeatSameCanonicalN = computeRepeatSameCanonicalN(c);
  const ownerEvidenceStrength = computeOwnerEvidenceStrength(c);

  let n = 0;
  if (exactCanonical) n += 2;
  if (titleMention) n += 2;
  if (opMention) n += 1;
  if (supportArr.includes('subject:title_exact')) n += 2;
  if (supportArr.includes('subject:op_exact')) n += 1;
  if (supportArr.includes('subject:title_anchored_primary')) n += 2;
  if (supportArr.includes('subject:strong_dominant_winner')) n += 2;
  if (supportArr.includes('subject:no_stronger_competing_protected_subject')) n += 2;
  if (supportArr.includes('subject:title_owned_surface')) n += 1;
  if (supportArr.includes('subject:op_owned_surface')) n += 1;
  if (supportArr.includes('subject:owner_evidence_primary_rescue')) n += 2;
  if (sameOwnerSupportN > 0) n += 1;
  if (repeatSameCanonicalN >= 1) n += 1;
  if (ownerEvidenceStrength >= 4) n += 1;
  return n;
}

function candidateHasBroadResidueDirectPrimaryOverride(c, j, selectedPool = [], signalsOverride = null) {
  if (!isObject(c)) return false;
  if (!isProtectedCategory(candidateCategoryLower(c))) return false;

  const signals = isObject(signalsOverride) ? signalsOverride : getDirectSubjectPolicySignals(j);
  if (candidatePolicyBlocksAggressiveRescue(c, j, signals, { mode: 'broad_residue_direct_primary' })) return false;

  const modulation = getUpstreamRescueModulation(signals);
  if (modulation.showcase_media_anti_bypass) return false;
  if (candidateHasCreatorCreditVisualShowcaseBlock(c, j, selectedPool, signals)) return false;
  if (ragCentrality.candidateHasSystemWrapperChallengeDemoter(c, j, signals)) return false;

  const support = safeArray(c?.subject_support_signals).map(toStr);
  const secondary = safeArray(c?.secondary_example_signals).map(toStr);

  const directSupportN = [
    'subject:title_exact',
    'subject:op_exact',
    'subject:title_anchored_primary',
    'subject:repeat_same_canonical',
    'subject:strong_dominant_winner',
    'subject:no_stronger_competing_protected_subject',
    'subject:title_owned_surface',
    'subject:op_owned_surface',
    'subject:owner_evidence_primary_rescue',
  ].filter((sig) => support.includes(sig)).length;

  const noStrongerCompeting =
    !toStr(c?.stronger_competing_protected_subject_key).trim() &&
    c?.stronger_competing_dbg !== true &&
    support.includes('subject:no_stronger_competing_protected_subject');

  const strictTitlePrimary = candidateHasStrictProtectedTitlePrimaryRaw(c, j, signals);
  const answerSlotOwner = candidateEligibleForAnswerSlotSubjectRescue(c, signals, signals.titleNorm);
  const ownerEvidencePrimaryRescue = candidateHasOwnerEvidencePrimaryRescueBase(c, j, signals, selectedPool);
  const titleMention = candidateMatchesTitleSubject(c, signals.titleNorm);
  const directStrength = estimateBroadResidueDirectStrength(c, j, signals, support);

  const creativeSecondary =
    candidateIsCreativeShowcaseSecondary(c, j, selectedPool, signals) ||
    c?.subject_creative_showcase_dbg === true ||
    c?.creator_credit_showcase_dbg === true;

  const nonexclusiveBroadPrimaryBlock = ragCentrality.candidateHasNonExclusiveBroadPrimaryBlock(
    c,
    j,
    selectedPool,
    signals
  );

  const residueOnly = broadResidueSignalsOnly(secondary);
  const broadResiduePresent = secondary.some(
    (s) =>
      s === 'secondary:broad_general_thread' ||
      s === 'secondary:broad_review_thread' ||
      s === 'secondary:comparison_thread' ||
      s === 'secondary:example_inside_impressions_thread' ||
      s === 'secondary:co-mentioned_with_multiple_protected_entities'
  );

  const hardCompetitionLike =
    secondary.includes('secondary:bundle_thread') ||
    nonexclusiveBroadPrimaryBlock ||
    Boolean(toStr(c?.stronger_competing_protected_subject_key).trim()) ||
    c?.stronger_competing_dbg === true;

  const safePolicy = support.includes('subject:candidate_policy_rescue_safe');
  const patchBundleBlocked =
    modulation.patch_bundle_anti_rescue && !strictTitlePrimary && !answerSlotOwner && !ownerEvidencePrimaryRescue;

  const exactishPrimary =
    strictTitlePrimary ||
    answerSlotOwner ||
    ownerEvidencePrimaryRescue ||
    titleMention ||
    support.includes('subject:title_exact') ||
    support.includes('subject:op_exact') ||
    (support.includes('subject:title_anchored_primary') && Number(c?.repeat_same_canonical_n || 0) >= 1);

  const narrowExclusiveOwner = strictTitlePrimary || answerSlotOwner || ownerEvidencePrimaryRescue;
  const minDirectStrength = narrowExclusiveOwner ? 4 : 5;

  return (
    exactishPrimary &&
    directSupportN >= 2 &&
    directStrength >= minDirectStrength &&
    safePolicy &&
    noStrongerCompeting &&
    broadResiduePresent &&
    residueOnly &&
    !creativeSecondary &&
    !hardCompetitionLike &&
    !patchBundleBlocked
  );
}

function candidateCanRescueDirectGameplayPrimary(c, j, selectedPool = [], signalsOverride = null) {
  if (!isObject(c)) return false;
  if (!isProtectedCategory(candidateCategoryLower(c))) return false;
  const signals = isObject(signalsOverride) ? signalsOverride : getDirectSubjectPolicySignals(j);
  const support = safeArray(c?.subject_support_signals).map(toStr);
  const secondary = safeArray(c?.secondary_example_signals).map(toStr);
  const strictTitlePrimary = candidateHasStrictProtectedTitlePrimary(c, j, signals);
  const answerSlotOwner = candidateEligibleForAnswerSlotSubjectRescue(c, signals, signals.titleNorm);
  const directAnswerableRescue = candidateHasDirectAnswerableRescue(c, j, signals, selectedPool);
  const ownerEvidencePrimaryRescue = candidateHasOwnerEvidencePrimaryRescueBase(
    c,
    j,
    signals,
    selectedPool
  );
  const gameplayPrimary = candidateIsGameplayUpdatePrimary(c, j, selectedPool, signals);
  const directDesignBugRescue = candidateHasSingleSubjectDirectDesignBugRescue(
    c,
    j,
    selectedPool,
    signals
  );
  const creativeSecondary = candidateIsCreativeShowcaseSecondary(c, j, selectedPool, signals);
  const comparisonLike = secondary.includes('secondary:comparison_thread');
  const multiProtected = secondary.includes('secondary:co-mentioned_with_multiple_protected_entities');
  const explicitSecondary =
    c?.subject_secondary_explicit_dbg === true ||
    secondary.includes('secondary:explicit_secondary_example');
  const broadResidueOverride = candidateHasBroadResidueDirectPrimaryOverride(c, j, selectedPool, signals);
  const exactishPrimary =
    support.includes('subject:title_exact') ||
    support.includes('subject:op_exact') ||
    answerSlotOwner ||
    directAnswerableRescue ||
    ownerEvidencePrimaryRescue ||
    broadResidueOverride ||
    directDesignBugRescue ||
    strictTitlePrimary ||
    (support.includes('subject:title_anchored_primary') &&
      Number(c?.repeat_same_canonical_n || 0) >= 1);
  const directStrength = Number.isFinite(c?.subject_direct_subject_strength_dbg)
    ? c.subject_direct_subject_strength_dbg
    : candidateDirectSubjectStrengthDbg(c, j, selectedPool);
  const noStrongerCompeting = !toStr(c?.stronger_competing_protected_subject_key).trim();
  const titleNorm = signals.titleNorm;
  const opNorm = normalizeFreeText(getOpText(j));
  const text = `${titleNorm} ${opNorm}`.trim();
  const directBugDesignLike = /\b(bug|issue|fix|broken|rework|buff|nerf|role|identity|bruiser|niche|viable|indicator|icon|tooltip|ignite|burn|qol|quality of life|major perk|minor perk|update|patch notes?)\b/.test(
    text
  );
  const weakBroadResidueOnly = !comparisonLike && !multiProtected && !creativeSecondary;
  const residueTolerable =
    directDesignBugRescue ||
    broadResidueOverride ||
    (weakBroadResidueOnly && (!explicitSecondary || directBugDesignLike));
  const upstreamAssist =
    signals.upstreamDirectAnswerablePrior === true || signals.upstreamSubjectLockPrior === true;
  const policyBlocked = candidatePolicyBlocksAggressiveRescue(c, j, signals, {
    mode: 'direct_gameplay',
  });
  const modulation = getUpstreamRescueModulation(signals);
  const threshold = clamp((upstreamAssist ? 4 : 5) + (modulation?.net_delta ?? 0), 4, 7);
  const patchBundleBlocked =
    modulation.patch_bundle_anti_rescue &&
    !strictTitlePrimary &&
    !answerSlotOwner &&
    !ownerEvidencePrimaryRescue &&
    !broadResidueOverride &&
    !directDesignBugRescue;
  const systemWrapperBlocked = ragCentrality.candidateHasSystemWrapperChallengeDemoter(c, j, signals);
  const rescueAllowed =
    !policyBlocked &&
    !patchBundleBlocked &&
    !modulation.showcase_media_anti_bypass &&
    !systemWrapperBlocked;
  return (
    rescueAllowed &&
    gameplayPrimary &&
    exactishPrimary &&
    residueTolerable &&
    noStrongerCompeting &&
    directStrength >= threshold
  );
}

function candidateHasDirectTitleSubjectLockRescue(c, j, selectedPool = [], signalsOverride = null) {
  if (!isObject(c)) return false;
  if (!isProtectedCategory(candidateCategoryLower(c))) return false;
  const signals = isObject(signalsOverride) ? signalsOverride : getDirectSubjectPolicySignals(j);
  const support = safeArray(c?.subject_support_signals).map(toStr);
  const secondary = safeArray(c?.secondary_example_signals).map(toStr);
  const strictTitlePrimary = candidateHasStrictProtectedTitlePrimary(c, j, signals);
  const answerSlotOwner = candidateEligibleForAnswerSlotSubjectRescue(c, signals, signals.titleNorm);
  const directAnswerableRescue = candidateHasDirectAnswerableRescue(c, j, signals, selectedPool);
  const ownerEvidencePrimaryRescue = candidateHasOwnerEvidencePrimaryRescueBase(
    c,
    j,
    signals,
    selectedPool
  );
  const directDesignBugRescue = candidateHasSingleSubjectDirectDesignBugRescue(
    c,
    j,
    selectedPool,
    signals
  );
  const broadResidueOverride = candidateHasBroadResidueDirectPrimaryOverride(c, j, selectedPool, signals);
  const titleMention = candidateMatchesTitleSubject(c, signals.titleNorm);
  const exactishPrimary =
    support.includes('subject:title_exact') ||
    support.includes('subject:op_exact') ||
    answerSlotOwner ||
    directAnswerableRescue ||
    ownerEvidencePrimaryRescue ||
    broadResidueOverride ||
    directDesignBugRescue ||
    strictTitlePrimary ||
    titleMention ||
    (support.includes('subject:title_anchored_primary') &&
      Number(c?.repeat_same_canonical_n || 0) >= 1);
  const directStrength = Number.isFinite(c?.subject_direct_subject_strength_dbg)
    ? c.subject_direct_subject_strength_dbg
    : candidateDirectSubjectStrengthDbg(c, j, selectedPool);
  const noStrongerCompeting =
    !toStr(c?.stronger_competing_protected_subject_key).trim() &&
    c?.stronger_competing_dbg !== true &&
    support.includes('subject:no_stronger_competing_protected_subject');
  const creatorCreditVisualBlock = candidateHasCreatorCreditVisualShowcaseBlock(
    c,
    j,
    selectedPool,
    signals
  );
  const creativeSecondary =
    candidateIsCreativeShowcaseSecondary(c, j, selectedPool, signals) ||
    c?.subject_creative_showcase_dbg === true ||
    c?.creator_credit_showcase_dbg === true ||
    secondary.includes('secondary:creative_showcase_secondary') ||
    secondary.includes('secondary:creative_showcase_thread') ||
    secondary.includes('secondary:cosmetic_visual_thread') ||
    secondary.includes('secondary:creator_credit_visual_title') ||
    secondary.includes('secondary:creator_credit_media_showcase');
  const nonexclusiveBroadPrimaryBlock = ragCentrality.candidateHasNonExclusiveBroadPrimaryBlock(
    c,
    j,
    selectedPool,
    signals
  );
  const hardCompetitionLike =
    secondary.includes('secondary:bundle_thread') ||
    nonexclusiveBroadPrimaryBlock ||
    (secondary.includes('secondary:co-mentioned_with_multiple_protected_entities') &&
      !broadResidueOverride &&
      !directDesignBugRescue) ||
    Boolean(toStr(c?.stronger_competing_protected_subject_key).trim()) ||
    c?.stronger_competing_dbg === true;
  const toleratedResidue =
    broadResidueOverride ||
    secondary.every((s) =>
    [
      'secondary:broad_general_thread',
      'secondary:broad_review_thread',
      'secondary:comparison_thread',
      'secondary:example_inside_impressions_thread',
      'secondary:not_title_primary',
      'secondary:weak_non_title_support',
      'secondary:explicit_secondary_example',
      'secondary:co-mentioned_with_multiple_protected_entities',
    ].includes(s)
  );
  const explicitSecondary =
    c?.subject_secondary_explicit_dbg === true ||
    secondary.includes('secondary:explicit_secondary_example');
  const upstreamLockAssist =
    signals.upstreamSubjectLockPrior === true || signals.upstreamDirectAnswerablePrior === true;
  const policyBlocked = candidatePolicyBlocksAggressiveRescue(c, j, signals, { mode: 'title_lock' });
  const modulation = getUpstreamRescueModulation(signals);
  const threshold = clamp((upstreamLockAssist ? 4 : 5) + (modulation?.net_delta ?? 0), 4, 7);
  const patchBundleBlocked =
    modulation.patch_bundle_anti_rescue &&
    !strictTitlePrimary &&
    !answerSlotOwner &&
    !titleMention &&
    !ownerEvidencePrimaryRescue &&
    !directDesignBugRescue;
  const systemWrapperBlocked = ragCentrality.candidateHasSystemWrapperChallengeDemoter(c, j, signals);
  return (
    !policyBlocked &&
    !patchBundleBlocked &&
    !systemWrapperBlocked &&
    !modulation.showcase_media_anti_bypass &&
    exactishPrimary &&
    noStrongerCompeting &&
    directStrength >= threshold &&
    !creatorCreditVisualBlock &&
    !hardCompetitionLike &&
    (!creativeSecondary || toleratedResidue) &&
    (!explicitSecondary || toleratedResidue)
  );
}

/** Substrings for Class A P6c — narrow creative/showcase title surface only (policy: LANE_AND_STORAGE_POLICY.md). */
const CLASS_A_P6C_CREATIVE_TITLE_SURFACES = [
  'fanart',
  'fan art',
  'cosplay',
  'concept art',
  'comic',
  'skin design',
  'mythic weapon',
  'artwork',
  'by @',
  'art by',
];

/**
 * True when normalized title matches the P6c creative tail or casual-vibes tail.
 */
function classAP6cCreativeCarveOutTitleSurface(titleNorm) {
  const t = normalizeFreeText(titleNorm || '');
  if (!t) return false;
  for (const s of CLASS_A_P6C_CREATIVE_TITLE_SURFACES) {
    if (t.includes(s)) return true;
  }
  return t.includes('morning vibes') || t.includes('vibes with');
}

/**
 * First-token blocklist so phrases like "tips and tricks … fanart" are not treated as duo-hero titles.
 */
const CLASS_A_P6C_TITLE_JOINER_HEAD_BLOCKLIST = new Set([
  'tips',
  'tricks',
  'pros',
  'cons',
  'dos',
  'donts',
  'before',
  'after',
  'why',
  'how',
  'what',
  'when',
  'where',
  'patch',
  'bugs',
  'hotfixes',
]);

/**
 * Duo-subject listing in the title head (before '('), e.g. "Zen and Ram artwork".
 * Excludes P6c so paired-hero showcase stays TRUE_SECONDARY / context-only per policy anchor.
 */
function classAP6cTitleDualSubjectJoinerLikelyExcludesCarveOut(titleNorm) {
  const head = normalizeFreeText(titleNorm || '').split('(')[0].trim();
  const m = head.match(/^(.+?)\s+(?:and|&)\s+(.+)$/i);
  if (!m) return false;
  const leftFirst = (m[1].trim().split(/\s+/)[0] || '').toLowerCase();
  const rightFirst = (m[2].trim().split(/\s+/)[0] || '').toLowerCase();
  if (leftFirst.length < 3 || rightFirst.length < 3) return false;
  if (
    CLASS_A_P6C_TITLE_JOINER_HEAD_BLOCKLIST.has(leftFirst) ||
    CLASS_A_P6C_TITLE_JOINER_HEAD_BLOCKLIST.has(rightFirst)
  ) {
    return false;
  }
  return true;
}

/**
 * P6c: single protected selected row, strict title-primary, creative/showcase secondary, not broad-multi,
 * tight title surface, no duo-subject / multi-lemma title gate.
 * When true, skip the early creative-secondary → TRUE_SECONDARY short-circuit so HARD_PRIMARY paths can win.
 */
function classAP6cSingleEntityCreativeCarveOutHolds(c, j, selectedPool, signals) {
  if (!candidateHasStrictProtectedTitlePrimary(c, j, signals)) return false;
  const pool = safeArray(selectedPool);
  const protectedSel = pool.filter((x) => isProtectedCategory(candidateCategoryLower(x)));
  if (protectedSel.length !== 1 || pool.length !== 1) return false;
  if (broadMultiProtectedThreadLike(signals, pool)) return false;
  if (!candidateIsCreativeShowcaseSecondary(c, j, pool, signals)) return false;
  if (!classAP6cCreativeCarveOutTitleSurface(signals.titleNorm)) return false;

  const resolved = safeArray(j?.entity_candidates_resolved);
  if (resolved.length) {
    const nMentions = countProtectedEntityMentionsInText(signals.titleNorm, resolved);
    if (nMentions >= 2) return false;
  }
  if (classAP6cTitleDualSubjectJoinerLikelyExcludesCarveOut(signals.titleNorm)) return false;
  return true;
}

function computeSubjectStrengthTierDbg(c, j, selectedPool = []) {
  const signals = getDirectSubjectPolicySignals(j);
  const info = candidateSubjectSupportScore(c, j, selectedPool);
  const secondary = computeSecondaryExampleSignals(c, j, selectedPool);
  c.subject_support_signals = info.subject_support_signals;
  c.secondary_example_signals = secondary;
  const supportN = safeArray(info.subject_support_signals).length;
  const directStrength = candidateDirectSubjectStrengthDbg(c, j, selectedPool);
  const explicitSecondary = candidateHasExplicitSecondaryExampleEvidence(
    c,
    j,
    signals,
    selectedPool
  );
  const secondaryProfile = uniqueBoundedStrings(
    [
      ...safeArray(ragCentrality.candidateSecondaryProfileDbg(c, j, signals, selectedPool)),
      ...safeArray(candidateCreativeShowcaseSignals(c, j, signals)),
      ...(candidateIsCreativeShowcaseSecondary(c, j, selectedPool, signals)
        ? ['secondary_profile:creative_showcase_secondary']
        : []),
      ...(candidateIsGameplayUpdatePrimary(c, j, selectedPool, signals)
        ? ['primary_profile:gameplay_update_primary']
        : []),
      ...(candidateIsGenericCommonWordProtectedNoise(c, j, signals)
        ? ['secondary_profile:generic_common_word_noise']
        : []),
    ],
    24
  );
  const hasHardTruth =
    toStr(c?.det_match_kind || c?.match_kind).toUpperCase() === 'EXACT_CANONICAL' ||
    c?.det_equivalence_pass === true;
  const rawHardBlockers = safeArray(c?.storage_blockers).map(toStr).filter(Boolean);
  const hardBlockers = rawHardBlockers.filter(
    (r) => !['storage:block_high_risk', 'storage:block_lane_soft', 'storage:block_lane_high'].includes(r)
  );
  const blockerPrimaryStr = toStr(c?.storage_blocker_primary).trim();
  const hasHardBlock =
    hardBlockers.length > 0 ||
    (!!blockerPrimaryStr &&
      !['storage:block_high_risk', 'storage:block_lane_soft', 'storage:block_lane_high'].includes(
        blockerPrimaryStr
      ));
  const creativeSecondary = candidateIsCreativeShowcaseSecondary(c, j, selectedPool, signals);
  // Same predicate as subject:question_like_thread in candidateSubjectSupportScore. Cosmetic/shop lexicon
  // can set creativeSecondary even when the thread is a direct question; do not short-circuit those to
  // TRUE_SECONDARY before HARD_PRIMARY paths (e.g. title-head shop/UX questions with strong direct strength).
  const questionLikeFromSignals =
    signals.policyQuestionAnswerable === true ||
    signals.upstreamQuestionLike === true ||
    signals.upstreamDirectAnswerablePrior === true;
  const gameplayPrimary = candidateIsGameplayUpdatePrimary(c, j, selectedPool, signals);
  const directGameplayPrimaryRescue = candidateCanRescueDirectGameplayPrimary(
    c,
    j,
    selectedPool,
    signals
  );
  const directTitleSubjectLockRescue = candidateHasDirectTitleSubjectLockRescue(
    c,
    j,
    selectedPool,
    signals
  );
  const genericNoise = candidateIsGenericCommonWordProtectedNoise(c, j, signals);
  const protectedSelectedN = safeArray(selectedPool).filter((x) =>
    isProtectedCategory(candidateCategoryLower(x))
  ).length;
  const titlePrimaryStrict = candidateHasStrictProtectedTitlePrimary(c, j, signals);
  const presumptiveDirectPrimary = candidateHasPresumptiveDirectPrimary(c, j, signals, selectedPool);
  const titleAnchoredSingle =
    protectedSelectedN === 1 &&
    candidateMatchesTitleSubject(c, signals.titleNorm) &&
    (signals.directSubjectQuestionLike === true ||
      signals.directSubjectContentLike === true ||
      ragCentrality.titleQuestionLike(signals.titleNorm));

  const classAP6cCreativeCarveActive =
    creativeSecondary &&
    !directGameplayPrimaryRescue &&
    !directTitleSubjectLockRescue &&
    !questionLikeFromSignals &&
    classAP6cSingleEntityCreativeCarveOutHolds(c, j, selectedPool, signals);

  let tier = 'TELEMETRY_ONLY';
  if (hasHardTruth && !hasHardBlock && !genericNoise) {
    if (
      creativeSecondary &&
      !directGameplayPrimaryRescue &&
      !directTitleSubjectLockRescue &&
      !questionLikeFromSignals &&
      !classAP6cCreativeCarveActive
    ) {
      tier = 'TRUE_SECONDARY';
    } else if (
      titleAnchoredSingle &&
      !titlePrimaryStrict &&
      !presumptiveDirectPrimary &&
      !creativeSecondary &&
      !explicitSecondary &&
      !info.stronger_competing_protected_subject_key &&
      !candidateHasCreatorCreditVisualShowcaseBlock(c, j, selectedPool, signals)
    ) {
      tier = 'HARD_PRIMARY';
    } else if (
      protectedSelectedN === 1 &&
      titlePrimaryStrict &&
      presumptiveDirectPrimary &&
      !creativeSecondary &&
      !explicitSecondary &&
      !info.stronger_competing_protected_subject_key &&
      !candidateHasCreatorCreditVisualShowcaseBlock(c, j, selectedPool, signals)
    ) {
      tier = 'HARD_PRIMARY';
    } else if (
      (!explicitSecondary &&
        !info.stronger_competing_protected_subject_key &&
        (gameplayPrimary ||
          directStrength >= 8 ||
          supportN >= 5 ||
          (directStrength >= 6 && supportN >= 4))) ||
      directGameplayPrimaryRescue ||
      directTitleSubjectLockRescue
    ) {
      tier = 'HARD_PRIMARY';
    } else if (directStrength >= 4 || supportN >= 2 || secondary.length > 0) {
      tier = 'TRUE_SECONDARY';
    }
  }

  return {
    ...info,
    secondary_example_signals: secondary,
    subject_strength_tier: tier,
    subject_strength_tier_dbg: tier,
    subject_secondary_explicit_dbg: explicitSecondary === true,
    subject_direct_subject_strength_dbg: directStrength,
    subject_secondary_profile_dbg: secondaryProfile,
    subject_creative_showcase_dbg: creativeSecondary === true,
    creator_credit_showcase_dbg: safeArray(candidateCreativeShowcaseSignals(c, j, signals)).some(
      (sig) =>
        sig === 'secondary:creator_credit_visual_title' ||
        sig === 'secondary:creator_credit_media_showcase'
    ),
    subject_gameplay_update_primary_dbg: gameplayPrimary === true,
    direct_gameplay_primary_rescue_dbg: directGameplayPrimaryRescue === true,
    direct_title_subject_lock_rescue_dbg: directTitleSubjectLockRescue === true,
    direct_answerable_rescue_dbg: candidateHasDirectAnswerableRescue(c, j, signals, selectedPool) === true,
    subject_generic_common_word_noise_dbg: genericNoise === true,
    subject_class_a_p6c_creative_carve_dbg: classAP6cCreativeCarveActive === true,
  };
}

function annotateSubjecthoodBundle(target, j, selectedPool = []) {
  if (!isObject(target)) return target;
  target.subject_support_signals = target.subject_support_signals ?? [];
  target.secondary_example_signals = target.secondary_example_signals ?? [];
  const dbg = computeSubjectStrengthTierDbg(target, j, selectedPool);
  target.subject_support_signals = dbg.subject_support_signals;
  target.secondary_example_signals = dbg.secondary_example_signals;
  target.subject_strength_tier = dbg.subject_strength_tier;
  target.subject_strength_tier_dbg = dbg.subject_strength_tier_dbg;
  target.same_owner_support_n = dbg.same_owner_support_n;
  target.repeat_same_canonical_n = dbg.repeat_same_canonical_n;
  target.stronger_competing_protected_subject_key = dbg.stronger_competing_protected_subject_key;
  target.subject_secondary_explicit_dbg = dbg.subject_secondary_explicit_dbg === true;
  target.subject_direct_subject_strength_dbg = Number.isFinite(dbg.subject_direct_subject_strength_dbg)
    ? dbg.subject_direct_subject_strength_dbg
    : 0;
  target.subject_secondary_profile_dbg = safeArray(dbg.subject_secondary_profile_dbg);
  target.subject_creative_showcase_dbg = dbg.subject_creative_showcase_dbg === true;
  target.creator_credit_showcase_dbg = dbg.creator_credit_showcase_dbg === true;
  target.subject_gameplay_update_primary_dbg = dbg.subject_gameplay_update_primary_dbg === true;
  target.direct_gameplay_primary_rescue_dbg = dbg.direct_gameplay_primary_rescue_dbg === true;
  target.direct_title_subject_lock_rescue_dbg = dbg.direct_title_subject_lock_rescue_dbg === true;
  target.direct_answerable_rescue_dbg = dbg.direct_answerable_rescue_dbg === true;
  target.subject_generic_common_word_noise_dbg = dbg.subject_generic_common_word_noise_dbg === true;
  target.subject_class_a_p6c_creative_carve_dbg = dbg.subject_class_a_p6c_creative_carve_dbg === true;
  target.subjecthood_annotation_present_dbg = true;
  if (!toStr(target.subjecthood_authority_source_dbg).trim())
    target.subjecthood_authority_source_dbg = 'annotated_live';
  return target;
}

function extractStorageHardBlockers(storageReasons) {
  const blockers = safeArray(storageReasons)
    .map(toStr)
    .filter((r) => r.startsWith('storage:block_'));
  return blockers.filter((r) => !['storage:block_lane_soft', 'storage:block_lane_high'].includes(r));
}

function deriveFallbackSubjecthoodTier(c, j, selectedPool = []) {
  if (!isObject(c) || !isProtectedCategory(candidateCategoryLower(c))) return '';
  const signals = getDirectSubjectPolicySignals(j);
  const genericNoise = candidateIsGenericCommonWordProtectedNoise(c, j, signals);
  if (genericNoise) return 'TELEMETRY_ONLY';

  const creativeSecondary = candidateIsCreativeShowcaseSecondary(c, j, selectedPool, signals);
  const gameplayPrimary = candidateIsGameplayUpdatePrimary(c, j, selectedPool, signals);
  const exactCanonical = toStr(c?.det_match_kind || c?.match_kind || '').toUpperCase() === 'EXACT_CANONICAL';
  const hasTitleOp = c?.evidence_summary?.has_title_op === true || hasTitleOrOpEvidence(c?.evidence);
  const topicalityStrong = c?.det_topicality_strong === true;
  const titlePrimary = candidateHasStrictProtectedTitlePrimary(c, j, signals);
  const directKeep = candidateHasProtectedDirectSubjectKeep(c, j, signals, selectedPool);
  const currentIntent = toStr(c?.storage_intent).toUpperCase();
  const primaryReason = toStr(c?.storage_reason_primary || firstNonEmptyString(safeArray(c?.storage_reasons)) || '');

  if (creativeSecondary) return 'TRUE_SECONDARY';
  if (gameplayPrimary && exactCanonical && hasTitleOp && topicalityStrong) return 'HARD_PRIMARY';
  if ((titlePrimary || directKeep) && exactCanonical && hasTitleOp && topicalityStrong && currentIntent === 'RAG_OK')
    return 'HARD_PRIMARY';
  if (primaryReason === 'storage:context_only:subject_true_secondary') return 'TRUE_SECONDARY';
  if (primaryReason === 'storage:none_subjecthood_telemetry_only') return 'TELEMETRY_ONLY';
  if (currentIntent === 'CONTEXT_ONLY') return 'TRUE_SECONDARY';
  if (currentIntent === 'NONE') return 'TELEMETRY_ONLY';
  if (currentIntent === 'RAG_OK' && exactCanonical && hasTitleOp && topicalityStrong) return 'HARD_PRIMARY';
  return '';
}

function candidateHasSubjecthoodHighRiskBypass(c, j, selectedPool = [], signalsOverride = null) {
  if (!isObject(c)) return false;
  const signals = isObject(signalsOverride) ? signalsOverride : getDirectSubjectPolicySignals(j);
  const support = safeArray(c?.subject_support_signals).map(toStr);
  const secondary = safeArray(c?.secondary_example_signals).map(toStr);
  const tier = toStr(c?.subject_strength_tier || c?.subject_strength_tier_dbg);
  const exactPrimary =
    support.includes('subject:title_exact') ||
    support.includes('subject:op_exact') ||
    support.includes('subject:title_anchored_primary') ||
    support.includes('subject:answer_slot_owner');
  const directThread =
    support.includes('subject:help_howto_thread') ||
    support.includes('subject:stat_meta_thread') ||
    support.includes('subject:news_update_thread') ||
    c?.subject_gameplay_update_primary_dbg === true;
  const creatorCreditVisualBlock = candidateHasCreatorCreditVisualShowcaseBlock(c, j, selectedPool, signals);
  const creativeSecondary =
    c?.subject_creative_showcase_dbg === true ||
    c?.creator_credit_showcase_dbg === true ||
    secondary.includes('secondary:creative_showcase_secondary') ||
    secondary.includes('secondary:creative_showcase_thread') ||
    secondary.includes('secondary:cosmetic_visual_thread') ||
    secondary.includes('secondary:creator_credit_visual_title') ||
    secondary.includes('secondary:creator_credit_media_showcase');
  const safeSecondary =
    !secondary.includes('secondary:bundle_thread') &&
    !secondary.includes('secondary:co-mentioned_with_multiple_protected_entities') &&
    !creativeSecondary &&
    !creatorCreditVisualBlock;
  const directGameplayPrimaryRescue = candidateCanRescueDirectGameplayPrimary(c, j, selectedPool, signals);
  const directTitleSubjectLockRescue = candidateHasDirectTitleSubjectLockRescue(c, j, selectedPool, signals);
  // Broad review / opinion threads are weaker retrieval heads (policy: true-but-softer context). Upstream or OP
  // can look question-like while the title is still a vibecheck/impressions head; use title-head / direct-subject
  // question cues only — not policyQuestionAnswerable or OP-only intent — so merch/feels threads do not get the
  // same high-risk bypass as direct-issue titles (shop highlight WHY, Should-JQ balance, etc.). Narrow the
  // bypass block to titles that match the small vibecheck/identity-framing cluster so general broad threads are
  // not collateral-demoted.
  const titleHeadDirectQuestionLike =
    titleNormDirectSubjectQuestionPattern(signals.titleNorm) ||
    ragCentrality.titleQuestionLike(signals.titleNorm);
  const broadOpinionReviewLikeThread =
    signals.policyReviewOrOpinionLike === true || signals.broadReviewLike === true;
  const vibecheckOrIdentityFramingTitleHead = /\b(vibecheck|impressions|thoughts on)\b|\bas a\b/i.test(
    normalizeFreeText(signals.titleNorm)
  );
  const opinionThreadWithoutTitleQuestion =
    broadOpinionReviewLikeThread && !titleHeadDirectQuestionLike && vibecheckOrIdentityFramingTitleHead;
  const policyBlocked = candidatePolicyBlocksAggressiveRescue(c, j, signals, { mode: 'high_risk_bypass' });
  const modulation = getUpstreamRescueModulation(signals);
  if (creatorCreditVisualBlock || policyBlocked || modulation.showcase_media_anti_bypass) return false;
  if (modulation.patch_bundle_anti_rescue && !directTitleSubjectLockRescue) return false;
  return (
    !toStr(c?.stronger_competing_protected_subject_key).trim() &&
    !opinionThreadWithoutTitleQuestion &&
    ((tier === 'HARD_PRIMARY' && exactPrimary && directThread && safeSecondary && modulation.net_delta <= 1) ||
      directGameplayPrimaryRescue ||
      directTitleSubjectLockRescue)
  );
}

function buildPostSubjecthoodSummary(selectedPool = []) {
  const protectedSelected = safeArray(selectedPool).filter((c) =>
    isProtectedCategory(c?.category || c?.entity_type || c?.dictionary_entity_type)
  );
  let hard = 0;
  let secondary = 0;
  let titlePrimary = 0;
  for (const c of protectedSelected) {
    const tier = toStr(c?.subject_strength_tier || c?.subject_strength_tier_dbg);
    if (tier === 'HARD_PRIMARY') hard += 1;
    else if (tier === 'TRUE_SECONDARY') secondary += 1;
    if (
      safeArray(c?.subject_support_signals).includes('subject:title_anchored_primary') ||
      safeArray(c?.subject_support_signals).includes('subject:title_exact')
    )
      titlePrimary += 1;
  }
  return {
    protected_title_primary_subject_n: titlePrimary,
    protected_true_secondary_n: secondary,
    protected_hard_primary_n: hard,
  };
}

function buildSubjecthoodAuthoritySummary(selectedPool = []) {
  const out = {
    protected_selected_n: 0,
    subjecthood_annotation_present_n: 0,
    subjecthood_blank_tier_n: 0,
    hard_primary_n: 0,
    true_secondary_n: 0,
    telemetry_only_n: 0,
    creative_showcase_n: 0,
    gameplay_update_primary_n: 0,
    generic_common_word_noise_n: 0,
    authority_applied_n: 0,
    authority_promoted_to_rag_n: 0,
    authority_rewritten_rag_n: 0,
    authority_rewritten_context_n: 0,
    authority_demoted_to_none_n: 0,
    live_mapping_n: 0,
  };
  for (const c of safeArray(selectedPool)) {
    if (!isProtectedCategory(candidateCategoryLower(c))) continue;
    out.protected_selected_n += 1;
    if (c?.subjecthood_annotation_present_dbg === true) out.subjecthood_annotation_present_n += 1;
    const tier = toStr(c?.subject_strength_tier || c?.subject_strength_tier_dbg);
    if (!tier) out.subjecthood_blank_tier_n += 1;
    if (tier === 'HARD_PRIMARY') out.hard_primary_n += 1;
    else if (tier === 'TRUE_SECONDARY') out.true_secondary_n += 1;
    else if (tier === 'TELEMETRY_ONLY') out.telemetry_only_n += 1;
    if (c?.subject_creative_showcase_dbg === true) out.creative_showcase_n += 1;
    if (c?.subject_gameplay_update_primary_dbg === true) out.gameplay_update_primary_n += 1;
    if (c?.subject_generic_common_word_noise_dbg === true) out.generic_common_word_noise_n += 1;
    if (c?.subjecthood_authority_applied_dbg === true) out.authority_applied_n += 1;
    if (c?.subject_tier_lane_mapping_live === true) out.live_mapping_n += 1;
    const authorityReason = toStr(
      c?.subjecthood_authority_reason_dbg ||
        c?.storage_reason_primary ||
        firstNonEmptyString(safeArray(c?.storage_reasons)) ||
        ''
    );
    if (authorityReason.startsWith('storage:rag_ok:subject_hard_primary')) {
      out.authority_rewritten_rag_n += 1;
      if (toStr(c?.storage_intent).toUpperCase() === 'RAG_OK') out.authority_promoted_to_rag_n += 1;
    } else if (authorityReason === 'storage:context_only:subject_true_secondary') {
      out.authority_rewritten_context_n += 1;
    } else if (authorityReason === 'storage:none_subjecthood_telemetry_only') {
      out.authority_demoted_to_none_n += 1;
    }
  }
  return out;
}

module.exports = {
  computeSubjectStrengthTierDbg,
  annotateSubjecthoodBundle,
  buildPostSubjecthoodSummary,
  buildSubjecthoodAuthoritySummary,
  candidateSubjectSupportScore,
  computeSecondaryExampleSignals,
  extractStorageHardBlockers,
  deriveFallbackSubjecthoodTier,
  candidateHasSubjecthoodHighRiskBypass,
  broadResidueSignalsOnly,
  estimateBroadResidueDirectStrength,
  candidateHasBroadResidueDirectPrimaryOverride,
  candidateHasCreatorCreditVisualShowcaseBlock,
  candidateIsCreativeShowcaseSecondary,
  candidateCanRescueDirectGameplayPrimary,
  candidateHasDirectTitleSubjectLockRescue,
};

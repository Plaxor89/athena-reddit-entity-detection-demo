// ragCentrality.js - RAG centrality detection, shape classification, and candidate predicates.
// Used by protected stage profile, demotions, subjecthood.

const {
  getDirectSubjectPolicySignals,
  getTitleText,
  getOpText,
  normalizeFreeText,
  firstNonEmptyString,
  isObject,
  safeArray,
  toStr,
} = require('./directSubjectPolicySignals');
const { isProtectedCategory, isHeroOrMapCategory, isAbilityOrPerkCategory } = require('./storageIntent');

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function prefixOf(reason) {
  const s = toStr(reason);
  const i = s.indexOf(':');
  return i > 0 ? s.slice(0, i) : 'other';
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

function stableKey(c) {
  return `${toStr(c?.category || c?.entity_type)}||${toStr(c?.canonical_slug)}||${toStr(c?.dictionary_entity_type)}`;
}

function normSourceType(st) {
  return toStr(st).trim().toLowerCase();
}

function hasTitleOrOpEvidence(evList) {
  for (const ev of safeArray(evList)) {
    const st = normSourceType(ev?.source_type);
    if (st === 'title' || st === 'op') return true;
  }
  return false;
}

function hasCommentEvidence(evList) {
  for (const ev of safeArray(evList)) {
    if (normSourceType(ev?.source_type) === 'comment') return true;
  }
  return false;
}

function countEvidenceBySourceType(evList, sourceType) {
  let n = 0;
  const want = normSourceType(sourceType);
  for (const ev of safeArray(evList)) {
    if (normSourceType(ev?.source_type) === want) n += 1;
  }
  return n;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function titleContainsNorm(titleNorm, candNorm) {
  const tRaw = normalizeFreeText(titleNorm);
  const c = normalizeFreeText(candNorm);
  if (!tRaw || !c) return false;
  const t = tRaw.replace(/\u2019/g, "'").replace(/\u2018/g, "'");
  if (t === c) return true;
  const spaced = ` ${t} `;
  if (spaced.includes(` ${c} `)) return true;
  if (spaced.includes(` ${c}'s `)) return true;
  const word = new RegExp(`\\b${escapeRegExp(c)}(?:'s|\\u2019s)?\\b`, 'i');
  if (word.test(t)) return true;
  const tHyph = t.replace(/-/g, ' ');
  const cHyph = c.replace(/-/g, ' ');
  if (cHyph !== c) {
    const wordSpaced = new RegExp(`\\b${escapeRegExp(cHyph)}(?:'s|\\u2019s)?\\b`, 'i');
    if (wordSpaced.test(tHyph)) return true;
  }
  return false;
}

/** Compact slug for prefix checks (hyphens/spaces stripped). */
function compactHeroSlugForTitleHead(c) {
  const raw = firstNonEmptyString([
    c?.canonical_slug,
    c?.hero_slug,
    c?.canonical_name,
    c?.label_dbg,
    c?.label,
  ]);
  return normalizeFreeText(toStr(raw)).replace(/[^a-z0-9]/g, '');
}

/**
 * Title uses a short head that is a strict prefix of the hero's canonical slug (e.g. "doom" → doomfist).
 * Narrow: hero only, slug length floor, token length floor, prefix only (not full slug — aliases handle that).
 */
function heroCanonicalTitleHeadAnchorsSubject(c, titleNorm) {
  if (toStr(c?.category || c?.entity_type || c?.dictionary_entity_type).toLowerCase() !== 'hero') return false;
  const slug = compactHeroSlugForTitleHead(c);
  if (slug.length < 7) return false;
  const title = normalizeFreeText(titleNorm).replace(/\u2019/g, "'").replace(/\u2018/g, "'");
  if (!title) return false;
  const tokens = title.match(/\b[a-z0-9]+\b/g);
  if (!tokens) return false;
  for (const token of tokens) {
    if (token.length < 4 || token.length >= slug.length) continue;
    if (slug.startsWith(token)) return true;
  }
  return false;
}

function candidateMatchesTitleSubject(c, titleNorm) {
  const title = normalizeFreeText(titleNorm);
  if (!title) return false;
  const variants = uniqueBoundedStrings(
    [
      c?.label_dbg,
      c?.label,
      c?.canonical_name,
      c?.canonical_slug,
      c?.entity_key_dbg,
      c?.entity_key,
      ...safeArray(c?.alias_norms),
    ]
      .map((v) => normalizeFreeText(v))
      .filter(Boolean),
    16
  );
  if (variants.some((v) => titleContainsNorm(title, v))) return true;
  return heroCanonicalTitleHeadAnchorsSubject(c, titleNorm);
}

function candidateMatchesOpSubject(c, opNorm) {
  const op = normalizeFreeText(opNorm);
  if (!op) return false;
  const variants = uniqueBoundedStrings(
    [c?.label_dbg, c?.label, c?.canonical_name, c?.canonical_slug, ...safeArray(c?.alias_norms)]
      .map((v) => normalizeFreeText(v))
      .filter(Boolean),
    16
  );
  return variants.some((v) => titleContainsNorm(op, v));
}

function ownerHeroTitlePrimary(ownerEvidence) {
  return ownerEvidence?.owner_hero_title_primary === true;
}

function competingHeroTitlePrimary(ownerEvidence) {
  return ownerEvidence?.competing_hero_title_primary === true;
}

function candidateOwnsTitleSubject(c, titleNorm) {
  if (candidateMatchesTitleSubject(c, titleNorm)) return true;
  const ownerEvidence = isObject(c?.owner_evidence) ? c.owner_evidence : {};
  return ownerHeroTitlePrimary(ownerEvidence) && !competingHeroTitlePrimary(ownerEvidence);
}

function computeSameOwnerSupportN(c) {
  const owner = isObject(c?.owner_evidence) ? c.owner_evidence : {};
  let n = 0;
  if (owner?.owner_exact_title_op_support === true) n += 1;
  if (owner?.owner_same_source_exact_canonical === true) n += 1;
  if (owner?.owner_title_op_support === true) n += 1;
  if (owner?.same_hero_context_unlock === true) n += 1;
  if (owner?.owner_context_ready_tier2 === true) n += 1;
  if (owner?.owner_context_ready_tier3 === true) n += 1;
  return n;
}

function computeOwnerEvidenceStrength(c) {
  const owner = isObject(c?.owner_evidence) ? c.owner_evidence : {};
  let n = 0;
  if (owner?.owner_exact_title_op_support === true) n += 3;
  if (owner?.owner_same_source_exact_canonical === true) n += 2;
  if (owner?.owner_title_op_support === true) n += 1;
  if (owner?.same_hero_context_unlock === true) n += 2;
  if (owner?.owner_context_ready_tier2 === true) n += 1;
  if (owner?.owner_context_ready_tier3 === true) n += 1;
  return n;
}

function computeRepeatSameCanonicalN(c) {
  const ev = safeArray(c?.evidence);
  const titleEv = countEvidenceBySourceType(ev, 'title') > 0 ? 1 : 0;
  const opEv = countEvidenceBySourceType(ev, 'op') > 0 ? 1 : 0;
  const commentEv = countEvidenceBySourceType(ev, 'comment') > 0 ? 1 : 0;
  return titleEv + opEv + commentEv;
}

function getPolicyObj(c) {
  return isObject(c?.policy) ? c.policy : null;
}

function candidateEffectivePolicySummary(c) {
  const policy = getPolicyObj(c) || {};
  const tier = toStr(policy?.tier).trim().toUpperCase() || null;
  const promotionRisk = toStr(policy?.promotion_risk).trim().toUpperCase() || null;
  const collisionCountRaw = Number(policy?.alias_collision_count);
  const collisionCount = Number.isFinite(collisionCountRaw) ? collisionCountRaw : 0;
  const requiresAnchor = policy?.requires_anchor === true || !!toStr(policy?.anchor_group).trim();
  const requiresOwContext = policy?.requires_ow_context === true;
  const commentCorroborationRequired = policy?.comment_only_requires_corroboration === true;
  const allowHighTierOnly = policy?.allow_high_tier_only === true;
  const preferCanonical = policy?.prefer_canonical_over_alias === true;
  const shortAlias = policy?.short_alias === true;
  const commonWordRisk = policy?.alias_common_word_risk === true;
  const collisionRiskHigh = collisionCount > 1;
  const aliasRiskHigh = Boolean(
    allowHighTierOnly ||
      commonWordRisk ||
      shortAlias ||
      collisionRiskHigh ||
      promotionRisk === 'HIGH' ||
      promotionRisk === 'RISKY'
  );
  return {
    tier,
    promotion_risk: promotionRisk,
    requires_anchor: requiresAnchor,
    requires_ow_context: requiresOwContext,
    comment_corroboration_required: commentCorroborationRequired,
    allow_high_tier_only: allowHighTierOnly,
    prefer_canonical: preferCanonical,
    short_alias: shortAlias,
    common_word_risk: commonWordRisk,
    collision_count: collisionCount,
    collision_risk_high: collisionRiskHigh,
    alias_risk_high: aliasRiskHigh,
  };
}

function candidatePolicyRescueBlockReasons(c, j, signalsOverride = null, opts = {}) {
  if (!isObject(c)) return [];
  const policySummary = candidateEffectivePolicySummary(c);
  if (
    !policySummary.alias_risk_high &&
    !policySummary.requires_anchor &&
    !policySummary.requires_ow_context &&
    !policySummary.comment_corroboration_required &&
    !policySummary.prefer_canonical &&
    !policySummary.allow_high_tier_only
  )
    return [];
  const signals = isObject(signalsOverride) ? signalsOverride : getDirectSubjectPolicySignals(j);
  const titleNorm = signals.titleNorm;
  const opNorm = normalizeFreeText(getOpText(j));
  const ev = safeArray(c?.evidence);
  const hasTitleOp = c?.evidence_summary?.has_title_op === true || hasTitleOrOpEvidence(ev);
  const commentOnly = hasCommentEvidence(ev) && !hasTitleOp;
  const exactCanonical = toStr(c?.det_match_kind || c?.match_kind).toUpperCase() === 'EXACT_CANONICAL';
  const titleMention = candidateMatchesTitleSubject(c, titleNorm);
  const opMention = candidateMatchesOpSubject(c, opNorm);
  const sameOwnerSupportN = computeSameOwnerSupportN(c);
  const repeatSameCanonicalN = computeRepeatSameCanonicalN(c);
  const ownerEvidence = isObject(c?.owner_evidence) ? c.owner_evidence : {};
  const ownerTitleSupport =
    ownerEvidence?.owner_exact_title_op_support === true ||
    ownerEvidence?.owner_same_source_exact_canonical === true ||
    ownerEvidence?.owner_title_op_support === true;
  const anchorSatisfied =
    exactCanonical ||
    hasTitleOp ||
    titleMention ||
    opMention ||
    ownerTitleSupport ||
    sameOwnerSupportN > 0 ||
    repeatSameCanonicalN >= 2;
  const corroborated = anchorSatisfied || (!commentOnly && (sameOwnerSupportN > 0 || repeatSameCanonicalN >= 2));
  const mode = toStr(opts?.mode).trim().toLowerCase() || 'general';
  const out = [];
  if (policySummary.comment_corroboration_required && commentOnly && !corroborated)
    out.push('policy:comment_corroboration_required');
  if (policySummary.requires_anchor && !anchorSatisfied) out.push('policy:requires_anchor');
  if (policySummary.requires_ow_context && !anchorSatisfied) out.push('policy:requires_ow_context');
  if (
    policySummary.common_word_risk &&
    !exactCanonical &&
    !titleMention &&
    !opMention &&
    sameOwnerSupportN === 0 &&
    repeatSameCanonicalN < 2
  )
    out.push('policy:common_word_risk');
  if (
    policySummary.collision_risk_high &&
    !exactCanonical &&
    sameOwnerSupportN === 0 &&
    repeatSameCanonicalN < 2
  )
    out.push('policy:collision_risk_high');
  if (
    policySummary.prefer_canonical &&
    !exactCanonical &&
    !titleMention &&
    !opMention &&
    sameOwnerSupportN === 0
  )
    out.push('policy:prefer_canonical');
  if (
    policySummary.allow_high_tier_only &&
    !exactCanonical &&
    repeatSameCanonicalN < 2 &&
    sameOwnerSupportN === 0
  )
    out.push('policy:allow_high_tier_only');
  if (
    mode === 'answer_slot' &&
    policySummary.alias_risk_high &&
    !exactCanonical &&
    !ownerTitleSupport &&
    repeatSameCanonicalN < 2
  )
    out.push('policy:answer_slot_alias_risk');
  return uniqueBoundedStrings(out, 12);
}

function candidatePolicyBlocksAggressiveRescue(c, j, signalsOverride = null, opts = {}) {
  return candidatePolicyRescueBlockReasons(c, j, signalsOverride, opts).length > 0;
}

function getUpstreamRescueModulation(signals) {
  const s = isObject(signals) ? signals : {};
  const priorConfidenceRaw = Number(s?.upstreamPriorConfidence);
  const priorConfidence = Number.isFinite(priorConfidenceRaw) ? priorConfidenceRaw : 0;
  const reliabilityRaw = Number(s?.upstreamReliabilityWeight);
  const reliabilityWeight = Number.isFinite(reliabilityRaw) ? reliabilityRaw : null;
  let dampeners = 0;
  let boosters = 0;
  const reasons = [];
  const blockers = [];
  if (s?.upstreamLowSignal === true) {
    dampeners += 1;
    reasons.push('upstream:low_signal');
  }
  if (s?.upstreamSarcastic === true) {
    dampeners += 1;
    reasons.push('upstream:sarcastic_or_ironic');
  }
  if (reliabilityWeight !== null && reliabilityWeight < 0.35) {
    dampeners += 2;
    reasons.push('upstream:low_reliability');
  } else if (reliabilityWeight !== null && reliabilityWeight < 0.5) {
    dampeners += 1;
    reasons.push('upstream:mid_reliability');
  }
  if (priorConfidence >= 0.7) {
    boosters += 1;
    reasons.push('upstream:high_prior_confidence');
  }
  if (
    s?.upstreamDirectAnswerablePrior === true &&
    s?.upstreamHasGoodAnswer === true &&
    s?.upstreamLowSignal !== true &&
    s?.upstreamSarcastic !== true &&
    (reliabilityWeight === null || reliabilityWeight >= 0.45)
  ) {
    boosters += 1;
    reasons.push('upstream:answerable_confident');
  }
  const patchBundleAntiRescue =
    s?.upstreamPatchBundlePrior === true &&
    s?.upstreamSubjectLockPrior !== true &&
    s?.upstreamDirectAnswerablePrior !== true;
  if (patchBundleAntiRescue) {
    dampeners += 1;
    reasons.push('upstream:patch_bundle_anti_rescue');
    blockers.push('patch_bundle_weak_rescue');
  }
  const showcaseAntiBypass = s?.upstreamShowcaseVisualPrior === true && s?.upstreamHasMediaEvidence === true;
  if (showcaseAntiBypass) {
    reasons.push('upstream:showcase_media_anti_bypass');
    blockers.push('showcase_media_anti_bypass');
  }
  const netDelta = clamp(dampeners - boosters, 0, 2);
  return {
    prior_confidence: priorConfidence,
    reliability_weight: reliabilityWeight,
    dampeners,
    boosters,
    net_delta: netDelta,
    patch_bundle_anti_rescue: patchBundleAntiRescue,
    showcase_media_anti_bypass: showcaseAntiBypass,
    weak_rescue_blocked: patchBundleAntiRescue && boosters === 0,
    strong_dampening: dampeners >= 2 && boosters === 0,
    reasons: uniqueBoundedStrings(reasons, 12),
    blockers: uniqueBoundedStrings(blockers, 8),
  };
}

function candidateEligibleForAnswerSlotSubjectRescue(c, info, titleNorm) {
  if (!isObject(c) || !isObject(info) || info.answer_slot_subject_rescue_allowed !== true) return false;
  if (candidatePolicyBlocksAggressiveRescue(c, null, info, { mode: 'answer_slot' })) return false;
  const modulation = getUpstreamRescueModulation(info);
  const ev = safeArray(c?.evidence);
  const hasTitleOp = c?.evidence_summary?.has_title_op === true || hasTitleOrOpEvidence(ev);
  const commentOnly = c?.det_comment_only === true || (hasCommentEvidence(ev) && !hasTitleOp);
  if (modulation.showcase_media_anti_bypass && commentOnly) return false;
  if (modulation.weak_rescue_blocked && commentOnly) return false;
  const ownerEvidence = isObject(c?.owner_evidence) ? c.owner_evidence : {};
  const ownerExactSupport =
    ownerEvidence?.owner_exact_title_op_support === true ||
    ownerEvidence?.owner_same_source_exact_canonical === true;
  const ownerTitleSupport = ownerEvidence?.owner_title_op_support === true;
  const ownsTitle = candidateOwnsTitleSubject(c, titleNorm);
  const sameOwnerSupportN = computeSameOwnerSupportN(c);
  const repeatSameCanonicalN = computeRepeatSameCanonicalN(c);
  if (modulation.strong_dampening && !ownsTitle && !ownerExactSupport && repeatSameCanonicalN < 2) return false;
  if (
    info?.answer_slot_contradiction === true &&
    !(ownsTitle || ownerExactSupport || repeatSameCanonicalN >= 2)
  )
    return false;
  if (info?.upstreamPatchBundlePrior === true && !(ownsTitle || ownerExactSupport)) return false;
  if (ownsTitle) return true;
  return (
    ownerHeroTitlePrimary(ownerEvidence) &&
    !competingHeroTitlePrimary(ownerEvidence) &&
    (ownerExactSupport ||
      ownerTitleSupport ||
      sameOwnerSupportN > 0 ||
      repeatSameCanonicalN >= 2)
  );
}

function titleSubjectCategoryLike(titleNorm) {
  const title = normalizeFreeText(titleNorm);
  if (!title) return false;
  return /\b(win[- ]rate|pick[- ]rate|stats?|meta|main|mains|otp|one[- ]trick|tips?|guide|help|question|bug|issue|concept|mythic|weapon|skin|buff|nerf|rework|news|update|announce|announcement|released|release|coming|idea|viable|playstyle|niche|counter|counters?|highlight|intro|spray|emote|voice line|wall climb|wall-climb|pickup|pick up)\b/.test(
    title
  );
}

function titleQuestionLike(titleNorm) {
  return /\b(how|why|what|which|who|when|where|can|does|did|do|is|are|was|were|should|could|would|has|have)\b/.test(
    normalizeFreeText(titleNorm)
  );
}

function titleDirectShapeLike(titleNorm, opNorm = '') {
  const text = `${normalizeFreeText(titleNorm)} ${normalizeFreeText(opNorm)}`.trim();
  if (!text) return false;
  return /\b(how do i|help|guide|tips?|question|bug|issue|fix|counter|counters?|playstyle|viable|niche|win[- ]rate|pick[- ]rate|stats?|meta|performance|buff|nerf|rework|news|update|announce|announcement|release|released|coming|concept|mythic|weapon|skin|idea|highlight|intro|pickup|pick up|wall climb|wall-climb)\b/.test(
    text
  );
}

/** Map is title-anchored and the thread is gameplay/readability feedback (not hero showcase). */
function mapEnvironmentFeedbackThreadLike(cat, titleMention, titleNorm, opNorm) {
  if (toStr(cat).toLowerCase() !== 'map' || titleMention !== true) return false;
  const text = `${normalizeFreeText(titleNorm)} ${normalizeFreeText(opNorm)}`.trim();
  if (!text) return false;
  return (
    /\b(blizzard\s+world|map\s+variant|map\s+skin|ilios|eichenwalde|hollywood|kings\s+row|colosseo|new\s+junk\s+city)\b/i.test(
      text
    ) &&
    /\b(sunset|night\s+mode|readability|too\s+similar|colou?rs?|colors?|muted|invisibility\s+filter|purpl(e|ish)?|vote|terrible|awful|horrible|broken|fix|playability|visibility)\b/.test(
      text
    )
  );
}

function packGateIsHardBlock(gate) {
  const g = toStr(gate).trim().toLowerCase();
  if (!g) return false;
  return g.includes('deny') || g.includes('block') || g.includes('reject');
}

function candidateHasSystemWrapperChallengeDemoter(c, j, signalsOverride = null) {
  if (!isObject(c)) return false;
  const cat = toStr(c?.category || c?.entity_type || c?.dictionary_entity_type).toLowerCase();
  if (!(cat === 'ability' || cat === 'perk')) return false;
  const signals = isObject(signalsOverride) ? signalsOverride : getDirectSubjectPolicySignals(j);
  const titleNorm = signals.titleNorm;
  const opNorm = normalizeFreeText(getOpText(j));
  const text = `${titleNorm} ${opNorm}`.trim();
  if (!text) return false;
  const progressionWrapperLike = /\b(challenge|challenges|progress|progression|quest|quests|task|tasks|weekly|daily|milestone|complete|completion|credit|tracker|tracking|not counting|not count|counting|register|registered|reward|rewards|xp|battle pass|battlepass|unlock|unlocks|achievement|achievements)\b/.test(
    text
  );
  if (!progressionWrapperLike) return false;
  const directEntityFrameLike = /\b(bug|issue|fix|broken|rework|buff|nerf|viable|niche|guide|tips?|help|how do i|counter|counters?|win[- ]rate|pick[- ]rate|stats?|meta|performance|patch notes?|update|announcement|released|coming|role|identity|matchup|advice|ui|hud|indicator|icon|tooltip|ignite|burn|qol|quality of life)\b/.test(
    text
  );
  if (directEntityFrameLike) return false;
  const primaryLabel = firstNonEmptyString([
    c?.label_dbg,
    c?.label,
    c?.canonical_name,
    c?.canonical_slug,
  ]);
  const titleStartsWithEntity =
    candidateMatchesTitleSubject(c, titleNorm) && titleContainsNorm(titleNorm, primaryLabel);
  const strictTitlePrimary = candidateHasStrictProtectedTitlePrimaryRaw(c, j, signals);
  const answerSlotOwner = candidateEligibleForAnswerSlotSubjectRescue(c, signals, titleNorm);
  const ownerEvidencePrimaryRescue = candidateHasOwnerEvidencePrimaryRescueBase(c, j, signals, []);
  return !strictTitlePrimary && !answerSlotOwner && !ownerEvidencePrimaryRescue && !titleStartsWithEntity;
}

function candidateHasStrictProtectedTitlePrimaryRaw(c, j, signalsOverride = null) {
  if (!isObject(c)) return false;
  const cat = toStr(c?.category || c?.entity_type || c?.dictionary_entity_type).toLowerCase();
  if (!isProtectedCategory(cat)) return false;
  const signals = isObject(signalsOverride) ? signalsOverride : getDirectSubjectPolicySignals(j);
  const titleNorm = signals.titleNorm;
  const titleMention = candidateMatchesTitleSubject(c, titleNorm);
  if (!titleMention) return false;
  const ownedTitleSubject = candidateOwnsTitleSubject(c, titleNorm);
  const title = ` ${normalizeFreeText(titleNorm)} `;
  const variants = uniqueBoundedStrings(
    [c?.label_dbg, c?.label, c?.canonical_name, c?.canonical_slug, ...safeArray(c?.alias_norms)]
      .map((v) => normalizeFreeText(v))
      .filter(Boolean),
    12
  );
  const titleStartsWithEntity = variants.some((v) => title.startsWith(` ${v} `));
  const answerSlotKeep = candidateEligibleForAnswerSlotSubjectRescue(c, signals, titleNorm);
  const broadLike =
    signals.broadReviewLike === true ||
    signals.policyReviewOrOpinionLike === true ||
    signals.policyBroadGeneral === true ||
    signals.broadBundleLike === true ||
    signals.explicitComparisonLike === true ||
    signals.title_explicit_comparison_like === true ||
    signals.policyNewsLike === true;
  if (broadLike) {
    return titleStartsWithEntity || ownedTitleSubject || answerSlotKeep;
  }
  return (
    titleStartsWithEntity ||
    ownedTitleSubject ||
    answerSlotKeep ||
    signals.directSubjectQuestionLike === true ||
    signals.directSubjectContentLike === true ||
    titleSubjectCategoryLike(titleNorm) ||
    titleQuestionLike(titleNorm) ||
    (signals.policySubjectFavoring === true &&
      signals.policyBroadGeneral !== true &&
      !signals.broadBundleLike)
  );
}

function candidateHasStrictProtectedTitlePrimary(c, j, signalsOverride = null) {
  const signals = isObject(signalsOverride) ? signalsOverride : getDirectSubjectPolicySignals(j);
  if (!candidateHasStrictProtectedTitlePrimaryRaw(c, j, signals)) return false;
  if (candidateHasSystemWrapperChallengeDemoter(c, j, signals)) return false;
  return true;
}

function candidateHasOwnedSurfaceSubjectSupport(c, j, signalsOverride = null) {
  if (!isObject(c)) return false;
  const signals = isObject(signalsOverride) ? signalsOverride : getDirectSubjectPolicySignals(j);
  const titleNorm = signals.titleNorm;
  const opNorm = normalizeFreeText(getOpText(j));
  const sameOwnerSupportN = computeSameOwnerSupportN(c);
  if (sameOwnerSupportN <= 0) return false;
  return candidateMatchesTitleSubject(c, titleNorm) || candidateMatchesOpSubject(c, opNorm);
}

function candidateHasOwnerEvidencePrimaryRescueBase(c, j, signalsOverride = null, selectedPool = []) {
  if (!isObject(c)) return false;
  if (!isProtectedCategory(candidateCategoryLower(c))) return false;
  const signals = isObject(signalsOverride) ? signalsOverride : getDirectSubjectPolicySignals(j);
  if (candidatePolicyBlocksAggressiveRescue(c, j, signals, { mode: 'owner_evidence' })) return false;
  const modulation = getUpstreamRescueModulation(signals);
  if (modulation.showcase_media_anti_bypass) return false;
  const owner = isObject(c?.owner_evidence) ? c.owner_evidence : {};
  const ownerStrength = computeOwnerEvidenceStrength(c);
  const sameOwnerSupportN = computeSameOwnerSupportN(c);
  const repeatSameCanonicalN = computeRepeatSameCanonicalN(c);
  const ownedSurfaceSupport = candidateHasOwnedSurfaceSubjectSupport(c, j, signals);
  const deterministicOwnerCore =
    owner?.owner_exact_title_op_support === true ||
    owner?.owner_same_source_exact_canonical === true ||
    owner?.same_hero_context_unlock === true;
  const ownerReady = owner?.owner_context_ready_tier2 === true || owner?.owner_context_ready_tier3 === true;
  const strictTitlePrimary = candidateHasStrictProtectedTitlePrimary(c, j, signals);
  const answerSlotOwner = candidateEligibleForAnswerSlotSubjectRescue(c, signals, signals.titleNorm);
  const broadBlocked =
    modulation.patch_bundle_anti_rescue &&
    !strictTitlePrimary &&
    !answerSlotOwner &&
    !ownedSurfaceSupport &&
    owner?.owner_exact_title_op_support !== true;
  if (broadBlocked) return false;
  return (
    deterministicOwnerCore ||
    (ownedSurfaceSupport && sameOwnerSupportN >= 1) ||
    (ownerReady && sameOwnerSupportN >= 2) ||
    (ownerStrength >= 4 && repeatSameCanonicalN >= 1)
  );
}

function candidateCategoryLower(c) {
  return toStr(c?.category || c?.entity_type || c?.dictionary_entity_type).toLowerCase();
}

function countProtectedEntityMentionsInText(textNorm, pool = []) {
  const text = normalizeFreeText(textNorm);
  if (!text) return 0;
  const seen = new Set();
  for (const cand of safeArray(pool)) {
    if (!isProtectedCategory(candidateCategoryLower(cand))) continue;
    const variants = uniqueBoundedStrings(
      [
        cand?.label_dbg,
        cand?.label,
        cand?.canonical_name,
        cand?.canonical_slug,
        cand?.entity_key_dbg,
        cand?.entity_key,
        ...safeArray(cand?.alias_norms),
      ]
        .map((v) => normalizeFreeText(v))
        .filter(Boolean),
      16
    );
    if (variants.some((v) => titleContainsNorm(text, v))) seen.add(stableKey(cand));
  }
  return seen.size;
}

/**
 * Multi-protected / bundle-ish surface is often triggered by comment-side entities while the title
 * stays a single direct subject question (e.g. niche/role). Skip broad-multi coercion in that case
 * so subjecthood can recover HARD_PRIMARY without affecting list/gallery/collab titles.
 */
function titleAnchoredDirectSubjectQuestionRelaxesMultiProtectedSurface(signals, selectedPool) {
  if (!isObject(signals) || signals.directSubjectQuestionLike !== true) return false;
  const titleNorm = normalizeFreeText(signals.titleNorm || '');
  if (!titleNorm) return false;
  const protectedSelected = safeArray(selectedPool).filter((x) =>
    isProtectedCategory(x?.category || x?.entity_type || x?.dictionary_entity_type)
  );
  if (protectedSelected.length < 2) return false;
  const nTitle = countProtectedEntityMentionsInText(titleNorm, protectedSelected);
  if (nTitle !== 1) return false;
  return true;
}

function broadMultiProtectedThreadLike(signals, selectedPool = []) {
  const protectedSelected = safeArray(selectedPool).filter((x) =>
    isProtectedCategory(x?.category || x?.entity_type || x?.dictionary_entity_type)
  );
  const broadLike =
    signals?.broadReviewLike === true ||
    signals?.policyReviewOrOpinionLike === true ||
    signals?.policyBroadGeneral === true ||
    signals?.broadBundleLike === true ||
    signals?.explicitComparisonLike === true ||
    signals?.title_explicit_comparison_like === true ||
    signals?.policyNewsLike === true;
  if (titleAnchoredDirectSubjectQuestionRelaxesMultiProtectedSurface(signals, selectedPool)) return false;
  return broadLike && protectedSelected.length >= 2;
}

function broadGeneralComparisonThreadLike(signals) {
  return !!(
    signals?.broadReviewLike === true ||
    signals?.policyReviewOrOpinionLike === true ||
    signals?.policyBroadGeneral === true ||
    signals?.broadBundleLike === true ||
    signals?.explicitComparisonLike === true ||
    signals?.title_explicit_comparison_like === true ||
    signals?.policyNewsLike === true
  );
}

function candidateHasNonExclusiveBroadPrimaryBlock(c, j, selectedPool = [], signalsOverride = null) {
  if (!isObject(c)) return false;
  if (!isProtectedCategory(candidateCategoryLower(c))) return false;
  const signals = isObject(signalsOverride) ? signalsOverride : getDirectSubjectPolicySignals(j);
  if (!broadGeneralComparisonThreadLike(signals)) return false;
  const protectedSelected = safeArray(selectedPool).filter((x) =>
    isProtectedCategory(candidateCategoryLower(x))
  );
  if (protectedSelected.length < 2) return false;
  const titleNorm = signals.titleNorm;
  const opNorm = normalizeFreeText(getOpText(j));
  const titleMentionCount = countProtectedEntityMentionsInText(titleNorm, protectedSelected);
  const opMentionCount = countProtectedEntityMentionsInText(opNorm, protectedSelected);
  const enumeratedProtected = titleMentionCount >= 2 || opMentionCount >= 2;
  if (!enumeratedProtected) return false;
  const strictTitlePrimary = candidateHasStrictProtectedTitlePrimaryRaw(c, j, signals);
  const answerSlotOwner = candidateEligibleForAnswerSlotSubjectRescue(c, signals, titleNorm);
  const ownerEvidencePrimaryRescue = candidateHasOwnerEvidencePrimaryRescueBase(c, j, signals, protectedSelected);
  const titleOwned = candidateOwnsTitleSubject(c, titleNorm);
  const exclusiveOwner =
    strictTitlePrimary || answerSlotOwner || ownerEvidencePrimaryRescue || titleOwned;
  return !exclusiveOwner;
}

function candidateIsBroadReviewSecondaryExample(c, j, signalsOverride = null) {
  if (!isObject(c)) return false;
  const signals = isObject(signalsOverride) ? signalsOverride : getDirectSubjectPolicySignals(j);
  const reviewLike =
    signals.policyReviewOrOpinionLike === true ||
    signals.broadReviewLike === true ||
    signals.broadBundleLike === true ||
    signals.policyNewsLike === true;
  if (!reviewLike || signals.explicitComparisonLike === true) return false;
  const titleNorm = signals.titleNorm;
  const strictTitlePrimary = candidateHasStrictProtectedTitlePrimary(c, j, signals);
  const answerSlotKeep = candidateEligibleForAnswerSlotSubjectRescue(c, signals, titleNorm);
  const titleMention = candidateMatchesTitleSubject(c, titleNorm);
  return !strictTitlePrimary && !answerSlotKeep && !titleMention;
}

function computeRagCentralityStats(c) {
  const ev = safeArray(c?.evidence);
  const titleEv = countEvidenceBySourceType(ev, 'title');
  const opEv = countEvidenceBySourceType(ev, 'op');
  const commentEv = countEvidenceBySourceType(ev, 'comment');
  const totalEv = ev.length;
  const titleOpEv = titleEv + opEv;
  const owner = isObject(c?.owner_evidence) ? c.owner_evidence : {};
  const protectedCtx = isObject(c?.protected_context) ? c.protected_context : {};
  const sameEntityOwnerSupport =
    owner?.owner_exact_title_op_support === true ||
    owner?.owner_same_source_exact_canonical === true ||
    owner?.owner_title_op_support === true ||
    owner?.same_hero_context_unlock === true;
  const protectedPass =
    protectedCtx?.pass_protected_context === true ||
    protectedCtx?.protected_context === true ||
    protectedCtx?.protected_primary === true;
  const directSubjectStrength =
    titleEv * 3 +
    opEv * 2 +
    Math.min(commentEv, 3) +
    (sameEntityOwnerSupport ? 2 : 0) +
    (protectedPass ? 1 : 0);
  return {
    title_ev_n: titleEv,
    op_ev_n: opEv,
    comment_ev_n: commentEv,
    title_op_ev_n: titleOpEv,
    total_ev_n: totalEv,
    source_spread_n: (titleEv > 0 ? 1 : 0) + (opEv > 0 ? 1 : 0) + (commentEv > 0 ? 1 : 0),
    same_entity_owner_support: sameEntityOwnerSupport === true,
    protected_pass: protectedPass === true,
    direct_subject_strength: directSubjectStrength,
  };
}

function rankRagCandidatesByCentrality(ragCands) {
  return safeArray(ragCands)
    .map((c) => ({ cand: c, stats: computeRagCentralityStats(c) }))
    .sort((a, b) => {
      const ds = (b.stats.direct_subject_strength || 0) - (a.stats.direct_subject_strength || 0);
      if (ds !== 0) return ds;
      const de = (b.stats.total_ev_n || 0) - (a.stats.total_ev_n || 0);
      if (de !== 0) return de;
      const dd = (b.det_score ?? b.cand?.det_score ?? 0) - (a.det_score ?? a.cand?.det_score ?? 0);
      if (dd !== 0) return dd;
      const ak = stableKey(a.cand);
      const bk = stableKey(b.cand);
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    });
}

function ragCentralitySubjecthoodSummaryForCandidate(c, j, selectedPool = [], signalsOverride = null) {
  const signals = isObject(signalsOverride) ? signalsOverride : getDirectSubjectPolicySignals(j);
  const protectedSelected = safeArray(selectedPool).filter((x) =>
    isProtectedCategory(x?.category || x?.entity_type || x?.dictionary_entity_type)
  );
  const ranked = rankRagCandidatesByCentrality(
    protectedSelected.length ? protectedSelected : safeArray(selectedPool)
  );
  const topEntry = ranked[0] || null;
  const top = topEntry?.cand || null;
  const topKey = top ? stableKey(top) : null;
  const curKey = stableKey(c);
  let strongerCompetingKey = null;
  if (topKey && topKey !== curKey) strongerCompetingKey = topKey;
  const titleNorm = signals.titleNorm;
  const opNorm = normalizeFreeText(getOpText(j));
  const titleMention = candidateMatchesTitleSubject(c, titleNorm);
  const strictTitlePrimary = candidateHasStrictProtectedTitlePrimary(c, j, signals);
  const answerSlotKeep = candidateEligibleForAnswerSlotSubjectRescue(c, signals, titleNorm);
  const ownedSurfaceSupport = candidateHasOwnedSurfaceSubjectSupport(c, j, signals);
  const ownerEvidencePrimaryRescue = candidateHasOwnerEvidencePrimaryRescueBase(c, j, signals, selectedPool);
  const repeatSameCanonicalN = computeRepeatSameCanonicalN(c);
  const titleAnchoredPrimary =
    strictTitlePrimary ||
    answerSlotKeep ||
    ownedSurfaceSupport ||
    ownerEvidencePrimaryRescue ||
    repeatSameCanonicalN >= 2 ||
    (titleMention &&
      (signals.directSubjectQuestionLike === true ||
        signals.directSubjectContentLike === true ||
        /\b(win[- ]rate|pick[- ]rate|stats?|meta|guide|tips?|help|question|bug|issue|concept|mythic|weapon|skin|buff|nerf|rework|news|update|announce|announcement|release|released|coming|idea|viable|playstyle|niche|counter|counters?)\b/.test(
          titleNorm
        )));
  const broadGeneralComparisonLike = broadGeneralComparisonThreadLike(signals);
  const singleProtectedSelected = protectedSelected.length <= 1;
  const directShapeLike =
    signals.directSubjectQuestionLike === true ||
    signals.directSubjectContentLike === true ||
    titleQuestionLike(titleNorm) ||
    titleSubjectCategoryLike(titleNorm) ||
    titleDirectShapeLike(titleNorm, opNorm);
  const strongDominantWinner =
    topKey === curKey &&
    (titleAnchoredPrimary ||
      (!broadGeneralComparisonLike && directShapeLike) ||
      (singleProtectedSelected &&
        directShapeLike &&
        !signals.policyBroadGeneral &&
        !signals.broadReviewLike &&
        !signals.policyReviewOrOpinionLike &&
        !signals.explicitComparisonLike &&
        !signals.title_explicit_comparison_like));
  if (
    strongerCompetingKey &&
    candidateCategoryLower(c) === 'map' &&
    mapEnvironmentFeedbackThreadLike('map', titleMention, titleNorm, opNorm) &&
    toStr(strongerCompetingKey).startsWith('hero||')
  ) {
    strongerCompetingKey = null;
  }
  return {
    titleAnchoredPrimary,
    strongDominantWinner,
    strongerCompetingKey,
  };
}

function candidateProtectedDirectSubjectKeepBaseState(c, j, signalsOverride = null, selectedPool = []) {
  if (!isObject(c)) return { eligible: false, keepBase: false };
  const cat = toStr(c?.category || c?.entity_type || c?.dictionary_entity_type).toLowerCase();
  if (!isProtectedCategory(cat)) return { eligible: false, keepBase: false };
  const detMatchKind = toStr(c?.det_match_kind || c?.match_kind || '').toUpperCase();
  const exactCanonical = detMatchKind === 'EXACT_CANONICAL';
  const ev = safeArray(c?.evidence);
  const hasTitleOp = c?.evidence_summary?.has_title_op === true || hasTitleOrOpEvidence(ev);
  const commentOnly = c?.det_comment_only === true || (hasCommentEvidence(ev) && !hasTitleOp);
  const topicalityStrong = c?.det_topicality_strong === true;
  const eligible = exactCanonical && hasTitleOp && !commentOnly && topicalityStrong;
  if (!eligible) {
    return {
      eligible: false,
      exactCanonical,
      hasTitleOp,
      commentOnly,
      topicalityStrong,
      keepBase: false,
    };
  }
  const hardTruthBlocked =
    c?.det_alias_directive_block_rag === true ||
    c?.det_off_domain_collision === true ||
    c?.det_collision === true ||
    c?.det_common_word_alias === true ||
    Number(c?.det_risk_rank || 0) === 3 ||
    c?.pack_meta?.pack_risky_alias_escaped === true ||
    (c?.pack_meta?.pack_gate && packGateIsHardBlock(c.pack_meta.pack_gate)) ||
    (c?.det_owner_scope_required === true &&
      ['UNKNOWN', 'CONFLICT'].includes(toStr(c?.det_owner_status).toUpperCase())) ||
    (isObject(c?.intent_evidence) &&
      c.intent_evidence.applicable === true &&
      (c.intent_evidence.pass_intent_anchor === false || c.intent_evidence.pass_negative_anchor_gate === false));
  const signals = isObject(signalsOverride) ? signalsOverride : getDirectSubjectPolicySignals(j);
  const titleNorm = signals.titleNorm;
  const opNorm = normalizeFreeText(getOpText(j));
  const strictTitlePrimary = candidateHasStrictProtectedTitlePrimary(c, j, signals);
  const titleMention = candidateMatchesTitleSubject(c, titleNorm);
  const ownedQuestionLike =
    titleMention &&
    (signals.directSubjectQuestionLike === true ||
      (!broadGeneralComparisonThreadLike(signals) && signals.policyQuestionAnswerable === true) ||
      titleQuestionLike(titleNorm));
  const statMetaHelpKeep = titleMention && titleSubjectCategoryLike(titleNorm);
  const directShapeLike =
    titleDirectShapeLike(titleNorm, opNorm) ||
    signals.directSubjectQuestionLike === true ||
    signals.directSubjectContentLike === true;
  const answerSlotKeep = candidateEligibleForAnswerSlotSubjectRescue(c, signals, titleNorm);
  const ownedSurfaceSupport = candidateHasOwnedSurfaceSubjectSupport(c, j, signals);
  const ownerEvidencePrimaryRescue = candidateHasOwnerEvidencePrimaryRescueBase(c, j, signals, selectedPool);
  const repeatSameCanonicalN = computeRepeatSameCanonicalN(c);
  const directSubjectStrength = candidateDirectSubjectStrengthDbg(c, j, selectedPool);
  const protectedSelected = safeArray(selectedPool).filter((x) =>
    isProtectedCategory(x?.category || x?.entity_type || x?.dictionary_entity_type)
  );
  const singleProtectedSelected = protectedSelected.length <= 1;
  const broadMultiProtected = broadMultiProtectedThreadLike(signals, selectedPool);
  const broadGeneralComparisonLike = broadGeneralComparisonThreadLike(signals);
  const mapEnvironmentFeedbackLike = mapEnvironmentFeedbackThreadLike(cat, titleMention, titleNorm, opNorm);
  const keepBase =
    !hardTruthBlocked &&
    (strictTitlePrimary ||
      ownedQuestionLike ||
      statMetaHelpKeep ||
      answerSlotKeep ||
      ownedSurfaceSupport ||
      repeatSameCanonicalN >= 2 ||
      directSubjectStrength >= 8 ||
      mapEnvironmentFeedbackLike ||
      (singleProtectedSelected &&
        directShapeLike &&
        directSubjectStrength >= 4 &&
        !broadGeneralComparisonLike) ||
      (titleMention && directShapeLike)) &&
    (!broadMultiProtected || strictTitlePrimary || answerSlotKeep || mapEnvironmentFeedbackLike);
  return {
    eligible: true,
    hardTruthBlocked,
    strictTitlePrimary,
    titleMention,
    ownedQuestionLike,
    statMetaHelpKeep,
    answerSlotKeep,
    ownedSurfaceSupport,
    repeatSameCanonicalN,
    directSubjectStrength,
    singleProtectedSelected,
    broadMultiProtected,
    broadGeneralComparisonLike,
    directShapeLike,
    keepBase,
  };
}

function candidateDirectSubjectStrengthDbg(c, j, selectedPool = []) {
  const signals = getDirectSubjectPolicySignals(j);
  const ev = safeArray(c?.evidence);
  const exactCanonical = toStr(c?.det_match_kind || c?.match_kind).toUpperCase() === 'EXACT_CANONICAL';
  const titleMention = candidateMatchesTitleSubject(c, signals.titleNorm);
  const opMention = candidateMatchesOpSubject(c, normalizeFreeText(getOpText(j)));
  const strictTitlePrimary = candidateHasStrictProtectedTitlePrimary(c, j, signals);
  const answerSlotOwner = candidateEligibleForAnswerSlotSubjectRescue(c, signals, signals.titleNorm);
  const sameOwnerSupportN = computeSameOwnerSupportN(c);
  const repeatSameCanonicalN = computeRepeatSameCanonicalN(c);
  const ownedSurfaceSupport = candidateHasOwnedSurfaceSubjectSupport(c, j, signals);
  const ownerEvidenceStrength = computeOwnerEvidenceStrength(c);
  const ownerEvidencePrimaryRescue = candidateHasOwnerEvidencePrimaryRescueBase(c, j, signals, selectedPool);
  const ownerEvidence = isObject(c?.owner_evidence) ? c.owner_evidence : {};
  const summary = ragCentralitySubjecthoodSummaryForCandidate(c, j, selectedPool, signals);
  let n = 0;
  if (exactCanonical) n += 2;
  if (titleMention) n += 2;
  if (opMention) n += 1;
  if (strictTitlePrimary) n += 3;
  if (answerSlotOwner) n += 2;
  if (sameOwnerSupportN > 0) n += 2;
  if (ownedSurfaceSupport) n += 2;
  if (ownerEvidence?.owner_exact_title_op_support === true) n += 3;
  if (ownerEvidence?.owner_same_source_exact_canonical === true) n += 2;
  if (ownerEvidence?.same_hero_context_unlock === true) n += 2;
  if (ownerEvidencePrimaryRescue) n += 2;
  if (ownerEvidenceStrength >= 4) n += 1;
  if (repeatSameCanonicalN >= 2) n += 2;
  if (!summary.strongerCompetingKey) n += 1;
  if (countEvidenceBySourceType(ev, 'title') > 0) n += 2;
  if (countEvidenceBySourceType(ev, 'op') > 0) n += 1;
  return n;
}

function candidateHasPresumptiveDirectPrimary(c, j, signalsOverride = null, selectedPool = [], baseOverride = null) {
  if (!isObject(c)) return false;
  const cat = toStr(c?.category || c?.entity_type || c?.dictionary_entity_type).toLowerCase();
  if (!isProtectedCategory(cat)) return false;
  const signals = isObject(signalsOverride) ? signalsOverride : getDirectSubjectPolicySignals(j);
  const base = isObject(baseOverride) ? baseOverride : candidateProtectedDirectSubjectKeepBaseState(c, j, signals, selectedPool);
  if (!base.eligible || base.hardTruthBlocked) return false;
  const summary = ragCentralitySubjecthoodSummaryForCandidate(c, j, selectedPool, signals);
  const protectedSelected = safeArray(selectedPool).filter((x) =>
    isProtectedCategory(x?.category || x?.entity_type || x?.dictionary_entity_type)
  );
  const singleProtectedSelected = protectedSelected.length <= 1;
  const titleNorm = signals.titleNorm;
  const opNorm = normalizeFreeText(getOpText(j));
  const broadGeneralComparisonLike = broadGeneralComparisonThreadLike(signals);
  const policyDrivenDirectShapeLike =
    !broadGeneralComparisonLike &&
    (signals.policyQuestionAnswerable === true || signals.policySubjectFavoring === true);
  const directShapeLike =
    signals.directSubjectQuestionLike === true ||
    signals.directSubjectContentLike === true ||
    titleSubjectCategoryLike(titleNorm) ||
    titleQuestionLike(titleNorm) ||
    titleDirectShapeLike(titleNorm, opNorm) ||
    policyDrivenDirectShapeLike ||
    (signals.policyNewsLike === true &&
      (base.titleMention || base.strictTitlePrimary || base.answerSlotKeep));
  const heroCategory = cat === 'hero';
  const mapCategory = cat === 'map';
  const mapEnvironmentFeedbackLike = mapEnvironmentFeedbackThreadLike(cat, base.titleMention, titleNorm, opNorm);
  const strongerKey = toStr(summary.strongerCompetingKey);
  const noStrongerCompeting =
    !strongerKey || (mapEnvironmentFeedbackLike && strongerKey.startsWith('hero||'));
  const broadMultiProtected = broadMultiProtectedThreadLike(signals, selectedPool);
  const broadMultiAllowed =
    !broadMultiProtected ||
    base.strictTitlePrimary ||
    base.answerSlotKeep ||
    mapEnvironmentFeedbackLike;
  if (!broadMultiAllowed) return false;
  const exactHeroDirectShapeBoost =
    heroCategory &&
    singleProtectedSelected &&
    !broadMultiProtected &&
    !summary.strongerCompetingKey &&
    (signals.directSubjectQuestionLike === true ||
      signals.directSubjectContentLike === true ||
      titleSubjectCategoryLike(titleNorm) ||
      titleQuestionLike(titleNorm) ||
      titleDirectShapeLike(titleNorm, opNorm) ||
      (!broadGeneralComparisonLike &&
        (signals.policyQuestionAnswerable === true || signals.policySubjectFavoring === true)));
  const singleGeneralTopicWithoutPrimary =
    singleProtectedSelected &&
    broadGeneralComparisonLike &&
    !base.strictTitlePrimary &&
    !base.answerSlotKeep &&
    !base.titleMention &&
    !exactHeroDirectShapeBoost &&
    !signals.directSubjectQuestionLike &&
    !signals.directSubjectContentLike &&
    !titleSubjectCategoryLike(titleNorm) &&
    !titleQuestionLike(titleNorm) &&
    !titleDirectShapeLike(titleNorm, opNorm) &&
    !mapCategory;
  if (singleGeneralTopicWithoutPrimary) return false;
  const creativeConceptLike = /\b(concept|fan concept|mythic weapon|mythic|fanart|art|joke|meme|what if)\b/.test(
    `${titleNorm} ${opNorm}`.trim()
  );
  return (
    noStrongerCompeting &&
    (base.strictTitlePrimary ||
      base.answerSlotKeep ||
      base.ownedSurfaceSupport ||
      base.repeatSameCanonicalN >= 2 ||
      (summary.strongDominantWinner &&
        base.directSubjectStrength >= 6 &&
        !broadGeneralComparisonLike &&
        !creativeConceptLike) ||
      (heroCategory &&
        singleProtectedSelected &&
        directShapeLike &&
        base.directSubjectStrength >= 4) ||
      (mapEnvironmentFeedbackLike && !creativeConceptLike) ||
      (base.titleMention && directShapeLike && !creativeConceptLike))
  );
}

function candidateHasExplicitSecondaryExampleEvidence(
  c,
  j,
  signalsOverride = null,
  selectedPool = [],
  keepBaseOverride = null
) {
  if (!isObject(c)) return false;
  const signals = isObject(signalsOverride) ? signalsOverride : getDirectSubjectPolicySignals(j);
  const keepBase = isObject(keepBaseOverride)
    ? keepBaseOverride
    : candidateProtectedDirectSubjectKeepBaseState(c, j, signals, selectedPool);
  const presumptivePrimary = candidateHasPresumptiveDirectPrimary(c, j, signals, selectedPool, keepBase);
  if (presumptivePrimary) return false;
  const profile = candidateSecondaryProfileDbg(c, j, signals, selectedPool, keepBase);
  const hasBroadShape =
    signals.policyReviewOrOpinionLike === true ||
    signals.broadReviewLike === true ||
    signals.policyBroadGeneral === true ||
    signals.broadBundleLike === true ||
    signals.explicitComparisonLike === true ||
    signals.title_explicit_comparison_like === true ||
    signals.policyNewsLike === true;
  if (!hasBroadShape) return false;
  const explicitSecondary =
    profile.includes('secondary_profile:comment_only_support') ||
    profile.includes('secondary_profile:weak_non_title_support') ||
    profile.includes('secondary_profile:broad_multi_protected_thread') ||
    (profile.includes('secondary_profile:not_direct_subject_keep') &&
      profile.includes('secondary_profile:not_title_mentioned')) ||
    (profile.includes('secondary_profile:not_direct_subject_keep') &&
      profile.includes('secondary_profile:no_same_owner_support') &&
      profile.includes('secondary_profile:low_repeat_same_canonical'));
  return explicitSecondary;
}

function candidateSecondaryProfileDbg(c, j, signalsOverride = null, selectedPool = [], keepBaseOverride = null) {
  if (!isObject(c)) return [];
  const signals = isObject(signalsOverride) ? signalsOverride : getDirectSubjectPolicySignals(j);
  const titleNorm = signals.titleNorm;
  const ev = safeArray(c?.evidence);
  const titleMention = candidateMatchesTitleSubject(c, titleNorm);
  const strictTitlePrimary = candidateHasStrictProtectedTitlePrimary(c, j, signals);
  const keepBase = isObject(keepBaseOverride)
    ? keepBaseOverride
    : candidateProtectedDirectSubjectKeepBaseState(c, j, signals, selectedPool);
  const presumptivePrimary = candidateHasPresumptiveDirectPrimary(c, j, signals, selectedPool, keepBase);
  const directKeepBase = keepBase.keepBase === true;
  const hasCommentOnly = hasCommentEvidence(ev) && !hasTitleOrOpEvidence(ev);
  const weakNonTitleSupport = !titleMention && hasTitleOrOpEvidence(ev);
  const sameOwnerSupportN = computeSameOwnerSupportN(c);
  const repeatSameCanonicalN = computeRepeatSameCanonicalN(c);
  const broadMultiProtected = broadMultiProtectedThreadLike(signals, selectedPool);
  const out = [];
  if (signals.policyReviewOrOpinionLike === true || signals.broadReviewLike === true)
    out.push('secondary_profile:review_like_thread');
  if (signals.policyBroadGeneral === true) out.push('secondary_profile:broad_general_thread');
  if (signals.broadBundleLike === true) out.push('secondary_profile:bundle_thread');
  if (signals.explicitComparisonLike === true || signals.title_explicit_comparison_like === true)
    out.push('secondary_profile:comparison_thread');
  if (broadMultiProtected) out.push('secondary_profile:broad_multi_protected_thread');
  if (!presumptivePrimary && !strictTitlePrimary && !directKeepBase)
    out.push('secondary_profile:not_direct_subject_keep');
  if (!titleMention) out.push('secondary_profile:not_title_mentioned');
  if (hasCommentOnly) out.push('secondary_profile:comment_only_support');
  if (!presumptivePrimary && weakNonTitleSupport) out.push('secondary_profile:weak_non_title_support');
  if (!presumptivePrimary && sameOwnerSupportN === 0) out.push('secondary_profile:no_same_owner_support');
  if (!presumptivePrimary && repeatSameCanonicalN <= 1) out.push('secondary_profile:low_repeat_same_canonical');
  return uniqueBoundedStrings(out, 20);
}

function candidateHasProtectedDirectSubjectKeep(c, j, signalsOverride = null, selectedPool = []) {
  const base = candidateProtectedDirectSubjectKeepBaseState(c, j, signalsOverride, selectedPool);
  if (!base.keepBase) return false;
  const signals = isObject(signalsOverride) ? signalsOverride : getDirectSubjectPolicySignals(j);
  const presumptivePrimary = candidateHasPresumptiveDirectPrimary(c, j, signals, selectedPool, base);
  if (presumptivePrimary) return true;
  const hardReviewOpinionBlock =
    candidateIsBroadReviewSecondaryExample(c, j, signals) &&
    candidateHasExplicitSecondaryExampleEvidence(c, j, signals, selectedPool, base);
  return base.keepBase && !hardReviewOpinionBlock;
}

function candidateHasProtectedDirectSubjectStorageLock(c, j, signalsOverride = null, selectedPool = []) {
  if (!isObject(c)) return false;
  const cat = toStr(c?.category || c?.entity_type || c?.dictionary_entity_type).toLowerCase();
  if (!isProtectedCategory(cat)) return false;
  const base = candidateProtectedDirectSubjectKeepBaseState(c, j, signalsOverride, selectedPool);
  if (!base.eligible || base.hardTruthBlocked) return false;
  const signals = isObject(signalsOverride) ? signalsOverride : getDirectSubjectPolicySignals(j);
  const titleNorm = signals.titleNorm;
  const questionLike = titleQuestionLike(titleNorm);
  const directHelpLike = /\b(help|guide|tips?|question|bug|issue|fix|counter|counters?|playstyle|viable|niche|pickup|pick up)\b/.test(
    titleNorm
  );
  const statMetaLike = /\b(win[- ]rate|pick[- ]rate|stats?|meta|main|mains|otp|one[- ]trick|performance|buff|nerf|rework)\b/.test(
    titleNorm
  );
  const newsConceptLike = /\b(news|update|announce|announcement|release|released|coming|concept|mythic|weapon|skin|idea|highlight|intro)\b/.test(
    titleNorm
  );
  const presumptivePrimary = candidateHasPresumptiveDirectPrimary(c, j, signals, selectedPool, base);
  const summary = ragCentralitySubjecthoodSummaryForCandidate(c, j, selectedPool, signals);
  const broadMultiProtected = broadMultiProtectedThreadLike(signals, selectedPool);
  const broadMultiAllowed =
    !broadMultiProtected || base.strictTitlePrimary || base.answerSlotKeep;
  if (!broadMultiAllowed) return false;
  const heroCategory = cat === 'hero';
  const mapCategory = cat === 'map';
  return (
    base.strictTitlePrimary ||
    base.answerSlotKeep ||
    base.ownedSurfaceSupport ||
    base.repeatSameCanonicalN >= 2 ||
    (heroCategory && base.directSubjectStrength >= 7) ||
    (heroCategory && presumptivePrimary) ||
    (heroCategory &&
      base.titleMention &&
      (questionLike ||
        directHelpLike ||
        statMetaLike ||
        newsConceptLike ||
        signals.directSubjectQuestionLike === true ||
        signals.directSubjectContentLike === true)) ||
    (!mapCategory && presumptivePrimary)
  );
}

function candidateLooksLikeProtectedSelectedTitleSubject(c, j, signalsOverride = null, selectedPool = []) {
  if (!isObject(c)) return false;
  const cat = toStr(c?.category || c?.entity_type || c?.dictionary_entity_type).toLowerCase();
  if (!isProtectedCategory(cat)) return false;
  const detMatchKind = toStr(c?.det_match_kind || c?.match_kind || '').toUpperCase();
  const exactCanonical = detMatchKind === 'EXACT_CANONICAL';
  if (!exactCanonical) return false;
  const ev = safeArray(c?.evidence);
  const hasTitleOp = c?.evidence_summary?.has_title_op === true || hasTitleOrOpEvidence(ev);
  const commentOnly = c?.det_comment_only === true || (hasCommentEvidence(ev) && !hasTitleOp);
  const topicalityStrong = c?.det_topicality_strong === true;
  if (!hasTitleOp || commentOnly || !topicalityStrong) return false;
  const signals = isObject(signalsOverride) ? signalsOverride : getDirectSubjectPolicySignals(j);
  const titleNorm = signals.titleNorm;
  const titleMention = candidateMatchesTitleSubject(c, titleNorm);
  const strictTitlePrimary = candidateHasStrictProtectedTitlePrimary(c, j, signals);
  const answerSlotKeep = candidateEligibleForAnswerSlotSubjectRescue(c, signals, titleNorm);
  const presumptivePrimary = candidateHasPresumptiveDirectPrimary(c, j, signals, selectedPool);
  const broadMultiProtected = broadMultiProtectedThreadLike(signals, selectedPool);
  if (broadMultiProtected) {
    return strictTitlePrimary || answerSlotKeep;
  }
  return strictTitlePrimary || answerSlotKeep || (titleMention && presumptivePrimary);
}

function candidateMustDemoteBroadReviewAtStorage(c, j, signalsOverride = null, selectedPool = []) {
  if (!isObject(c)) return false;
  const cat = toStr(c?.category || c?.entity_type || c?.dictionary_entity_type).toLowerCase();
  if (!isProtectedCategory(cat)) return false;
  const signals = isObject(signalsOverride) ? signalsOverride : getDirectSubjectPolicySignals(j);
  const broadLike =
    signals.policyReviewOrOpinionLike === true ||
    signals.broadReviewLike === true ||
    signals.policyBroadGeneral === true ||
    signals.broadBundleLike === true ||
    signals.explicitComparisonLike === true ||
    signals.title_explicit_comparison_like === true ||
    signals.policyNewsLike === true;
  if (!broadLike) return false;
  const base = candidateProtectedDirectSubjectKeepBaseState(c, j, signals, selectedPool);
  const presumptivePrimary = candidateHasPresumptiveDirectPrimary(c, j, signals, selectedPool, base);
  const broadMultiProtected = broadMultiProtectedThreadLike(signals, selectedPool);
  const broadMultiAllowed = base.strictTitlePrimary || base.answerSlotKeep;
  if (presumptivePrimary && !broadMultiProtected) return false;
  if (broadMultiProtected && !broadMultiAllowed) return true;
  if (signals.explicitComparisonLike === true && !broadMultiProtected) return false;
  if (
    candidateHasProtectedDirectSubjectStorageLock(c, j, signals, selectedPool) &&
    broadMultiAllowed
  )
    return false;
  return candidateHasExplicitSecondaryExampleEvidence(c, j, signals, selectedPool, base);
}

function candidateHasDirectAnswerableRescue(c, j, signalsOverride = null, selectedPool = []) {
  if (!isObject(c)) return false;
  if (!isProtectedCategory(candidateCategoryLower(c))) return false;
  const signals = isObject(signalsOverride) ? signalsOverride : getDirectSubjectPolicySignals(j);
  if (signals.direct_answerable_rescue_allowed !== true) return false;
  if (candidatePolicyBlocksAggressiveRescue(c, j, signals, { mode: 'answer_slot' })) return false;
  const modulation = getUpstreamRescueModulation(signals);
  if (modulation.showcase_media_anti_bypass) return false;
  if (modulation.weak_rescue_blocked && signals.answer_slot_strong !== true) return false;
  const ev = safeArray(c?.evidence);
  const hasTitleOp = c?.evidence_summary?.has_title_op === true || hasTitleOrOpEvidence(ev);
  const commentOnly = c?.det_comment_only === true || (hasCommentEvidence(ev) && !hasTitleOp);
  const exactCanonical = toStr(c?.det_match_kind || c?.match_kind).toUpperCase() === 'EXACT_CANONICAL';
  const titleNorm = signals.titleNorm;
  const ownsTitle = candidateOwnsTitleSubject(c, titleNorm);
  const strictTitlePrimary = candidateHasStrictProtectedTitlePrimary(c, j, signals);
  const ownerEvidence = isObject(c?.owner_evidence) ? c.owner_evidence : {};
  const ownerExactSupport =
    ownerEvidence?.owner_exact_title_op_support === true ||
    ownerEvidence?.owner_same_source_exact_canonical === true;
  const ownerTitleSupport = ownerEvidence?.owner_title_op_support === true;
  const sameOwnerSupportN = computeSameOwnerSupportN(c);
  const repeatSameCanonicalN = computeRepeatSameCanonicalN(c);
  const directStrength =
    Number.isFinite(c?.subject_direct_subject_strength_dbg) ?
      c.subject_direct_subject_strength_dbg :
      candidateDirectSubjectStrengthDbg(c, j, selectedPool);
  const deterministicOwnership =
    strictTitlePrimary ||
    ownsTitle ||
    ownerExactSupport ||
    (ownerHeroTitlePrimary(ownerEvidence) &&
      !competingHeroTitlePrimary(ownerEvidence) &&
      ownerTitleSupport) ||
    (exactCanonical && hasTitleOp) ||
    sameOwnerSupportN > 0 ||
    repeatSameCanonicalN >= 2;
  if (!deterministicOwnership) return false;
  if (
    commentOnly &&
    !(ownsTitle || ownerExactSupport || sameOwnerSupportN > 0 || repeatSameCanonicalN >= 2)
  )
    return false;
  if (
    signals.answer_slot_contradiction === true &&
    !(strictTitlePrimary || ownerExactSupport || repeatSameCanonicalN >= 2)
  )
    return false;
  if (
    signals.upstreamPatchBundlePrior === true &&
    !(strictTitlePrimary || ownerExactSupport || ownsTitle)
  )
    return false;
  const thresholdBase =
    signals.answer_slot_tier === 'HIGH' ? 3 : signals.answer_slot_strong === true ? 4 : 5;
  const threshold = clamp(thresholdBase + (modulation?.net_delta ?? 0), 3, 6);
  return directStrength >= threshold;
}

function detectRagCentralityPostShape(j, selected) {
  const rag = safeArray(selected).filter(
    (c) => toStr(c?.storage_intent).toUpperCase() === 'RAG_OK'
  );
  const protectedSelected = safeArray(selected).filter((c) => isProtectedCategory(c?.category));
  const protectedRag = rag.filter((c) => isProtectedCategory(c?.category));
  const ranked = rankRagCandidatesByCentrality(
    protectedRag.length > 0 ? protectedRag : rag
  );
  const top = ranked[0] || null;
  const second = ranked[1] || null;
  const signals = getDirectSubjectPolicySignals(j);
  const {
    titleNorm,
    broadBundleLike,
    broadReviewLike,
    advicePromptLike,
    directSubjectQuestionLike,
    directSubjectContentLike,
    explicitComparisonLike,
    policyBroadGeneral,
    policyQuestionAnswerable,
    policyNewsLike,
    policyReviewOrOpinionLike,
    policyEntitySubjectRescueAllowed,
    policySubjectFavoring,
    answer_slot_subject_rescue_allowed: answerSlotSubjectRescueAllowed,
  } = signals;
  const titleExplicitComparisonLike = /(\bvs\b|versus|matchup|match-up|interaction|interactions|synergy|duo|pairing|compare|comparison|against)/.test(
    titleNorm
  );
  const directSubjectTitleShape = /\b(win[- ]rate|pick[- ]rate|stats?|meta|performance|help|guide|tips?|question|bug|issue|fix|counter|counters?|playstyle|viable|niche|concept|mythic|weapon|skin|buff|nerf|rework|news|update|announce|announcement|release|released|coming|idea)\b/.test(
    titleNorm
  );
  const generalTopicLike =
    broadReviewLike ||
    advicePromptLike ||
    policyBroadGeneral ||
    policyReviewOrOpinionLike ||
    policyNewsLike ||
    /(favorite|favourite|which hero|who is|counterwatch|one[- ]trick|meta )/.test(
      `${titleNorm} ${normalizeFreeText(getOpText(j))}`.trim()
    );
  const broadPromptOverrideLike =
    (broadReviewLike || advicePromptLike || policyReviewOrOpinionLike) &&
    !directSubjectQuestionLike &&
    !titleExplicitComparisonLike;
  const topStats = top?.stats || null;
  const secondStats = second?.stats || null;
  const strongDominantWinner =
    !!topStats &&
    (!secondStats ||
      (topStats.direct_subject_strength - secondStats.direct_subject_strength >= 3 &&
        topStats.title_op_ev_n - secondStats.title_op_ev_n >= 1) ||
      (topStats.title_ev_n >= 2 &&
        topStats.title_ev_n >= (secondStats?.title_ev_n || 0) + 1 &&
        topStats.total_ev_n >= (secondStats?.total_ev_n || 0) + 1));
  const protectedTitlePrimaryWinners = rag.filter((c) =>
    candidateHasStrictProtectedTitlePrimary(c, j, signals)
  );
  const protectedTitlePrimaryWinnerExists = protectedTitlePrimaryWinners.length > 0;
  const protectedDirectSubjectWinners = rag.filter((c) =>
    candidateHasProtectedDirectSubjectKeep(c, j, signals, protectedSelected)
  );
  const protectedDirectSubjectWinnerExists = protectedDirectSubjectWinners.length > 0;
  const protectedSelectedTitleSubjects = protectedSelected.filter((c) =>
    candidateLooksLikeProtectedSelectedTitleSubject(c, j, signals, protectedSelected)
  );
  const protectedSelectedTitleSubjectExists = protectedSelectedTitleSubjects.length > 0;
  const protectedSelectedTitleSubjectLocks = protectedSelected.filter((c) =>
    candidateHasProtectedDirectSubjectStorageLock(c, j, signals, protectedSelected)
  );
  const protectedSelectedDirectSubjects = protectedSelected.filter((c) =>
    candidateHasProtectedDirectSubjectKeep(c, j, signals, protectedSelected)
  );
  const titleAnchoredPrimaryBase =
    protectedTitlePrimaryWinnerExists ||
    protectedSelectedTitleSubjectExists ||
    (!!topStats &&
      topStats.title_ev_n >= 1 &&
      (!secondStats ||
        ((secondStats.title_ev_n || 0) === 0 &&
          topStats.direct_subject_strength - secondStats.direct_subject_strength >= 2) ||
        (topStats.title_op_ev_n >= (secondStats?.title_op_ev_n || 0) + 1 &&
          topStats.total_ev_n >= (secondStats?.total_ev_n || 0) + 1)));
  const titleAnchoredPrimary =
    titleAnchoredPrimaryBase &&
    (protectedTitlePrimaryWinnerExists ||
      protectedSelectedTitleSubjectExists ||
      directSubjectQuestionLike === true ||
      directSubjectContentLike === true ||
      directSubjectTitleShape === true ||
      (policySubjectFavoring === true && !broadBundleLike));
  const broadThreadShape =
    broadBundleLike ||
    broadReviewLike ||
    advicePromptLike ||
    policyBroadGeneral ||
    policyReviewOrOpinionLike ||
    policyNewsLike;
  const secondaryExampleOnly =
    broadThreadShape &&
    !protectedTitlePrimaryWinnerExists &&
    !protectedDirectSubjectWinnerExists &&
    !protectedSelectedTitleSubjectExists &&
    !titleAnchoredPrimary &&
    !(titleExplicitComparisonLike && rag.length === 2) &&
    !answerSlotSubjectRescueAllowed;
  let shape = 'none';
  if (rag.length === 2 && titleExplicitComparisonLike && !broadBundleLike) {
    shape = 'dual_interaction_or_comparison';
  } else if (
    (protectedSelected.length >= 2 || rag.length >= 3) &&
    broadBundleLike &&
    !strongDominantWinner &&
    !protectedDirectSubjectWinnerExists &&
    !protectedSelectedTitleSubjectExists
  ) {
    shape = 'broad_bundle_or_gallery';
  } else if (
    secondaryExampleOnly &&
    (broadPromptOverrideLike ||
      generalTopicLike ||
      (policyBroadGeneral && !titleAnchoredPrimary))
  ) {
    shape = 'general_topic_with_entity_examples';
  }
  return {
    shape,
    broad_bundle_like: broadBundleLike,
    broad_review_like: broadReviewLike,
    advice_prompt_like: advicePromptLike,
    direct_subject_question_like: directSubjectQuestionLike,
    direct_subject_content_like: directSubjectContentLike,
    direct_subject_title_shape: directSubjectTitleShape,
    general_topic_like: generalTopicLike,
    explicit_comparison_like: explicitComparisonLike,
    title_explicit_comparison_like: titleExplicitComparisonLike,
    broad_prompt_override_like: broadPromptOverrideLike,
    title_anchored_primary: titleAnchoredPrimary,
    answer_slot_subject_rescue_allowed: answerSlotSubjectRescueAllowed,
    policy_broad_general: policyBroadGeneral,
    policy_question_answerable: policyQuestionAnswerable,
    policy_news_like: policyNewsLike,
    policy_review_or_opinion_like: policyReviewOrOpinionLike,
    policy_entity_subject_rescue_allowed: policyEntitySubjectRescueAllowed,
    rag_candidate_n: rag.length,
    protected_selected_n: protectedSelected.length,
    strong_dominant_winner: strongDominantWinner,
    protected_title_primary_winner_n: protectedTitlePrimaryWinners.length,
    protected_direct_subject_winner_n: protectedDirectSubjectWinners.length,
    protected_selected_title_subject_n: protectedSelectedTitleSubjects.length,
    protected_selected_title_subject_lock_n: protectedSelectedTitleSubjectLocks.length,
    protected_selected_direct_subject_n: protectedSelectedDirectSubjects.length,
    ranked,
  };
}

function buildRagCentralityDebugSummary(j, info, demotions = []) {
  const signals = isObject(info) ? info : detectRagCentralityPostShape(j, []);
  const titleNorm = normalizeFreeText(getTitleText(j));
  const opNorm = normalizeFreeText(getOpText(j));
  const titleOpNorm = `${titleNorm} ${opNorm}`.trim();
  const broadShapeTriggerSources = uniqueBoundedStrings(
    [
      signals.broad_bundle_like === true ? 'shape:broad_bundle_like' : '',
      signals.broad_review_like === true ? 'shape:broad_review_like' : '',
      signals.advice_prompt_like === true ? 'shape:advice_prompt_like' : '',
      signals.general_topic_like === true ? 'shape:general_topic_like' : '',
      signals.policy_broad_general === true ? 'policy:broad_general' : '',
      signals.policy_review_or_opinion_like === true ? 'policy:review_or_opinion_like' : '',
      signals.policy_news_like === true ? 'policy:news_like' : '',
      signals.explicit_comparison_like === true ? 'shape:explicit_comparison_like' : '',
      signals.broad_prompt_override_like === true ? 'shape:broad_prompt_override_like' : '',
    ],
    12
  );
  const directSubjectTriggerSources = uniqueBoundedStrings(
    [
      signals.direct_subject_question_like === true ? 'shape:direct_subject_question_like' : '',
      signals.direct_subject_content_like === true ? 'shape:direct_subject_content_like' : '',
      signals.answer_slot_subject_rescue_allowed === true ? 'shape:answer_slot_subject_rescue_allowed' : '',
      signals.policy_question_answerable === true ? 'policy:question_answerable' : '',
      signals.policy_entity_subject_rescue_allowed === true ? 'policy:entity_subject_rescue_allowed' : '',
      signals.policy_subject_favoring === true ? 'policy:subject_favoring' : '',
      /\b(how|why|what|which|can|does|is|are|should)\b/.test(titleNorm) ? 'title:question_word' : '',
      /\b(win[- ]rate|pick[- ]rate|stats?|meta|help|guide|tips?|bug|issue|fix|counter|counters?|playstyle|viable|niche|concept|mythic|weapon|skin|buff|nerf|rework|news|update|announce|announcement|release|released|coming|idea)\b/.test(
        titleOpNorm
      )
        ? 'title_or_op:stat_help_news_concept'
        : '',
    ],
    12
  );
  const titlePrimaryTriggerSources = uniqueBoundedStrings(
    [
      signals.title_anchored_primary === true ? 'shape:title_anchored_primary' : '',
      Number(signals.protected_title_primary_winner_n || 0) > 0 ? 'winner:protected_title_primary' : '',
      Number(signals.protected_direct_subject_winner_n || 0) > 0 ? 'winner:protected_direct_subject' : '',
      Number(signals.protected_selected_title_subject_n || 0) > 0 ? 'selected:protected_title_subject' : '',
      Number(signals.protected_selected_title_subject_lock_n || 0) > 0
        ? 'selected:protected_title_subject_lock'
        : '',
      Number(signals.protected_selected_direct_subject_n || 0) > 0 ? 'selected:protected_direct_subject' : '',
      signals.answer_slot_subject_rescue_allowed === true ? 'winner:answer_slot_subject_rescue_allowed' : '',
      signals.strong_dominant_winner === true ? 'winner:strong_dominant_winner' : '',
    ],
    12
  );
  return {
    post_shape: toStr(signals.shape || 'none') || 'none',
    dbg_is_broad_review_or_impressions:
      signals.broad_review_like === true || signals.policy_review_or_opinion_like === true,
    dbg_is_general_topic_with_entity_examples:
      toStr(signals.shape) === 'general_topic_with_entity_examples',
    dbg_is_broad_bundle_or_gallery: toStr(signals.shape) === 'broad_bundle_or_gallery',
    dbg_is_direct_question_shape: signals.direct_subject_question_like === true,
    dbg_is_stat_meta_shape: /\b(win[- ]rate|pick[- ]rate|stats?|meta|performance|buff|nerf|rework)\b/.test(
      titleOpNorm
    ),
    dbg_is_help_howto_shape: /\b(how do i|help|guide|tips?|question|bug|issue|fix|counter|counters?|playstyle|viable|niche)\b/.test(
      titleOpNorm
    ),
    dbg_is_news_update_shape:
      signals.policy_news_like === true ||
      /\b(news|update|announce|announcement|release|released|coming|patch notes?)\b/.test(titleOpNorm),
    dbg_has_entity_title_head: Number(signals.protected_title_primary_winner_n || 0) > 0,
    dbg_title_explicit_comparison_like: signals.title_explicit_comparison_like === true,
    dbg_has_answer_slot_subject: signals.answer_slot_subject_rescue_allowed === true,
    dbg_broad_shape_trigger_sources: broadShapeTriggerSources,
    dbg_direct_subject_trigger_sources: directSubjectTriggerSources,
    dbg_title_primary_trigger_sources: titlePrimaryTriggerSources,
    dbg_rag_candidate_n: Number(signals.rag_candidate_n || 0),
    dbg_protected_selected_n: Number(signals.protected_selected_n || 0),
    dbg_protected_selected_title_subject_n: Number(signals.protected_selected_title_subject_n || 0),
    dbg_protected_selected_title_subject_lock_n: Number(
      signals.protected_selected_title_subject_lock_n || 0
    ),
    dbg_protected_selected_direct_subject_n: Number(signals.protected_selected_direct_subject_n || 0),
    dbg_strong_dominant_winner: signals.strong_dominant_winner === true,
    dbg_demotions_n: safeArray(demotions).length,
    dbg_demoted_reason_primaries: uniqueBoundedStrings(
      safeArray(demotions).map((d) => d?.reason_primary),
      12
    ),
    hero_primary_cardinality_dbg: toStr(signals.hero_primary_cardinality_dbg || '') || null,
    hero_primary_keep_n_dbg: Number(signals.hero_primary_keep_n_dbg || 0),
    hero_primary_cap_reason_dbg: toStr(signals.hero_primary_cap_reason_dbg || '') || null,
    multi_hero_resolver_needed_dbg: signals.multi_hero_resolver_needed_dbg === true,
    hero_primary_candidates_dbg: safeArray(signals.hero_primary_candidates_dbg).slice(0, 8),
  };
}

module.exports = {
  detectRagCentralityPostShape,
  buildRagCentralityDebugSummary,
  computeRagCentralityStats,
  rankRagCandidatesByCentrality,
  ragCentralitySubjecthoodSummaryForCandidate,
  titleAnchoredDirectSubjectQuestionRelaxesMultiProtectedSurface,
  candidateHasStrictProtectedTitlePrimary,
  candidateHasProtectedDirectSubjectKeep,
  candidateHasProtectedDirectSubjectStorageLock,
  candidateLooksLikeProtectedSelectedTitleSubject,
  candidateEligibleForAnswerSlotSubjectRescue,
  candidateHasDirectAnswerableRescue,
  candidateCategoryLower,
  candidateDirectSubjectStrengthDbg,
  candidateProtectedDirectSubjectKeepBaseState,
  candidateHasPresumptiveDirectPrimary,
  candidateIsBroadReviewSecondaryExample,
  candidateHasExplicitSecondaryExampleEvidence,
  candidateMustDemoteBroadReviewAtStorage,
  candidateHasOwnerEvidencePrimaryRescueBase,
  candidateHasOwnedSurfaceSubjectSupport,
  candidateSecondaryProfileDbg,
  candidateHasNonExclusiveBroadPrimaryBlock,
  candidateHasSystemWrapperChallengeDemoter,
  candidateHasStrictProtectedTitlePrimaryRaw,
  candidatePolicyBlocksAggressiveRescue,
  candidatePolicyRescueBlockReasons,
  candidateEffectivePolicySummary,
  candidateMatchesTitleSubject,
  candidateMatchesOpSubject,
  candidateOwnsTitleSubject,
  getUpstreamRescueModulation,
  packGateIsHardBlock,
  hasTitleOrOpEvidence,
  hasCommentEvidence,
  countEvidenceBySourceType,
  computeRepeatSameCanonicalN,
  computeSameOwnerSupportN,
  computeOwnerEvidenceStrength,
  broadGeneralComparisonThreadLike,
  broadMultiProtectedThreadLike,
  countProtectedEntityMentionsInText,
  titleSubjectCategoryLike,
  titleQuestionLike,
  titleDirectShapeLike,
  mapEnvironmentFeedbackThreadLike,
  stableKey,
  uniqueBoundedStrings,
};

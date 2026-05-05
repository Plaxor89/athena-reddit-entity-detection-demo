// directSubjectPolicySignals.js - Policy signals from title/op/upstream/answer_slot.
// Used by protected stage profile, RAG centrality, subjecthood.

function isObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

function toStr(v) {
  return v === null || v === undefined ? '' : String(v);
}

function getNested(obj, pathArr) {
  let cur = obj;
  for (const k of safeArray(pathArr)) {
    if (!isObject(cur) && !Array.isArray(cur)) return null;
    cur = cur?.[k];
    if (cur === undefined || cur === null) return null;
  }
  return cur;
}

function firstNonEmptyString(values) {
  for (const v of safeArray(values)) {
    const s = toStr(v).trim();
    if (s) return s;
  }
  return '';
}

function getTitleText(j) {
  return firstNonEmptyString([
    getNested(j, ['detect', 'sources', 'title', 'raw']),
    getNested(j, ['sources', 'title', 'raw']),
    getNested(j, ['title', 'raw']),
    j?.title,
    j?.post_title,
    j?.input_title,
  ]);
}

function getOpText(j) {
  return firstNonEmptyString([
    getNested(j, ['detect', 'sources', 'op', 'raw']),
    getNested(j, ['sources', 'op', 'raw']),
    getNested(j, ['op', 'raw']),
    j?.selftext,
    j?.body,
    j?.post_body,
    j?.op_text,
  ]);
}

function getDetectUpstream(j) {
  return isObject(j?.detect?.upstream) ? j.detect.upstream : {};
}

function getDetectUpstreamNormalized(j) {
  const upstream = getDetectUpstream(j);
  return isObject(upstream?.normalized) ? upstream.normalized : {};
}

function getDetectUpstreamPriors(j) {
  const upstream = getDetectUpstream(j);
  return isObject(upstream?.priors) ? upstream.priors : {};
}

function getDetectUpstreamQuestionIntent(j) {
  const normalized = getDetectUpstreamNormalized(j);
  return isObject(normalized?.question_intent) ? normalized.question_intent : {};
}

function getDetectAnswerSlot(j) {
  const detect = isObject(j?.detect) ? j.detect : {};
  return isObject(detect?.answer_slot) ? detect.answer_slot : {};
}

function getDetectUpstreamRiskModifier(j, key) {
  const priors = getDetectUpstreamPriors(j);
  const risk = isObject(priors?.risk_modifiers) ? priors.risk_modifiers : {};
  return risk?.[key];
}

function getClassifierHasMediaEvidence(j) {
  const normalized = getDetectUpstreamNormalized(j);
  if (normalized?.has_media_evidence === true) return true;
  return getDetectUpstreamRiskModifier(j, 'media_evidence') === true;
}

function normalizeFreeText(s) {
  return toStr(s)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function titleHasDirectSubjectContent(titleNorm) {
  const title = normalizeFreeText(titleNorm);
  if (!title) return false;
  return /\b(win[- ]rate|pick[- ]rate|mythic|weapon concept|concept|skin|disabled|bug|guide|tip|aurafarm|niche|role|build|buff|nerf|rework|art|fanart|cosplay|highlight|clip)\b/.test(
    title
  );
}

/** Title text only — excludes upstream question_intent (OP may be question-like while the title is a vibecheck head). */
function titleNormDirectSubjectQuestionPattern(titleNorm) {
  const t = normalizeFreeText(titleNorm);
  if (!t) return false;
  return /(what is .* current niche|what is .* niche|what is .* role|what is .* identity|why is .*|how is .*|is .* viable|is .* good|.* bug|.* skin|.* rework|.* buff|.* nerf)/.test(
    t
  );
}

function getDirectSubjectPolicySignals(j) {
  const detect = isObject(j?.detect) ? j.detect : {};
  const threadPolicy = isObject(detect?.thread_policy) ? detect.thread_policy : {};
  const answerSlot = getDetectAnswerSlot(j);
  const upstreamNormalized = getDetectUpstreamNormalized(j);
  const upstreamPriors = getDetectUpstreamPriors(j);
  const questionIntent = getDetectUpstreamQuestionIntent(j);

  const hasThreadPolicy = Object.keys(threadPolicy || {}).length > 0;
  const titleNorm = normalizeFreeText(getTitleText(j));
  const opNorm = normalizeFreeText(getOpText(j));
  const titleOpNorm = `${titleNorm} ${opNorm}`.trim();

  const upstreamSubjectLockPrior = upstreamPriors?.subject_lock_prior?.enabled === true;
  const upstreamDirectAnswerablePrior = upstreamPriors?.direct_answerable_prior?.enabled === true;
  const upstreamShowcaseVisualPrior = upstreamPriors?.showcase_visual_prior?.enabled === true;
  const upstreamPatchBundlePrior = upstreamPriors?.patch_bundle_prior?.enabled === true;
  const upstreamReviewComparisonPrior = upstreamPriors?.review_comparison_prior?.enabled === true;
  const upstreamRouteSuppressPrior = upstreamPriors?.route_suppress_prior?.enabled === true;
  const upstreamQuestionLike = questionIntent?.is_question_like === true;
  const upstreamHasGoodAnswer = upstreamNormalized?.has_good_answer === true;
  const upstreamHasMediaEvidence =
    upstreamNormalized?.has_media_evidence === true ||
    upstreamPriors?.risk_modifiers?.media_evidence === true;
  const upstreamLowSignal =
    upstreamNormalized?.is_low_signal === true || upstreamPriors?.risk_modifiers?.low_signal === true;
  const upstreamSarcastic =
    upstreamNormalized?.is_sarcastic_or_ironic === true ||
    upstreamPriors?.risk_modifiers?.sarcastic_or_ironic === true;
  const upstreamReliabilityWeight = Number.isFinite(Number(upstreamNormalized?.reliability_weight))
    ? Number(upstreamNormalized.reliability_weight)
    : Number.isFinite(Number(upstreamPriors?.risk_modifiers?.reliability_weight))
      ? Number(upstreamPriors.risk_modifiers.reliability_weight)
      : null;
  const upstreamTopicScope = toStr(upstreamNormalized?.topic_scope).trim().toUpperCase();
  const upstreamThreadType = toStr(upstreamNormalized?.thread_type).trim().toUpperCase();
  const upstreamPriorConfidenceRaw = Number(upstreamPriors?.prior_confidence);
  const upstreamPriorConfidence = Number.isFinite(upstreamPriorConfidenceRaw) ? upstreamPriorConfidenceRaw : 0;

  const answerSlotTier1Count = Number.isFinite(Number(answerSlot?.tier1_count)) ? Number(answerSlot.tier1_count) : 0;
  const answerSlotTier2Count = Number.isFinite(Number(answerSlot?.tier2_count)) ? Number(answerSlot.tier2_count) : 0;
  const answerSlotTier3Count = Number.isFinite(Number(answerSlot?.tier3_count)) ? Number(answerSlot.tier3_count) : 0;
  const answerSlotStrong = answerSlot?.has_strong_answer_slot === true;
  const answerSlotContradiction = answerSlot?.has_contradiction_signal === true;
  const answerSlotTier = toStr(threadPolicy?.answer_slot_tier || '').trim().toUpperCase() || null;

  const broadBundleLike =
    upstreamPatchBundlePrior ||
    /(patch notes?|mid[- ]season|notes update|new skins?|skin trailer|legendary skins?|hero select animations?|animations? trailer|trailer|gallery|bundle|pack|lineup|line-up|roster|cast|new heroes?|added heroes?|announcement|announcing|collab|collaboration|crossover|showcase|comp(s)? |poke comp|team comp|loadout|battle pass|season\s+\d+)/.test(
      titleOpNorm
    );
  const broadReviewLike =
    upstreamReviewComparisonPrior ||
    /(trying out|as a .* player|review|impressions|thoughts on|what do you think|anyone else|is it just me|counterwatch|philosophy|discussion)/.test(
      titleOpNorm
    );
  const advicePromptLike =
    /(what'?s the plan for|whats the plan for|how do you beat|how do you deal with|what do i do against|tips against|help with|need help with|advice for)/.test(
      titleOpNorm
    );
  const directSubjectQuestionLike =
    upstreamQuestionLike ||
    /(what is .* current niche|what is .* niche|what is .* role|what is .* identity|why is .*|how is .*|is .* viable|is .* good|.* bug|.* skin|.* rework|.* buff|.* nerf)/.test(
      titleNorm
    );
  const directSubjectContentLike = titleHasDirectSubjectContent(titleNorm);
  const explicitComparisonLike =
    /( vs |versus|matchup|match-up|interaction|interactions|synergy|duo|pairing| x |compare|comparison|against )/.test(
      titleOpNorm
    );

  const policyBroadGeneral = hasThreadPolicy && threadPolicy.broad_general === true;
  const policyQuestionAnswerable = hasThreadPolicy && threadPolicy.question_answerable === true;
  const policyNewsLike =
    (hasThreadPolicy && threadPolicy.news_like === true) ||
    upstreamPatchBundlePrior ||
    upstreamTopicScope === 'PATCH_NOTES' ||
    upstreamThreadType === 'NEWS';
  const policyReviewOrOpinionLike =
    (hasThreadPolicy && threadPolicy.review_or_opinion_like === true) || upstreamReviewComparisonPrior;
  const policyEntitySubjectRescueAllowed =
    hasThreadPolicy && threadPolicy.entity_subject_rescue_allowed === true;
  const policySubjectFavoring =
    (hasThreadPolicy && threadPolicy.subject_favoring === true) || upstreamSubjectLockPrior;

  const directAnswerableRescueAllowed =
    upstreamDirectAnswerablePrior === true &&
    (policyQuestionAnswerable === true || upstreamQuestionLike === true || upstreamHasGoodAnswer === true) &&
    answerSlotStrong === true &&
    answerSlotContradiction !== true &&
    !upstreamLowSignal &&
    !upstreamSarcastic &&
    !upstreamShowcaseVisualPrior &&
    !upstreamPatchBundlePrior;

  const answerSlotSubjectRescueAllowed =
    (hasThreadPolicy &&
      policyQuestionAnswerable &&
      policySubjectFavoring &&
      policyEntitySubjectRescueAllowed &&
      !policyBroadGeneral &&
      !policyReviewOrOpinionLike &&
      !policyNewsLike &&
      answerSlotStrong === true &&
      answerSlotContradiction !== true) ||
    (upstreamSubjectLockPrior &&
      !upstreamShowcaseVisualPrior &&
      !upstreamPatchBundlePrior &&
      !upstreamLowSignal &&
      !upstreamSarcastic &&
      answerSlotStrong === true &&
      answerSlotContradiction !== true) ||
    directAnswerableRescueAllowed;

  const titleExplicitComparisonLike = /(\bvs\b|versus|matchup|match-up|interaction|interactions|synergy|duo|pairing|compare|comparison|against)/.test(
    titleNorm
  );

  return {
    titleNorm,
    title_explicit_comparison_like: titleExplicitComparisonLike,
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
    direct_answerable_rescue_allowed: directAnswerableRescueAllowed,
    answer_slot_strong: answerSlotStrong,
    answer_slot_contradiction: answerSlotContradiction,
    answer_slot_tier: answerSlotTier,
    answer_slot_tier1_count: answerSlotTier1Count,
    answer_slot_tier2_count: answerSlotTier2Count,
    answer_slot_tier3_count: answerSlotTier3Count,
    upstreamSubjectLockPrior,
    upstreamDirectAnswerablePrior,
    upstreamShowcaseVisualPrior,
    upstreamPatchBundlePrior,
    upstreamReviewComparisonPrior,
    upstreamRouteSuppressPrior,
    upstreamQuestionLike,
    upstreamHasGoodAnswer,
    upstreamHasMediaEvidence,
    upstreamLowSignal,
    upstreamSarcastic,
    upstreamReliabilityWeight,
    upstreamTopicScope,
    upstreamThreadType,
    upstreamPriorConfidence,
  };
}

module.exports = {
  getDirectSubjectPolicySignals,
  titleNormDirectSubjectQuestionPattern,
  getTitleText,
  getOpText,
  getDetectUpstream,
  getDetectUpstreamNormalized,
  getDetectUpstreamPriors,
  getDetectAnswerSlot,
  getClassifierHasMediaEvidence,
  normalizeFreeText,
  getNested,
  firstNonEmptyString,
  isObject,
  safeArray,
  toStr,
};

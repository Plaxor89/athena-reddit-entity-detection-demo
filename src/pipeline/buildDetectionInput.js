// src/pipeline/buildDetectionInput.js
//
// Build Detection Input
// Pure request -> detection-contract stage.
//
// Notes:
// - No dictionary/static-policy loading in this stage
// - Preserves upstream/LMM-derived normalized fields
// - Answer-slot/comment-level detection fields are stage-1 defaults only

function toStr(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

function normalizeText(input) {
  let s = toStr(input);

  s = s.normalize('NFKC').toLowerCase();
  s = s.replace(/[\u2018\u2019\u201B]/g, "'");
  s = s.replace(/[\u201C\u201D]/g, '"');
  s = s.replace(/\bu\/[a-z0-9_-]+\b/gi, ' ');
  s = s.replace(/https?:\/\/\S+/gi, ' URL ');
  s = s.replace(/[^a-z0-9\s]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();

  return s;
}

function compactText(input) {
  return toStr(input).replace(/\s+/g, ' ').trim();
}

function isLikelyBotAuthor(author) {
  const a = toStr(author).trim().toLowerCase();
  if (!a) return false;
  return (
    a === 'automoderator' ||
    a.endsWith('bot') ||
    a.includes('auto moderator')
  );
}

function unique(arr) {
  return [...new Set((Array.isArray(arr) ? arr : []).filter(Boolean))];
}

function buildCommentWindows(topComments) {
  if (!Array.isArray(topComments)) return [];

  return topComments
    .filter(c => c && toStr(c.body).trim())
    .map((c, idx) => {
      const raw = toStr(c.body).trim();
      const author = toStr(c.author) || null;
      const norm = normalizeText(raw);
      const is_bot = isLikelyBotAuthor(author);

      return {
        id: `C${idx}`,
        rank: Number.isFinite(Number(c.rank)) ? Number(c.rank) : idx + 1,
        score: Number.isFinite(Number(c.score))
          ? Number(c.score)
          : (Number.isFinite(Number(c.ups)) ? Number(c.ups) : 0),
        author,
        is_bot,
        raw,
        norm,
        answer_tier: null,
        answer_flags: [],
        is_answer_like: false,
        contradiction: null
      };
    });
}

function hasAny(texts, patterns) {
  const hay = texts.filter(Boolean).join(' || ');
  return patterns.some(re => re.test(hay));
}

function collectMatches(texts, patternMap) {
  const hay = texts.filter(Boolean).join(' || ');
  const out = [];
  for (const [label, patterns] of Object.entries(patternMap)) {
    if (patterns.some(re => re.test(hay))) out.push(label);
  }
  return out;
}

function detectEntityIntent({ titleNorm, opNorm, commentsNormForIntent, upstreamNormalized, flairNorm, titleRaw, opRaw }) {
  const flairNormText = normalizeText(flairNorm || '');
  const textsPrimary = [titleNorm, opNorm, flairNormText];
  const textsComments = [commentsNormForIntent];
  const textsAll = [titleNorm, opNorm, flairNormText, commentsNormForIntent];

  const askRequestCues = [
    /\bwhat('?s| is)\b/,
    /\bwhich\b/,
    /\bhow do i\b/,
    /\bhow can i\b/,
    /\bshould i\b/,
    /\bdo i need\b/,
    /\bcan i\b/,
    /\brecommend\b/,
    /\bsuggest(?:ion|ions)?\b/,
    /\blooking for\b/,
    /\bneed help\b/,
    /\bhelp me\b/,
    /\btips?\b/,
    /\badvice\b/,
    /\bguide\b/,
    /\bany (tips|advice|suggestions?|recommendations?)\b/
  ];

  const strongComparativeAskCues = [
    /\bbest\b/,
    /\bworst\b/,
    /\bmost op\b/,
    /\bstrongest\b/,
    /\bmeta\b/
  ];

  const weakComparativeCues = [
    /\bbetter\b/
  ];

  const questionMarkPresentTitle = /\?/.test(toStr(titleRaw));
  const questionMarkPresentOp = /\?/.test(toStr(opRaw));
  const hasQuestionMark = questionMarkPresentTitle || questionMarkPresentOp;

  const hasAskRequestCuePrimary = hasAny(textsPrimary, askRequestCues);
  const hasStrongComparativeAskCuePrimary = hasAny(textsPrimary, strongComparativeAskCues);
  const hasWeakComparativeCuePrimary = hasAny(textsPrimary, weakComparativeCues);

  const categoryPatternsIntent = {
    hero: [
      /\bhero(?:es)?\b/, /\bcharacter(?:s)?\b/,
      /\btank(?:s)?\b/, /\bdps\b/, /\bdamage\b/, /\bsupport(?:s)?\b/
    ],
    map: [/\bmap(?:s)?\b/],
    rank: [/\brank(?:ed|s)?\b/, /\belo\b/, /\bmmr\b/, /\bbronze\b/, /\bsilver\b/, /\bgold\b/, /\bplat(?:inum)?\b/, /\bdiamond\b/, /\bmaster(?:s)?\b/, /\bgrandmaster\b/, /\bgm\b/, /\bchampion\b/],
    platform: [/\bpc\b/, /\bconsole\b/, /\bplaystation\b/, /\bps[45]\b/, /\bps\b/, /\bxbox\b/, /\bswitch\b/],
    queue: [/\bqueue\b/, /\brole queue\b/, /\bopen queue\b/, /\bquick ?play\b/, /\bqp\b/, /\bcomp\b/, /\branked\b/]
  };

  let targetCategoriesPrimary = collectMatches(textsPrimary, categoryPatternsIntent);
  const targetCategoriesCommentSecondary = collectMatches(textsComments, categoryPatternsIntent);

  const topicScope = toStr(upstreamNormalized.topic_scope).toUpperCase();
  if (topicScope === 'HERO_SPECIFIC' && !targetCategoriesPrimary.includes('hero')) targetCategoriesPrimary.push('hero');
  if (topicScope === 'MAP_STRATEGY' && !targetCategoriesPrimary.includes('map')) targetCategoriesPrimary.push('map');

  const rolePatterns = {
    tank: [/\btank(?:s)?\b/],
    damage: [/\bdps\b/, /\bdamage\b/],
    support: [/\bsupport(?:s)?\b/, /\bhealer(?:s)?\b/]
  };
  const roleFiltersPrimary = collectMatches(textsPrimary, rolePatterns);
  const roleFiltersCommentSecondary = collectMatches(textsComments, rolePatterns);

  const primaryHasCategoryCue = targetCategoriesPrimary.length > 0;

  const asksQuestion =
    hasQuestionMark ||
    hasAskRequestCuePrimary ||
    hasStrongComparativeAskCuePrimary;

  const asksForEntity =
    (hasAskRequestCuePrimary && primaryHasCategoryCue) ||
    (hasStrongComparativeAskCuePrimary && primaryHasCategoryCue);

  const rankContextPatterns = [/\b(rank|ranked|elo|mmr|bronze|silver|gold|plat|diamond|master|gm|grandmaster|champion)\b/];
  const mapContextPatterns = [/\bmap(?:s)?\b/, /\bon [a-z0-9 ]+ map\b/];
  const platformContextPatterns = [/\bpc\b/, /\bconsole\b/, /\bxbox\b/, /\bplaystation\b/, /\bps[45]?\b/, /\bswitch\b/];
  const queueContextPatterns = [/\brole queue\b/, /\bopen queue\b/, /\bqueue\b/, /\bquick ?play\b/, /\bqp\b/, /\bcomp\b/, /\branked\b/];

  const rankContextRequestedPrimary = hasAny(textsPrimary, rankContextPatterns);
  const rankContextRequestedCommentSecondary = hasAny(textsComments, rankContextPatterns);

  const mapContextRequestedPrimary = hasAny(textsPrimary, mapContextPatterns);
  const mapContextRequestedCommentSecondary = hasAny(textsComments, mapContextPatterns);

  const platformContextRequestedPrimary = hasAny(textsPrimary, platformContextPatterns);
  const platformContextRequestedCommentSecondary = hasAny(textsComments, platformContextPatterns);

  const queueContextRequestedPrimary = hasAny(textsPrimary, queueContextPatterns);
  const queueContextRequestedCommentSecondary = hasAny(textsComments, queueContextPatterns);

  const comparativeTerms = [];
  const compDefs = [
    ['best', /\bbest\b/],
    ['worst', /\bworst\b/],
    ['most_op', /\bmost op\b/],
    ['strongest', /\bstrongest\b/],
    ['meta', /\bmeta\b/],
    ['better', /\bbetter\b/]
  ];
  for (const [label, re] of compDefs) {
    if (hasAny(textsPrimary, [re])) comparativeTerms.push(label);
  }

  const timeTerms = [];
  const timeDefs = [
    ['this season', /\bthis season\b/],
    ['season', /\bseason\b/],
    ['right now', /\bright now\b/],
    ['currently', /\bcurrently\b/],
    ['patch', /\bpatch\b/],
    ['today', /\btoday\b/]
  ];
  for (const [label, re] of timeDefs) {
    if (hasAny(textsAll, [re])) timeTerms.push(label);
  }

  const targetCategories = unique([...targetCategoriesPrimary, ...targetCategoriesCommentSecondary]);
  const roleFilters = unique([...roleFiltersPrimary, ...roleFiltersCommentSecondary]);

  let confidence = 0.1;
  if (asksForEntity) confidence += 0.35;
  if (targetCategoriesPrimary.length) confidence += 0.2;
  if (roleFiltersPrimary.length) confidence += 0.1;

  if (hasStrongComparativeAskCuePrimary) confidence += 0.08;
  if (hasWeakComparativeCuePrimary) confidence += 0.02;

  if (timeTerms.length) confidence += 0.05;
  if (toStr(upstreamNormalized.thread_type).toUpperCase() === 'QUESTION') confidence += 0.1;
  if (upstreamNormalized.is_low_signal) confidence -= 0.1;
  if (upstreamNormalized.is_sarcastic_or_ironic) confidence -= 0.05;

  if (!targetCategoriesPrimary.length && targetCategoriesCommentSecondary.length) confidence += 0.03;
  if (!roleFiltersPrimary.length && roleFiltersCommentSecondary.length) confidence += 0.02;

  const qi = upstreamNormalized.question_intent || {};
  const qiIsQuestionLike = Boolean(qi.is_question_like);
  const qiType = toStr(qi.question_type).toUpperCase();
  const qiConf = Number.isFinite(Number(qi.question_confidence)) ? Number(qi.question_confidence) : 0;

  if (qiIsQuestionLike && qiConf >= 0.7) confidence += 0.05;
  if (qiType === 'RECOMMENDATION' && primaryHasCategoryCue) confidence += 0.05;
  if (qiType === 'TROUBLESHOOTING') confidence += 0.03;

  const userGoal = toStr(upstreamNormalized.user_goal).toUpperCase();
  if (userGoal === 'DECIDE_CHOICE' && primaryHasCategoryCue) confidence += 0.04;
  if (userGoal === 'SHARE_REACTION') confidence -= 0.04;
  if (upstreamNormalized.needs_clarification) confidence -= 0.05;

  confidence = Math.max(0, Math.min(1, confidence));

  return {
    asks_question: Boolean(asksQuestion || (qiIsQuestionLike && qiConf >= 0.6)),
    asks_for_entity: Boolean(asksForEntity),

    target_categories_primary: unique(targetCategoriesPrimary),
    target_categories_comment_secondary: unique(targetCategoriesCommentSecondary),
    target_categories: targetCategories,

    role_filters_primary: unique(roleFiltersPrimary),
    role_filters_comment_secondary: unique(roleFiltersCommentSecondary),
    role_filters: roleFilters,

    rank_context_requested_primary: Boolean(rankContextRequestedPrimary),
    rank_context_requested_comment_secondary: Boolean(rankContextRequestedCommentSecondary),
    rank_context_requested: Boolean(rankContextRequestedPrimary || rankContextRequestedCommentSecondary),

    map_context_requested_primary: Boolean(mapContextRequestedPrimary),
    map_context_requested_comment_secondary: Boolean(mapContextRequestedCommentSecondary),
    map_context_requested: Boolean(mapContextRequestedPrimary || mapContextRequestedCommentSecondary),

    platform_context_requested_primary: Boolean(platformContextRequestedPrimary),
    platform_context_requested_comment_secondary: Boolean(platformContextRequestedCommentSecondary),
    platform_context_requested: Boolean(platformContextRequestedPrimary || platformContextRequestedCommentSecondary),

    queue_context_requested_primary: Boolean(queueContextRequestedPrimary),
    queue_context_requested_comment_secondary: Boolean(queueContextRequestedCommentSecondary),
    queue_context_requested: Boolean(queueContextRequestedPrimary || queueContextRequestedCommentSecondary),

    comparative_terms: unique(comparativeTerms),
    time_context_terms: unique(timeTerms),
    confidence: Number(confidence.toFixed(2)),

    debug: {
      question_mark_present_title: questionMarkPresentTitle,
      question_mark_present_op: questionMarkPresentOp,
      has_ask_request_cue_primary: hasAskRequestCuePrimary,
      has_strong_comparative_ask_cue_primary: hasStrongComparativeAskCuePrimary,
      has_weak_comparative_cue_primary: hasWeakComparativeCuePrimary,
      primary_has_category_cue: primaryHasCategoryCue,
      qi_is_question_like: qiIsQuestionLike,
      qi_type: qiType || null,
      qi_conf: Number(qiConf.toFixed ? qiConf.toFixed(2) : qiConf),
      user_goal: userGoal || null,
      needs_clarification: Boolean(upstreamNormalized.needs_clarification)
    }
  };
}

function summarizeAnswerSlot(comments) {
  const nonBot = comments.filter(c => c && !c.is_bot);

  const tier1 = nonBot.filter(c => c.answer_tier === 'TIER1').map(c => c.id);
  const tier2 = nonBot.filter(c => c.answer_tier === 'TIER2').map(c => c.id);
  const tier3 = nonBot.filter(c => c.answer_tier === 'TIER3').map(c => c.id);

  const answerLike = nonBot.filter(c => c.is_answer_like).map(c => c.id);
  const hasContradiction = nonBot.some(c => c.answer_tier === 'TIER3');

  return {
    tier1_count: tier1.length,
    tier2_count: tier2.length,
    tier3_count: tier3.length,
    has_strong_answer_slot: tier1.length > 0 || tier3.length > 0,
    has_contradiction_signal: hasContradiction,
    answer_like_comment_ids: answerLike,
    tier3_comment_ids: tier3
  };
}

function deriveThreadPolicy(upstreamNormalized, answerSlot) {
  const threadType = toStr(upstreamNormalized?.thread_type).trim().toUpperCase();
  const topicScope = toStr(upstreamNormalized?.topic_scope).trim().toUpperCase();
  const userGoal = toStr(upstreamNormalized?.user_goal).trim().toUpperCase();
  const tags = Array.isArray(upstreamNormalized?.tags)
    ? upstreamNormalized.tags.map(t => toStr(t).trim().toUpperCase()).filter(Boolean)
    : [];
  const qi = (upstreamNormalized?.question_intent && typeof upstreamNormalized.question_intent === 'object')
    ? upstreamNormalized.question_intent
    : {};
  const qiIsQuestionLike = Boolean(qi.is_question_like);
  const qiType = toStr(qi.question_type).trim().toUpperCase();
  const qiConf = Number.isFinite(Number(qi.question_confidence)) ? Number(qi.question_confidence) : 0;
  const hasGoodAnswer = Boolean(upstreamNormalized?.has_good_answer);
  const answerQuality = (upstreamNormalized?.answer_quality && typeof upstreamNormalized.answer_quality === 'object')
    ? upstreamNormalized.answer_quality
    : {};
  const answerConf = Number.isFinite(Number(answerQuality.answer_confidence)) ? Number(answerQuality.answer_confidence) : 0;
  const isLowSignal = Boolean(upstreamNormalized?.is_low_signal);
  const isSarcastic = Boolean(upstreamNormalized?.is_sarcastic_or_ironic);

  const tagSet = new Set(tags);

  const newsLike =
    threadType === 'NEWS' ||
    topicScope === 'PATCH_NOTES' ||
    userGoal === 'NEWS_CONSUME';

  const reviewOrOpinionLike =
    userGoal === 'DISCUSS_OPINION' ||
    userGoal === 'SHARE_REACTION' ||
    userGoal === 'GENERAL_CHAT' ||
    (threadType === 'DISCUSSION' && !qiIsQuestionLike) ||
    tagSet.has('RANT') ||
    tagSet.has('HUMOR');

  const broadGeneral =
    newsLike ||
    topicScope === 'GENERAL_META' ||
    isLowSignal ||
    isSarcastic ||
    reviewOrOpinionLike ||
    tagSet.has('META_ANALYSIS') ||
    threadType === 'CLIP_OR_MEME';

  const subjectFavoring =
    !broadGeneral &&
    (threadType === 'QUESTION' || threadType === 'GUIDE' || threadType === 'BUG_REPORT' || topicScope === 'HERO_SPECIFIC');

  const questionAnswerable =
    qiIsQuestionLike &&
    qiConf >= 0.55 &&
    !isLowSignal &&
    (hasGoodAnswer || answerConf >= 0.55 || Boolean(answerSlot?.has_strong_answer_slot));

  const answerSlotStrong = Boolean(answerSlot?.has_strong_answer_slot) && !Boolean(answerSlot?.has_contradiction_signal);
  const answerSlotTier =
    answerSlot?.tier1_count > 0 ? 'TIER1' :
    answerSlot?.tier3_count > 0 ? 'TIER3' :
    answerSlot?.tier2_count > 0 ? 'TIER2' :
    null;

  const entitySubjectRescueAllowed =
    !newsLike &&
    !reviewOrOpinionLike &&
    (subjectFavoring || (questionAnswerable && answerSlotStrong));

  return {
    broad_general: Boolean(broadGeneral),
    subject_favoring: Boolean(subjectFavoring),
    question_answerable: Boolean(questionAnswerable),
    news_like: Boolean(newsLike),
    review_or_opinion_like: Boolean(reviewOrOpinionLike),
    entity_subject_rescue_allowed: Boolean(entitySubjectRescueAllowed),
    answer_slot_strong: Boolean(answerSlotStrong),
    answer_slot_tier: answerSlotTier,
    question_type: qiType || 'OTHER',
    question_confidence: qiConf
  };
}

function titleLooksCreatorCredit(rawTitle, rawOp) {
  const hay = `${toStr(rawTitle)} || ${toStr(rawOp)}`;
  return (
    /\(by\s+@?[a-z0-9_.-]+\)/i.test(hay) ||
    /\bby\s+@?[a-z0-9_.-]+\b/i.test(hay) ||
    /\bart\s+by\b/i.test(hay) ||
    /\bsource\s*:\s*(x|twitter|pixiv|instagram|artstation|deviantart|tumblr)\b/i.test(hay)
  );
}

function buildPriorState(enabled, rawSignals) {
  const considered = unique(rawSignals);
  return {
    enabled: Boolean(enabled),
    signals: enabled ? considered : [],
    considered_signals: considered
  };
}

function deriveUpstreamPriors({ upstreamNormalized, threadPolicy, answerSlot, titleRaw, opRaw }) {
  const qi = (upstreamNormalized?.question_intent && typeof upstreamNormalized.question_intent === 'object')
    ? upstreamNormalized.question_intent
    : {};
  const qiType = toStr(qi.question_type).trim().toUpperCase();
  const qiIsQuestionLike = Boolean(qi.is_question_like);
  const qiConf = Number.isFinite(Number(qi.question_confidence)) ? Number(qi.question_confidence) : 0;
  const reliability = Number.isFinite(Number(upstreamNormalized?.reliability_weight))
    ? Number(upstreamNormalized.reliability_weight)
    : 0;

  const signals = {
    subject_lock_prior: [],
    direct_answerable_prior: [],
    showcase_visual_prior: [],
    patch_bundle_prior: [],
    review_comparison_prior: [],
    route_suppress_prior: []
  };

  const creatorCredit = titleLooksCreatorCredit(titleRaw, opRaw);
  const mediaEvidence = Boolean(upstreamNormalized?.has_media_evidence);
  const lowSignal = Boolean(upstreamNormalized?.is_low_signal);
  const sarcastic = Boolean(upstreamNormalized?.is_sarcastic_or_ironic);
  const hasGoodAnswer = Boolean(upstreamNormalized?.has_good_answer);
  const userGoal = toStr(upstreamNormalized?.user_goal).trim().toUpperCase();
  const topicScope = toStr(upstreamNormalized?.topic_scope).trim().toUpperCase();
  const threadType = toStr(upstreamNormalized?.thread_type).trim().toUpperCase();

  if (threadPolicy?.subject_favoring) signals.subject_lock_prior.push('thread_policy:subject_favoring');
  if (threadPolicy?.entity_subject_rescue_allowed) signals.subject_lock_prior.push('thread_policy:entity_subject_rescue_allowed');
  if (threadPolicy?.question_answerable) signals.subject_lock_prior.push('thread_policy:question_answerable');
  if (threadPolicy?.answer_slot_strong) signals.subject_lock_prior.push('thread_policy:answer_slot_strong');
  if (qiIsQuestionLike && qiConf >= 0.6) signals.subject_lock_prior.push('question_intent:question_like');
  if (hasGoodAnswer) signals.subject_lock_prior.push('llm:has_good_answer');

  if (qiIsQuestionLike && qiConf >= 0.55) signals.direct_answerable_prior.push('question_intent:question_like');
  if (['TROUBLESHOOTING', 'HOW_TO', 'RECOMMENDATION', 'CHOICE'].includes(qiType)) {
    signals.direct_answerable_prior.push(`question_type:${qiType}`);
  }
  if (threadPolicy?.question_answerable) signals.direct_answerable_prior.push('thread_policy:question_answerable');
  if (threadPolicy?.answer_slot_strong) signals.direct_answerable_prior.push('thread_policy:answer_slot_strong');
  if (hasGoodAnswer) signals.direct_answerable_prior.push('llm:has_good_answer');

  if (mediaEvidence) signals.showcase_visual_prior.push('llm:has_media_evidence');
  if (creatorCredit) signals.showcase_visual_prior.push('title_shape:creator_credit');
  if (threadPolicy?.review_or_opinion_like) signals.showcase_visual_prior.push('thread_policy:review_or_opinion_like');
  if (!threadPolicy?.question_answerable) signals.showcase_visual_prior.push('thread_policy:not_question_answerable');
  if (!threadPolicy?.news_like) signals.showcase_visual_prior.push('thread_policy:not_news_like');

  if (topicScope === 'PATCH_NOTES') signals.patch_bundle_prior.push('topic_scope:PATCH_NOTES');
  if (threadPolicy?.news_like) signals.patch_bundle_prior.push('thread_policy:news_like');
  if (!threadPolicy?.answer_slot_strong) signals.patch_bundle_prior.push('thread_policy:no_strong_answer_slot');
  if (threadType === 'NEWS') signals.patch_bundle_prior.push('thread_type:NEWS');

  if (threadPolicy?.review_or_opinion_like) signals.review_comparison_prior.push('thread_policy:review_or_opinion_like');
  if (threadPolicy?.broad_general) signals.review_comparison_prior.push('thread_policy:broad_general');
  if (['DISCUSS_OPINION', 'SHARE_REACTION', 'GENERAL_CHAT'].includes(userGoal)) {
    signals.review_comparison_prior.push(`user_goal:${userGoal}`);
  }
  if (qiType === 'RECOMMENDATION') signals.review_comparison_prior.push('question_type:RECOMMENDATION');

  if (lowSignal) signals.route_suppress_prior.push('llm:is_low_signal');
  if (sarcastic) signals.route_suppress_prior.push('llm:is_sarcastic_or_ironic');
  if (reliability > 0 && reliability < 0.35) signals.route_suppress_prior.push('llm:low_reliability_weight');
  if (signals.patch_bundle_prior.length >= 2) signals.route_suppress_prior.push('prior:patch_bundle');
  if (signals.review_comparison_prior.length >= 2 && !threadPolicy?.question_answerable) {
    signals.route_suppress_prior.push('prior:review_comparison');
  }

  const priorConfidence = Math.max(0, Math.min(1,
    0.2 +
    (signals.subject_lock_prior.length ? 0.18 : 0) +
    (signals.direct_answerable_prior.length ? 0.18 : 0) +
    (signals.showcase_visual_prior.length ? 0.12 : 0) +
    (signals.patch_bundle_prior.length ? 0.1 : 0) +
    (signals.review_comparison_prior.length ? 0.08 : 0) +
    (reliability > 0 ? Math.min(0.14, reliability * 0.2) : 0) -
    (lowSignal ? 0.08 : 0) -
    (sarcastic ? 0.06 : 0)
  ));

  return {
    normalized: upstreamNormalized,
    priors: {
      subject_lock_prior: buildPriorState(
        signals.subject_lock_prior.length >= 2 && !lowSignal && !sarcastic,
        signals.subject_lock_prior
      ),
      direct_answerable_prior: buildPriorState(
        signals.direct_answerable_prior.length >= 2 && !lowSignal && !sarcastic,
        signals.direct_answerable_prior
      ),
      showcase_visual_prior: buildPriorState(
        mediaEvidence &&
          creatorCredit &&
          !threadPolicy?.question_answerable &&
          !threadPolicy?.news_like,
        signals.showcase_visual_prior
      ),
      patch_bundle_prior: buildPriorState(
        signals.patch_bundle_prior.length >= 2,
        signals.patch_bundle_prior
      ),
      review_comparison_prior: buildPriorState(
        signals.review_comparison_prior.length >= 2,
        signals.review_comparison_prior
      ),
      route_suppress_prior: buildPriorState(
        signals.route_suppress_prior.length >= 1,
        signals.route_suppress_prior
      ),
      prior_confidence: Number(priorConfidence.toFixed(2)),
      risk_modifiers: {
        low_signal: lowSignal,
        sarcastic_or_ironic: sarcastic,
        media_evidence: mediaEvidence,
        reliability_weight: Number.isFinite(Number(reliability)) ? Number(reliability.toFixed(2)) : null
      }
    }
  };
}

function buildUpstreamNormalized(j) {
  return {
    thread_type: toStr(j.thread_type) || null,
    topic_scope: toStr(j.topic_scope) || null,
    tags: Array.isArray(j.tags) ? j.tags.map(t => toStr(t)).filter(Boolean) : [],
    is_low_signal: Boolean(j.is_low_signal),
    is_sarcastic_or_ironic: Boolean(j.is_sarcastic_or_ironic),
    has_good_answer: Boolean(j.has_good_answer),
    has_media_evidence: Boolean(j.has_media_evidence),
    reliability_weight: Number.isFinite(Number(j.reliability_weight)) ? Number(j.reliability_weight) : null,
    question_intent: (j.question_intent && typeof j.question_intent === 'object') ? j.question_intent : null,
    answer_quality: (j.answer_quality && typeof j.answer_quality === 'object') ? j.answer_quality : null,
    user_goal: toStr(j.user_goal) || null,
    response_mode: toStr(j.response_mode) || null,
    needs_clarification: Boolean(j.needs_clarification),
    op_summary: toStr(j.op_summary) || '',
    comments_summary: toStr(j.comments_summary) || '',
    answer_summary: toStr(j.answer_summary) || ''
  };
}

function buildDetectionInput(upstreamRequestItem) {
  const j = upstreamRequestItem || {};

  const titleRaw = compactText(j.title);
  const opRaw = compactText(j.body || j.selftext || '');
  const comments = buildCommentWindows(j.top_comments);

  const titleNorm = normalizeText(titleRaw);
  const opNorm = normalizeText(opRaw);

  const upstreamNormalized = buildUpstreamNormalized(j);

  const commentsRawJoined = comments.map(c => c.raw).join('\n');
  const commentsNormJoined = comments.map(c => c.norm).join(' ');
  const commentsNormForIntent = comments.filter(c => !c.is_bot).map(c => c.norm).join(' ');

  const intent = detectEntityIntent({
    titleNorm,
    opNorm,
    commentsNormForIntent,
    upstreamNormalized,
    flairNorm: j.flair_normalized,
    titleRaw,
    opRaw
  });

  const answer_slot = summarizeAnswerSlot(comments);
  const thread_policy = deriveThreadPolicy(upstreamNormalized, answer_slot);
  const upstream = deriveUpstreamPriors({
    upstreamNormalized,
    threadPolicy: thread_policy,
    answerSlot: answer_slot,
    titleRaw,
    opRaw
  });

  const debugDetectionSnapshot = {
    comment_count: comments.length,
    comment_count_non_bot_for_intent: comments.filter(c => !c.is_bot).length,
    bot_comment_count: comments.filter(c => c.is_bot).length,
    has_title_text: !!titleNorm,
    has_op_text: !!opNorm,
    asks_question: intent.asks_question,
    asks_for_entity: intent.asks_for_entity,
    target_categories_primary: intent.target_categories_primary,
    target_categories: intent.target_categories,
    question_mark_present_title: intent.debug?.question_mark_present_title || false,
    question_mark_present_op: intent.debug?.question_mark_present_op || false,

    answer_tier1_count: answer_slot.tier1_count,
    answer_tier2_count: answer_slot.tier2_count,
    answer_tier3_count: answer_slot.tier3_count,
    has_strong_answer_slot: answer_slot.has_strong_answer_slot,
    has_contradiction_signal: answer_slot.has_contradiction_signal,

    thread_policy_broad_general: thread_policy.broad_general,
    thread_policy_subject_favoring: thread_policy.subject_favoring,
    thread_policy_question_answerable: thread_policy.question_answerable,
    thread_policy_news_like: thread_policy.news_like,
    thread_policy_review_or_opinion_like: thread_policy.review_or_opinion_like,
    thread_policy_entity_subject_rescue_allowed: thread_policy.entity_subject_rescue_allowed,
    thread_policy_answer_slot_strong: thread_policy.answer_slot_strong,
    thread_policy_answer_slot_tier: thread_policy.answer_slot_tier,

    upstream_subject_lock_prior: upstream.priors.subject_lock_prior.enabled,
    upstream_direct_answerable_prior: upstream.priors.direct_answerable_prior.enabled,
    upstream_showcase_visual_prior: upstream.priors.showcase_visual_prior.enabled,
    upstream_patch_bundle_prior: upstream.priors.patch_bundle_prior.enabled,
    upstream_review_comparison_prior: upstream.priors.review_comparison_prior.enabled,
    upstream_route_suppress_prior: upstream.priors.route_suppress_prior.enabled,

    answer_slot_library_loaded: false
  };

  return {
    post_id: toStr(j.post_id || '').trim(),
    detect: {
      sources: {
        title: { raw: titleRaw, norm: titleNorm },
        op: { raw: opRaw, norm: opNorm },
        comments
      },
      upstream,
      intent,
      answer_slot,
      thread_policy,
      weights: {
        title: 1.0,
        op: 0.9,
        comment: 0.55
      },
      joins: {
        comments_raw: commentsRawJoined,
        comments_norm: commentsNormJoined,
        comments_norm_for_intent: commentsNormForIntent
      }
    },
    debug_detection_snapshot: debugDetectionSnapshot
  };
}

module.exports = {
  buildDetectionInput,
};
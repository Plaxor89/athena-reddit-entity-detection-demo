// ragCentralityDemotions.js - RAG centrality demotions and hero primary cardinality cap.

const { annotateStorageExplanationBundle } = require('./storageIntent');
const { annotateLaneAuditBundle } = require('./laneAudit');
const {
  detectRagCentralityPostShape,
  buildRagCentralityDebugSummary,
  computeRagCentralityStats,
  rankRagCandidatesByCentrality,
  candidateHasStrictProtectedTitlePrimary,
  candidateHasProtectedDirectSubjectStorageLock,
  candidateEligibleForAnswerSlotSubjectRescue,
  candidateIsBroadReviewSecondaryExample,
  candidateMustDemoteBroadReviewAtStorage,
  candidateCategoryLower,
  candidateMatchesTitleSubject,
  candidateHasPresumptiveDirectPrimary,
  candidateHasExplicitSecondaryExampleEvidence,
  stableKey,
} = require('./ragCentrality');
const {
  getTitleText,
  getOpText,
  normalizeFreeText,
  getDirectSubjectPolicySignals,
} = require('./directSubjectPolicySignals');

function isObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

function toStr(v) {
  return v === null || v === undefined ? '' : String(v);
}

function prefixOf(reason) {
  const s = toStr(reason);
  const i = s.indexOf(':');
  return i > 0 ? s.slice(0, i) : 'other';
}

/** Earliest mention of any normalized slug variant in title (for news/patch headline tie-break). */
function earliestHeroMentionPosInTitle(cand, titleNorm) {
  const tn = normalizeFreeText(titleNorm);
  if (!tn || !isObject(cand)) return Infinity;
  const parts = uniqueBoundedStrings(
    safeArray([
      cand.canonical_slug,
      cand.hero_slug,
      cand.label_dbg,
      cand.label,
      cand.canonical_name,
      ...(Array.isArray(cand.alias_norms) ? cand.alias_norms : []),
    ])
      .map((x) => normalizeFreeText(x))
      .filter(Boolean),
    10
  );
  let best = Infinity;
  for (const p of parts) {
    if (!p || p.length < 2) continue;
    const idx = tn.indexOf(p);
    if (idx >= 0 && idx < best) best = idx;
  }
  return best;
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

function applyCentralityDemotionContractRewrite(target, reasonPrimary, postShape = null) {
  if (!isObject(target)) return target;
  // Durable latch: annotateLaneAuditBundle (called below) rebuilds storage_promotion_path_dbg /
  // storage_block_signals_dbg and drops centrality tokens; subject-tier HARD_PRIMARY must still see
  // that this row was centrally demoted (see subjectTierLaneMapping hasCentralityDemotionLatch).
  target.det_centrality_demotion_applied = true;
  target.det_centrality_demotion_shape = postShape != null && toStr(postShape).trim()
    ? toStr(postShape).trim()
    : null;
  const primary = toStr(reasonPrimary).trim() || 'storage:context_only:primary_centrality_insufficient';
  const existingReasons = safeArray(target?.storage_reasons)
    .map(toStr)
    .filter(Boolean)
    .filter((r) => !r.startsWith('storage:rag_ok:') && !r.startsWith('storage:context_only:'));
  const orderedReasons = [primary];
  if (primary !== 'storage:context_only:primary_centrality_insufficient') {
    orderedReasons.push('storage:context_only:primary_centrality_insufficient');
  }
  orderedReasons.push(...existingReasons);
  target.storage_intent = 'CONTEXT_ONLY';
  target.storage_reasons = uniqueBoundedStrings(orderedReasons, 12);
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
        !v.startsWith('storage:rag_ok:') && !v.startsWith('storage:context_only:')
    );
  const path = [...existingPath, primary];
  if (postShape) path.push(`centrality_shape:${toStr(postShape).trim()}`);
  target.storage_promotion_path_dbg = uniqueBoundedStrings(path, 12);
  const existingBlocks = safeArray(target?.storage_block_signals_dbg)
    .map(toStr)
    .filter(Boolean)
    .filter(
      (v) =>
        !v.startsWith('block:centrality_demotion') &&
        !v.startsWith('block:centrality_shape:')
    );
  const blockSignals = [
    ...existingBlocks,
    'block:centrality_demotion',
    `block:centrality_demotion:${prefixOf(primary)}`,
    `block:centrality_demotion_reason:${primary}`,
  ];
  if (postShape) blockSignals.push(`block:centrality_shape:${toStr(postShape).trim()}`);
  target.storage_block_signals_dbg = uniqueBoundedStrings(blockSignals, 12);
  annotateStorageExplanationBundle(target);
  annotateLaneAuditBundle(target);
  return target;
}

function applyHeroPrimaryCardinalityCap(j, selected, info, demotions = []) {
  const signals = isObject(info) ? info : detectRagCentralityPostShape(j, selected);
  const ragHeroes = safeArray(selected).filter(
    (c) =>
      toStr(c?.storage_intent).toUpperCase() === 'RAG_OK' &&
      candidateCategoryLower(c) === 'hero'
  );
  if (ragHeroes.length <= 1) {
    signals.hero_primary_cardinality_dbg = ragHeroes.length === 1 ? 'one' : 'zero';
    signals.hero_primary_keep_n_dbg = ragHeroes.length;
    signals.hero_primary_cap_reason_dbg =
      ragHeroes.length === 1 ? 'single_existing_primary' : 'no_hero_rag';
    signals.multi_hero_resolver_needed_dbg = false;
    return { changed: false, demotions, info: signals };
  }
  const titleNorm = normalizeFreeText(getTitleText(j));
  const opNorm = normalizeFreeText(getOpText(j));
  const titleOpNorm = `${titleNorm} ${opNorm}`.trim();
  const policySignals = getDirectSubjectPolicySignals(j);
  /** True list/topic gallery shape — blocks focused-head relaxation (B1). Not the same as broad_bundle_like (co-mentioned heroes can set that on patch threads — B3). */
  const strictShapeTopicOrGallery =
    toStr(signals.shape) === 'broad_bundle_or_gallery' ||
    toStr(signals.shape) === 'general_topic_with_entity_examples';
  const broadFamily =
    toStr(signals.shape) === 'broad_bundle_or_gallery' ||
    toStr(signals.shape) === 'general_topic_with_entity_examples' ||
    signals.broad_bundle_like === true ||
    signals.broad_review_like === true ||
    signals.policy_review_or_opinion_like === true ||
    signals.policy_broad_general === true ||
    signals.policy_news_like === true;
  const groupedShowcaseLike = /\b(fanart|art|cosplay|skin|showcase|gallery|mythic|concept|highlight intro|model|morning vibes)\b/.test(
    titleOpNorm
  );
  /** Pair comparisons stay available for focused patch/HUD threads where only policy-surface flags set broadFamily. */
  const newsPolicyAllowsPairCompare =
    signals.policy_news_like === true && !strictShapeTopicOrGallery && !groupedShowcaseLike;
  const explicitPairFrame =
    (signals.title_explicit_comparison_like === true || signals.explicit_comparison_like === true) &&
    ragHeroes.length === 2 &&
    (!broadFamily || newsPolicyAllowsPairCompare);
  const ranked = rankRagCandidatesByCentrality(ragHeroes).map((x) => {
    const c = x.cand;
    return {
      cand: c,
      stats: x.stats,
      key: stableKey(c),
      strictTitlePrimary: candidateHasStrictProtectedTitlePrimary(c, j, policySignals),
      storageLock: candidateHasProtectedDirectSubjectStorageLock(c, j, policySignals, selected),
      answerSlotKeep: candidateEligibleForAnswerSlotSubjectRescue(c, policySignals, titleNorm),
      titleMention: candidateMatchesTitleSubject(c, titleNorm),
      presumptivePrimary: candidateHasPresumptiveDirectPrimary(c, j, policySignals, selected),
    };
  });
  let exclusiveOwners = ranked.filter((r) => r.strictTitlePrimary || r.answerSlotKeep);
  if (broadFamily && exclusiveOwners.length > 1) {
    const titleSurface = exclusiveOwners.filter((r) => r.titleMention === true);
    if (titleSurface.length === 1) exclusiveOwners = titleSurface;
  }
  const keepKeys = new Set();
  let cardinality = 'unresolved';
  let capReason = 'unresolved_multi_hero';
  let resolverNeeded = false;
  if (
    explicitPairFrame &&
    ranked.every((r) => r.titleMention && (r.storageLock || r.presumptivePrimary))
  ) {
    if (
      signals.policy_news_like === true &&
      ranked.length === 2
    ) {
      const byHeadline = ranked.slice().sort((a, b) => {
        const pa = earliestHeroMentionPosInTitle(a.cand, titleNorm);
        const pb = earliestHeroMentionPosInTitle(b.cand, titleNorm);
        if (pa !== pb) return pa - pb;
        return (Number(b.stats?.direct_subject_strength) || 0) - (Number(a.stats?.direct_subject_strength) || 0);
      });
      keepKeys.add(byHeadline[0].key);
      cardinality = 'one';
      capReason = 'news_comparison_single_headline_winner';
    } else {
      ranked.slice(0, 2).forEach((r) => keepKeys.add(r.key));
      cardinality = 'multi';
      capReason = 'explicit_pair_frame';
    }
  } else if (broadFamily || groupedShowcaseLike || ragHeroes.length >= 3) {
    if (exclusiveOwners.length === 1) {
      keepKeys.add(exclusiveOwners[0].key);
      cardinality = 'one';
      capReason = broadFamily
        ? 'broad_family_single_owner'
        : 'grouped_showcase_single_owner';
    } else if (
      !groupedShowcaseLike &&
      !strictShapeTopicOrGallery &&
      exclusiveOwners.length === 0 &&
      ragHeroes.length <= 4 &&
      signals.broad_review_like !== true &&
      signals.policy_review_or_opinion_like !== true &&
      (signals.policy_news_like === true ||
        signals.title_explicit_comparison_like === true ||
        signals.explicit_comparison_like === true)
    ) {
      let expandedOwners = ranked.filter(
        (r) =>
          r.strictTitlePrimary ||
          r.answerSlotKeep ||
          (r.titleMention && (r.storageLock || r.presumptivePrimary))
      );
      if (
        expandedOwners.length === 0 &&
        signals.policy_news_like === true
      ) {
        expandedOwners = ranked.filter((r) => r.titleMention === true);
      }
      if (expandedOwners.length === 1) {
        keepKeys.add(expandedOwners[0].key);
        cardinality = 'one';
        capReason = 'broad_family_focused_exclusive_expanded';
      } else if (
        expandedOwners.length > 1 &&
        signals.policy_news_like === true
      ) {
        const sorted = expandedOwners.slice().sort((a, b) => {
          const ds =
            (Number(b.stats?.direct_subject_strength) || 0) -
            (Number(a.stats?.direct_subject_strength) || 0);
          if (ds !== 0) return ds;
          return (Number(b.cand?.det_score) || 0) - (Number(a.cand?.det_score) || 0);
        });
        const topDs = Number(sorted[0]?.stats?.direct_subject_strength) || 0;
        const tieAtTop = sorted.filter(
          (r) => (Number(r.stats?.direct_subject_strength) || 0) === topDs
        );
        let winner = null;
        if (tieAtTop.length === 1) {
          winner = tieAtTop[0];
        } else if (tieAtTop.length > 1) {
          const primed = tieAtTop.find((r) => r.strictTitlePrimary === true);
          if (primed) winner = primed;
        }
        if (!winner && tieAtTop.length > 1) {
          let bestPos = Infinity;
          const atBestPos = [];
          for (const r of tieAtTop) {
            const pos = earliestHeroMentionPosInTitle(r.cand, titleNorm);
            if (pos < bestPos) {
              bestPos = pos;
              atBestPos.length = 0;
              atBestPos.push(r);
            } else if (pos === bestPos && pos < Infinity) {
              atBestPos.push(r);
            }
          }
          if (atBestPos.length === 1) winner = atBestPos[0];
          else if (atBestPos.length > 1) {
            atBestPos.sort(
              (a, b) => (Number(b.cand?.det_score) || 0) - (Number(a.cand?.det_score) || 0)
            );
            winner = atBestPos[0];
          }
        }
        if (winner) {
          keepKeys.add(winner.key);
          cardinality = 'one';
          capReason = 'broad_family_news_focused_strength_winner';
        } else {
          cardinality = 'zero';
          capReason = broadFamily
            ? 'broad_family_no_exclusive_owner'
            : 'grouped_showcase_no_exclusive_owner';
        }
      } else {
        cardinality = 'zero';
        capReason = broadFamily
          ? 'broad_family_no_exclusive_owner'
          : 'grouped_showcase_no_exclusive_owner';
      }
    } else {
      cardinality = 'zero';
      capReason = broadFamily
        ? 'broad_family_no_exclusive_owner'
        : 'grouped_showcase_no_exclusive_owner';
    }
  } else if (exclusiveOwners.length === 1) {
    keepKeys.add(exclusiveOwners[0].key);
    cardinality = 'one';
    capReason = 'exclusive_title_owner';
  } else if (ranked.length >= 2) {
    keepKeys.add(ranked[0].key);
    cardinality = 'one';
    capReason = 'top_centrality_single_fallback';
    resolverNeeded =
      ranked[1].stats?.direct_subject_strength >=
      ranked[0].stats?.direct_subject_strength - 1;
  } else if (ranked.length === 1) {
    keepKeys.add(ranked[0].key);
    cardinality = 'one';
    capReason = 'single_ranked_fallback';
  } else {
    cardinality = 'zero';
    capReason = 'no_ranked_heroes';
  }
  for (const r of ranked) {
    if (keepKeys.has(r.key)) continue;
    const reasonPrimary =
      broadFamily || groupedShowcaseLike || ragHeroes.length >= 3
        ? 'storage:context_only:broad_bundle_true_secondary'
        : 'storage:context_only:primary_centrality_insufficient';
    applyCentralityDemotionContractRewrite(r.cand, reasonPrimary, 'hero_primary_cardinality_cap');
    demotions.push({
      key: r.key,
      canonical_slug: r.cand?.canonical_slug || null,
      category: r.cand?.category || null,
      from_intent: 'RAG_OK',
      to_intent: 'CONTEXT_ONLY',
      reason_primary: reasonPrimary,
      post_shape: 'hero_primary_cardinality_cap',
      hero_primary_cardinality: cardinality,
      hero_primary_cap_reason: capReason,
    });
  }
  signals.hero_primary_cardinality_dbg = cardinality;
  signals.hero_primary_keep_n_dbg = keepKeys.size;
  signals.hero_primary_cap_reason_dbg = capReason;
  signals.multi_hero_resolver_needed_dbg = resolverNeeded === true;
  signals.hero_primary_candidates_dbg = ranked
    .map((r) => ({
      key: r.key,
      label_dbg: r.cand?.label_dbg || null,
      strict_title_primary: r.strictTitlePrimary === true,
      answer_slot_keep: r.answerSlotKeep === true,
      title_mention: r.titleMention === true,
      storage_lock: r.storageLock === true,
      presumptive_primary: r.presumptivePrimary === true,
      direct_subject_strength: r.stats?.direct_subject_strength ?? null,
    }))
    .slice(0, 8);
  return { changed: demotions.length > 0, demotions, info: signals };
}

function applyConservativeRagCentralityDemotions(j, selected) {
  const rag = safeArray(selected).filter(
    (c) => toStr(c?.storage_intent).toUpperCase() === 'RAG_OK'
  );
  const info = detectRagCentralityPostShape(j, selected);
  const demotions = [];
  const titleNorm = normalizeFreeText(getTitleText(j));
  const strictReviewOrOpinionOverride =
    info.policy_review_or_opinion_like === true ||
    /trying out|as a .* player|review|impressions|thoughts on|what do you think|anyone else|is it just me|discussion/.test(
      titleNorm
    );
  if (rag.length === 0) {
    return {
      post_shape: info.shape,
      demotions_n: 0,
      demotions_samples: [],
      changed: false,
      debug_summary: buildRagCentralityDebugSummary(j, info, []),
    };
  }
  const canDemoteForBroadShape =
    info.shape === 'broad_bundle_or_gallery' ||
    info.shape === 'general_topic_with_entity_examples';
  if (canDemoteForBroadShape) {
    const reasonPrimary =
      info.shape === 'broad_bundle_or_gallery'
        ? 'storage:context_only:broad_bundle_true_secondary'
        : 'storage:context_only:general_topic_example_not_primary';
    for (const c of rag) {
      const strictTitlePrimaryKeep = candidateHasStrictProtectedTitlePrimary(c, j, info);
      const protectedDirectSubjectKeep = candidateHasProtectedDirectSubjectStorageLock(
        c,
        j,
        info,
        selected
      );
      const answerSlotKeep = candidateEligibleForAnswerSlotSubjectRescue(c, info, titleNorm);
      const reviewSecondaryExample = candidateIsBroadReviewSecondaryExample(c, j, info);
      const explicitKeep =
        info.explicit_comparison_like === true ||
        strictTitlePrimaryKeep ||
        (!strictReviewOrOpinionOverride &&
          (protectedDirectSubjectKeep || answerSlotKeep));
      const hardReviewOpinionBlock =
        reviewSecondaryExample ||
        candidateMustDemoteBroadReviewAtStorage(c, j, info, selected) ||
        (strictReviewOrOpinionOverride &&
          !strictTitlePrimaryKeep &&
          !info.explicit_comparison_like);
      if (explicitKeep && !hardReviewOpinionBlock) continue;
      applyCentralityDemotionContractRewrite(c, reasonPrimary, info.shape);
      demotions.push({
        key: stableKey(c),
        canonical_slug: c?.canonical_slug || null,
        category: c?.category || null,
        from_intent: 'RAG_OK',
        to_intent: 'CONTEXT_ONLY',
        reason_primary: reasonPrimary,
        post_shape: info.shape,
      });
    }
  } else if (rag.length === 1) {
    const only = rag[0];
    const onlyStats = computeRagCentralityStats(only);
    const titleAnchoredSibling = safeArray(selected)
      .filter((c) => c !== only && require('./storageIntent').isProtectedCategory(c?.category))
      .map((c) => ({ cand: c, stats: computeRagCentralityStats(c) }))
      .sort((a, b) => {
        const ds = (b.stats.title_ev_n || 0) - (a.stats.title_ev_n || 0);
        if (ds !== 0) return ds;
        const de =
          (b.stats.direct_subject_strength || 0) -
          (a.stats.direct_subject_strength || 0);
        if (de !== 0) return de;
        return (b.cand?.det_score ?? 0) - (a.cand?.det_score ?? 0);
      })[0] || null;
    const sideSpeculationDemote =
      onlyStats.title_ev_n === 0 &&
      onlyStats.op_ev_n >= 1 &&
      onlyStats.comment_ev_n >= 1 &&
      !!titleAnchoredSibling &&
      titleAnchoredSibling.stats.title_ev_n >= 1 &&
      titleAnchoredSibling.stats.direct_subject_strength >=
        onlyStats.direct_subject_strength;
    if (sideSpeculationDemote) {
      applyCentralityDemotionContractRewrite(
        only,
        'storage:context_only:side_speculation_not_primary',
        'side_speculation_not_primary'
      );
      demotions.push({
        key: stableKey(only),
        canonical_slug: only?.canonical_slug || null,
        category: only?.category || null,
        from_intent: 'RAG_OK',
        to_intent: 'CONTEXT_ONLY',
        reason_primary: 'storage:context_only:side_speculation_not_primary',
        post_shape: 'side_speculation_not_primary',
        competing_title_anchor: titleAnchoredSibling?.cand?.canonical_slug || null,
      });
      info.shape = 'side_speculation_not_primary';
    }
  }
  const heroPrimaryCapResult = applyHeroPrimaryCardinalityCap(j, selected, info, demotions);
  info.hero_primary_cardinality_dbg =
    heroPrimaryCapResult.info?.hero_primary_cardinality_dbg || info.hero_primary_cardinality_dbg || null;
  info.hero_primary_keep_n_dbg =
    heroPrimaryCapResult.info?.hero_primary_keep_n_dbg ?? info.hero_primary_keep_n_dbg ?? null;
  info.hero_primary_cap_reason_dbg =
    heroPrimaryCapResult.info?.hero_primary_cap_reason_dbg || info.hero_primary_cap_reason_dbg || null;
  info.multi_hero_resolver_needed_dbg =
    heroPrimaryCapResult.info?.multi_hero_resolver_needed_dbg === true;
  info.hero_primary_candidates_dbg = safeArray(
    heroPrimaryCapResult.info?.hero_primary_candidates_dbg || info.hero_primary_candidates_dbg
  ).slice(0, 8);
  return {
    post_shape: info.shape,
    demotions_n: demotions.length,
    demotions_samples: demotions.slice(0, 12),
    changed: demotions.length > 0,
    debug_summary: buildRagCentralityDebugSummary(j, info, demotions),
  };
}

module.exports = {
  applyConservativeRagCentralityDemotions,
  applyCentralityDemotionContractRewrite,
  applyHeroPrimaryCardinalityCap,
};

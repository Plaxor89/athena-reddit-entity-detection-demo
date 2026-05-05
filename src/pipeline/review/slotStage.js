function isObject(x) { return x && typeof x === 'object' && !Array.isArray(x); }
function safeArray(x) { return Array.isArray(x) ? x : []; }
function toStr(v) { return v === null || v === undefined ? '' : String(v); }

function inc(obj, key, by = 1) { obj[key] = (obj[key] || 0) + by; }
function prefixOf(reason) {
  const s = toStr(reason);
  const i = s.indexOf(':');
  return i > 0 ? s.slice(0, i) : 'other';
}

function stableKey(c) {
  return `${toStr(c.category)}||${toStr(c.canonical_slug)}||${toStr(c.dictionary_entity_type)}`;
}

function normSourceType(st) { return toStr(st).trim().toLowerCase(); }

function hasTitleOrOpEvidence(evList) {
  for (const ev of safeArray(evList)) {
    const st = normSourceType(ev.source_type);
    if (st === 'title' || st === 'op') return true;
  }
  return false;
}

function hasCommentEvidence(evList) {
  for (const ev of safeArray(evList)) {
    if (normSourceType(ev.source_type) === 'comment') return true;
  }
  return false;
}

function anyHighRisk(cands) {
  return safeArray(cands).some(c => toStr(c.promotion_risk).toUpperCase() === 'HIGH');
}

function groupByCategory(arr) {
  const out = {};
  for (const c of safeArray(arr)) {
    const cat = toStr(c.category) || 'unknown';
    if (!out[cat]) out[cat] = [];
    out[cat].push(c);
  }
  return out;
}

function sortByScoreDescThenKey(arr) {
  return safeArray(arr).slice().sort((a, b) => {
    const ds = (b.det_score ?? 0) - (a.det_score ?? 0);
    if (ds !== 0) return ds;
    const ak = stableKey(a);
    const bk = stableKey(b);
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
}

function getEvidenceSummary(c) {
  return isObject(c?.evidence_summary) ? c.evidence_summary : null;
}

function getEquivalence(c) {
  const es = getEvidenceSummary(c);
  if (es && isObject(es.equivalence)) return es.equivalence;
  return isObject(c?.equivalence) ? c.equivalence : null;
}

function equivalenceKind(c) {
  const eq = getEquivalence(c);
  const s = toStr(eq?.kind).toUpperCase();
  if (s === 'NORM_EQ' || s === 'EDITDIST_EQ' || s === 'DISAMBIGUATOR_EQ') return s;
  return null;
}

function getIntentEvidence(c) {
  const es = getEvidenceSummary(c);
  if (es && isObject(es.intent_evidence)) return es.intent_evidence;
  return isObject(c?.intent_evidence) ? c.intent_evidence : null;
}

function getOwnerEvidence(c) {
  const es = getEvidenceSummary(c);
  if (es && isObject(es.owner_evidence)) return es.owner_evidence;
  return isObject(c?.owner_evidence) ? c.owner_evidence : null;
}

function hasIntentAnchorHit(c) {
  const ie = getIntentEvidence(c);
  return safeArray(ie?.intent_anchor_hits).length > 0;
}

function hasIntentNegAnchorHit(c) {
  const ie = getIntentEvidence(c);
  return safeArray(ie?.neg_anchor_hits).length > 0;
}

function ownerHasSameSourceUnlock(c) {
  const oe = getOwnerEvidence(c);
  return oe?.owner_same_source_unlock === true;
}

function ownerHasSecondContext(c) {
  const oe = getOwnerEvidence(c);
  return oe?.owner_second_context === true;
}

function ownerHasSameSourceExactCanonical(c) {
  const oe = getOwnerEvidence(c);
  return oe?.owner_same_source_exact_canonical === true;
}

function ownerHasTitleOpSupport(c) {
  const oe = getOwnerEvidence(c);
  return oe?.owner_title_op_support === true;
}

function ownerHasExactTitleOpSupport(c) {
  const oe = getOwnerEvidence(c);
  return oe?.owner_exact_title_op_support === true;
}

function ownerCompetingHeroContext(c) {
  const oe = getOwnerEvidence(c);
  return oe?.owner_competing_hero_context === true;
}

function ownerContextStrength(c) {
  const oe = getOwnerEvidence(c);
  return toStr(oe?.owner_context_strength).toUpperCase() || null;
}

function ownerRequiredLevel(c) {
  const oe = getOwnerEvidence(c);
  return toStr(oe?.owner_required_level).toUpperCase() || null;
}


function ownerSecondContextPresent(c) {
  const oe = getOwnerEvidence(c);
  return oe?.owner_second_context_present === true || oe?.owner_second_context === true;
}

function ownerSecondContextReasons(c) {
  const oe = getOwnerEvidence(c);
  return safeArray(oe?.owner_second_context_reasons);
}

function ownerSameHeroContextUnlock(c) {
  const oe = getOwnerEvidence(c);
  return oe?.same_hero_context_unlock === true;
}

function ownerHeroTitlePrimary(c) {
  const oe = getOwnerEvidence(c);
  return oe?.owner_hero_title_primary === true;
}

function competingHeroTitlePrimary(c) {
  const oe = getOwnerEvidence(c);
  return oe?.competing_hero_title_primary === true;
}

function ownerReadyTier2(c) {
  const oe = getOwnerEvidence(c);
  return oe?.owner_context_ready_tier2 === true;
}

function ownerReadyTier3(c) {
  const oe = getOwnerEvidence(c);
  return oe?.owner_context_ready_tier3 === true;
}

function hasProtectedContext(c) {
  if (isObject(c?.protected_context)) {
    const pc = c.protected_context;
    return pc.protected_context === true || pc.is_protected === true || pc.pass_protected_context === true;
  }
  const es = getEvidenceSummary(c);
  if (isObject(es?.protected_context)) {
    const pc = es.protected_context;
    return pc.protected_context === true || pc.is_protected === true || pc.pass_protected_context === true;
  }
  return false;
}

function hasStorageReason(c, prefix) {
  return safeArray(c?.storage_reasons).some(r => toStr(r).startsWith(prefix));
}

function hasAnyStorageReasonPrefix(c, prefixes) {
  const reasons = safeArray(c?.storage_reasons).map(toStr);
  return safeArray(prefixes).some(p => reasons.some(r => r.startsWith(toStr(p))));
}

function isConceptCategory(catRaw) {
  const c = toStr(catRaw).toLowerCase();
  return c === 'rank' || c === 'platform' || c === 'queue' || c === 'mode' || c === 'role';
}

function ownerStatus(c) {
  const oe = getOwnerEvidence(c);
  const s = toStr(oe?.owner_status).toUpperCase();
  if (s === 'KNOWN' || s === 'CONFLICT' || s === 'UNKNOWN') return s;
  return null;
}

function buildCandidateForReview(c, review_source, review_reason) {
  const oe = getOwnerEvidence(c);
  const eq = getEquivalence(c);
  const ie = getIntentEvidence(c);
  return {
    category: toStr(c.category),
    canonical_slug: toStr(c.canonical_slug),
    dictionary_entity_type: toStr(c.dictionary_entity_type),
    hero_slug: c.hero_slug || null,

    det_score: Number.isFinite(c.det_score) ? c.det_score : null,
    det_lane: toStr(c.det_lane) || null,
    det_max_lane: toStr(c.det_max_lane) || null,
    promotion_risk: c.promotion_risk || null,

    det_safe_resolved: c.det_safe_resolved === true,
    det_safe_blocks_review: c.det_safe_blocks_review === true,
    det_safe_tags: safeArray(c.det_safe_tags),

    det_match_kind: toStr(c.det_match_kind) || null,
    det_alias_only_signal: c.det_alias_only_signal === true,
    det_fuzzy_near_exact: c.det_fuzzy_near_exact === true,

    // lens flags for gating
    det_topicality_strong: c.det_topicality_strong === true,
    det_comment_exact_relevance_bucket: toStr(c.det_comment_exact_relevance_bucket || ''),
    det_off_domain_collision: c.det_off_domain_collision === true,

    // v2.0: equivalence + concept-intent passthrough
    equivalence: eq ? {
      kind: toStr(eq.kind || ''),
      reasons: safeArray(eq.reasons),
    } : null,
    intent_evidence: ie ? {
      requires_ow_context: ie.requires_ow_context === true,
      has_ow_context: ie.has_ow_context === true,
      intent_anchor_hits: safeArray(ie.intent_anchor_hits),
      neg_anchor_hits: safeArray(ie.neg_anchor_hits),
      reasons: safeArray(ie.reasons),
    } : null,

    // v2.0: deeper owner lens passthrough
    owner_evidence: oe ? {
      owner_status: toStr(oe.owner_status || ''),
      owner_hero_unique_n: Number.isFinite(oe.owner_hero_unique_n) ? oe.owner_hero_unique_n : null,
      owner_hero_slugs: safeArray(oe.owner_hero_slugs),
      owner_reasons: safeArray(oe.owner_reasons),
      owner_same_source_unlock: oe.owner_same_source_unlock === true,
      owner_same_source_types: safeArray(oe.owner_same_source_types),
      owner_second_context: oe.owner_second_context === true,
      owner_same_source_exact_canonical: oe.owner_same_source_exact_canonical === true,
      owner_title_op_support: oe.owner_title_op_support === true,
      owner_exact_title_op_support: oe.owner_exact_title_op_support === true,
      owner_competing_hero_context: oe.owner_competing_hero_context === true,
      owner_context_strength: toStr(oe.owner_context_strength || ''),
      owner_required_level: toStr(oe.owner_required_level || ''),
      owner_signal_count: Number.isFinite(oe.owner_signal_count) ? oe.owner_signal_count : null,
      owner_second_context_present: oe.owner_second_context_present === true || oe.owner_second_context === true,
      owner_second_context_reasons: safeArray(oe.owner_second_context_reasons),
      same_hero_context_unlock: oe.same_hero_context_unlock === true,
      owner_hero_title_primary: oe.owner_hero_title_primary === true,
      competing_hero_title_primary: oe.competing_hero_title_primary === true,
      owner_context_ready_tier2: oe.owner_context_ready_tier2 === true,
      owner_context_ready_tier3: oe.owner_context_ready_tier3 === true,
    } : null,

    protected_context: isObject(c.protected_context) ? c.protected_context : (isObject(c?.evidence_summary?.protected_context) ? c.evidence_summary.protected_context : null),
    exact_context_signals: isObject(c.exact_context_signals) ? c.exact_context_signals : (isObject(c?.evidence_summary?.exact_context_signals) ? c.evidence_summary.exact_context_signals : null),

    storage_intent: toStr(c.storage_intent) || null,
    storage_reasons: safeArray(c.storage_reasons),
    storage_blockers: safeArray(c.storage_blockers),
    storage_reason_primary: toStr(c.storage_reason_primary) || null,
    storage_reason_family: toStr(c.storage_reason_family) || null,
    storage_reason_trace: safeArray(c.storage_reason_trace),

    selection_reason_primary: toStr(c.selection_reason_primary) || null,
    suppression_reason_primary: toStr(c.suppression_reason_primary) || null,
    selection_competition_reason: toStr(c.selection_competition_reason) || null,
    drop_reason_primary: toStr(c.drop_reason_primary) || null,
    drop_reason_family: toStr(c.drop_reason_family) || null,
    drop_explanation_trace: safeArray(c.drop_explanation_trace),

    same_canonical_selected_elsewhere: c.same_canonical_selected_elsewhere === true,
    same_canonical_storage_summary: isObject(c.same_canonical_storage_summary) ? c.same_canonical_storage_summary : null,

    origins: safeArray(c.origins),
    alias_texts: safeArray(c.alias_texts),
    alias_norms: safeArray(c.alias_norms),

    pack_meta: isObject(c.pack_meta) ? c.pack_meta : null,

    evidence: safeArray(c.evidence),
    evidence_preview: safeArray(c.evidence_preview),

    review_meta: {
      review_source,
      review_reason,
      reason_codes: safeArray(c?.review_meta?.reason_codes),
    },
  };
}

function hasCollisionForCandidate(collisions, cand) {
  const et = toStr(cand.dictionary_entity_type);
  const aliasNorms = safeArray(cand.alias_norms).map(toStr).filter(Boolean);
  if (!aliasNorms.length) return false;

  for (const an of aliasNorms) {
    if (et && isObject(collisions[et]) && collisions[et][an]) return true;
    if (collisions[an]) return true;
  }
  return false;
}

function pushBounded(arr, obj, cap) {
  if (arr.length < cap) arr.push(obj);
}

function isOwnerScopeCategory(catRaw) {
  const c = toStr(catRaw).toLowerCase();
  return (
    c === 'ability' ||
    c === 'perk' ||
    c === 'role' ||
    c === 'mode' ||
    c === 'queue' ||
    c === 'rank' ||
    c === 'platform'
  );
}

function packEscaped(c) {
  const pm = isObject(c?.pack_meta) ? c.pack_meta : null;
  return pm?.pack_risky_alias_escaped === true;
}

function commentRelBucket(c) {
  const es = getEvidenceSummary(c);
  const b = toStr(es?.comment_exact_relevance_bucket || c?.det_comment_exact_relevance_bucket || '').toUpperCase();
  if (b === 'HIGH' || b === 'MED' || b === 'LOW') return b;
  return null;
}

function topicalityStrong(c) {
  if (c?.det_topicality_strong === true) return true;
  const es = getEvidenceSummary(c);
  if (typeof es?.topicality_strong === 'boolean') return es.topicality_strong;
  return false;
}

const MAX_TRACE = 20;

/**
 * @param {object} j - scoreSuppressLane output item
 * @param {object} collisionsRegistry - alias collision registry from policy bundle
 * @param {{ perCatCap: number, totalCap: number, marginMax: number }} constantsIn
 * @returns {object} patch fields to merge onto j (no spread of j)
 */
function buildSlotStagePatch(j, collisionsRegistry, constantsIn) {
  j = isObject(j) ? j : {};

  const perCatCap = constantsIn.perCatCap;
  const totalCap = constantsIn.totalCap;
  const marginMax = constantsIn.marginMax;
  const collisions = collisionsRegistry;

  const detSelected = sortByScoreDescThenKey(safeArray(j.det_selected_pre));
  const detSuppressedTop = safeArray(j.det_suppressed_top_pre);
  const byCat = groupByCategory(detSelected);

  const stage = [];
  const stageReasons = {};
  const stageReasonPrefixes = {};
  const stageReasonKeys = [];

  const slotTrace = {
    constants: { per_category: perCatCap, total_per_post: totalCap, ambiguity_margin_max: marginMax },
    categories: {},
    dropped_by_total_cap: 0,
  };

  const tier3Counts = isObject(j.tier3_binding_counts) ? j.tier3_binding_counts : {};
  const tier3MatchedPairsN = Number(tier3Counts.matched_pairs_n || 0);
  const tier3SuppressSet = new Set(safeArray(j.tier3_binding_suppress_keys).map(toStr));
  const tier3BoostSet = new Set(safeArray(j.tier3_binding_boost_keys).map(toStr));

  const highRiskSelectedPresent = anyHighRisk(detSelected);
  const highRiskSuppressedPresent = anyHighRisk(detSuppressedTop);

  let heroCloseTop2SkippedMultiMentionN = 0;
  const heroCloseTop2SkippedSamples = [];

  let collisionSlot2AddedN = 0;
  const collisionSlot2Samples = [];

  let safeBypassBlockedSlot2N = 0;
  const safeBypassBlockedSlot2Samples = [];

  let tier3BindingSlot2SkippedN = 0;
  const tier3BindingSlot2SkippedSamples = [];

  let fuzzyNearExactSlot2SkippedN = 0;
  const fuzzyNearExactSlot2SkippedSamples = [];

  let ragOkSlot2SkippedN = 0;
  const ragOkSlot2SkippedSamples = [];

  let aliasOnlySlot2SkippedN = 0;
  const aliasOnlySlot2SkippedSamples = [];

  let commentOnlyPressureSlot2SkippedLowRelN = 0;
  const commentOnlyPressureSkippedLowRelSamples = [];
  let packEscapedSlot2AvoidedN = 0;
  const packEscapedSlot2AvoidedSamples = [];

  // owner/equivalence/intent telemetry
  let owner_evidence_conflict_n = 0;
  let owner_evidence_unknown_n = 0;
  let owner_evidence_unknown_without_unlock_n = 0;

  let equivalenceKindCounts = {};
  let conceptIntentAnchorPresentN = 0;
  let conceptIntentNegAnchorN = 0;
  let conceptIntentNeedsContextN = 0;

  let tier2ContextGapN = 0;
  let tier3ContextGapN = 0;
  let ownerSecondContextGapN = 0;
  let ownerWeakContextN = 0;
  let ownerCompetingHeroPresentN = 0;
  let ownerTitlePrimaryCompetingTitlePrimaryN = 0;
  let protectedContextPresentN = 0;

  let ownerScopeConflictN = 0;
  const ownerScopeConflictSamples = [];

  let exactContextSafeBypassN = 0;
  const exactContextSafeSamples = [];

  for (const cat of Object.keys(byCat).sort()) {
    const sorted = sortByScoreDescThenKey(byCat[cat]);
    const top1 = sorted[0] || null;
    const top2 = sorted[1] || null;
    if (!top1) continue;

    const top1Key = stableKey(top1);
    const top2Key = top2 ? stableKey(top2) : null;

    const r1 = `slot:${cat}:slot1_top`;
    stage.push(buildCandidateForReview(top1, 'selected', r1));
    inc(stageReasons, r1);
    inc(stageReasonPrefixes, prefixOf(r1));

    slotTrace.categories[cat] = {
      slot1: top1Key,
      slot2: null,
      slot2_included: false,
      slot2_reason: null,
      top2_margin: null,
      slot2_skipped_reason: null,
      slot2_skip_reason_codes: [],
    };

    const safeBypassBlocks = top1.det_safe_blocks_review === true;
    if (safeBypassBlocks && safeArray(top1.det_safe_tags).some((t) => toStr(t).startsWith('safe_bypass:rank_') || toStr(t).startsWith('safe_bypass:platform_') || toStr(t).startsWith('safe_bypass:queue_') || toStr(t).startsWith('safe_bypass:mode_') || toStr(t).startsWith('safe_bypass:role_'))) {
      exactContextSafeBypassN += 1;
      pushBounded(exactContextSafeSamples, {
        category: top1.category,
        canonical_slug: top1.canonical_slug,
        det_safe_tags: safeArray(top1.det_safe_tags),
        exact_context_signals: isObject(top1.exact_context_signals) ? {
          light_context: top1.exact_context_signals.light_context === true,
          strong_context: top1.exact_context_signals.strong_context === true,
          collision_band: top1.exact_context_signals.collision_band || null,
          reasons: safeArray(top1.exact_context_signals.reasons).slice(0, 4),
        } : null,
      }, 12);
    }
    if (safeBypassBlocks) {
      slotTrace.categories[cat].slot2_skipped_reason = 'skip:safe_bypass_blocks_review';
      slotTrace.categories[cat].slot2_skip_reason_codes.push('skip:safe_bypass_blocks_review');
      safeBypassBlockedSlot2N += 1;
      if (safeBypassBlockedSlot2Samples.length < 10 && top2) {
        safeBypassBlockedSlot2Samples.push({ category: cat, winner: top1Key, runner_up: top2Key, tags: safeArray(top1.det_safe_tags) });
      }
      continue;
    }

    const top1RagOk = toStr(top1.storage_intent).toUpperCase() === 'RAG_OK';
    const top1TopoStrong = topicalityStrong(top1);

    let includeSlot2 = false;
    let slot2Reason = null;
    let margin = null;

    if (top2) {
      margin = (top1.det_score ?? 0) - (top2.det_score ?? 0);

      const top1HasTO = hasTitleOrOpEvidence(safeArray(top1.evidence));
      const top2HasTO = hasTitleOrOpEvidence(safeArray(top2.evidence));

      const tier3ResolvesThisPair =
        (tier3MatchedPairsN > 0) &&
        ((top2Key && tier3SuppressSet.has(top2Key)) || (top1Key && tier3BoostSet.has(top1Key)));

      const top2PackEscaped = packEscaped(top2);

      if (margin <= marginMax) {
        includeSlot2 = true;
        slot2Reason = `slot:${cat}:slot2_close_top2`;

        if (tier3ResolvesThisPair) {
          includeSlot2 = false;
          slotTrace.categories[cat].slot2_skipped_reason = 'skip:tier3_binding_resolved';
          slotTrace.categories[cat].slot2_skip_reason_codes.push('skip:tier3_binding_resolved');
          tier3BindingSlot2SkippedN += 1;
          pushBounded(tier3BindingSlot2SkippedSamples, { category: cat, margin, top1: top1Key, top2: top2Key, top2_suppressed: top2Key ? tier3SuppressSet.has(top2Key) : false, top1_boosted: tier3BoostSet.has(top1Key) }, 10);
        }

        const catLower = toStr(cat).toLowerCase();
        if (includeSlot2 && catLower === 'hero') {
          if (top1HasTO && top2HasTO) {
            includeSlot2 = false;
            slotTrace.categories[cat].slot2_skipped_reason = 'skip:hero_close_top2_multi_mention';
            slotTrace.categories[cat].slot2_skip_reason_codes.push('skip:hero_close_top2_multi_mention');
            heroCloseTop2SkippedMultiMentionN += 1;
            pushBounded(heroCloseTop2SkippedSamples, { category: cat, margin, a: top1Key, b: top2Key }, 10);
          }
        }

        const top2FuzzyOnly = safeArray(top2.origins).map(toStr).includes('fuzzy') && !safeArray(top2.origins).map(toStr).includes('exact');
        if (includeSlot2 && top2FuzzyOnly && top2.det_fuzzy_near_exact === true && top1HasTO) {
          includeSlot2 = false;
          slotTrace.categories[cat].slot2_skipped_reason = 'skip:fuzzy_near_exact_not_review_worthy';
          slotTrace.categories[cat].slot2_skip_reason_codes.push('skip:fuzzy_near_exact_not_review_worthy');
          fuzzyNearExactSlot2SkippedN += 1;
          pushBounded(fuzzyNearExactSlot2SkippedSamples, { category: cat, margin, top1: top1Key, top2: top2Key, top2_fuzzy_near_exact: true }, 10);
        }

        if (includeSlot2 && top2.det_alias_only_signal === true && top1HasTO) {
          includeSlot2 = false;
          slotTrace.categories[cat].slot2_skipped_reason = 'skip:alias_only_weak';
          slotTrace.categories[cat].slot2_skip_reason_codes.push('skip:alias_only_weak');
          aliasOnlySlot2SkippedN += 1;
          pushBounded(aliasOnlySlot2SkippedSamples, { category: cat, margin, top1: top1Key, top2: top2Key }, 10);
        }

        if (includeSlot2 && top1RagOk && top1TopoStrong) {
          includeSlot2 = false;
          slotTrace.categories[cat].slot2_skipped_reason = 'skip:rag_ok_primary_confident_topicality_strong';
          slotTrace.categories[cat].slot2_skip_reason_codes.push('skip:rag_ok_primary_confident_topicality_strong');
          ragOkSlot2SkippedN += 1;
          pushBounded(ragOkSlot2SkippedSamples, { category: cat, margin, top1: top1Key, top2: top2Key, top1_storage_intent: toStr(top1.storage_intent), top1_topicality_strong: true }, 10);
        }

        if (includeSlot2 && top2PackEscaped) {
          includeSlot2 = false;
          slotTrace.categories[cat].slot2_skipped_reason = 'skip:pack_escape_runner_up_avoided';
          slotTrace.categories[cat].slot2_skip_reason_codes.push('skip:pack_escape_runner_up_avoided');
          packEscapedSlot2AvoidedN += 1;
          pushBounded(packEscapedSlot2AvoidedSamples, { category: cat, margin, top1: top1Key, top2: top2Key }, 10);
        }
      }

      if (!includeSlot2) {
        const catHasHighRisk = sorted.some(x => toStr(x.promotion_risk).toUpperCase() === 'HIGH');
        if (catHasHighRisk) {
          includeSlot2 = true;
          slot2Reason = `slot:${cat}:slot2_high_risk_present`;
        }
      }

      if (!includeSlot2) {
        const catHasCommentOnlyNotLowRel = sorted.some(x => {
          const ev2 = safeArray(x.evidence);
          const hasTO2 = hasTitleOrOpEvidence(ev2);
          const hasC2 = hasCommentEvidence(ev2);
          if (hasTO2 || !hasC2) return false;

          const rel = commentRelBucket(x);
          return rel !== 'LOW';
        });

        if (catHasCommentOnlyNotLowRel) {
          if (!(top1RagOk === true && top1TopoStrong)) {
            includeSlot2 = true;
            slot2Reason = `slot:${cat}:slot2_comment_only_present`;
          } else {
            slotTrace.categories[cat].slot2_skipped_reason = slotTrace.categories[cat].slot2_skipped_reason || 'skip:rag_ok_primary_confident_topicality_strong';
            slotTrace.categories[cat].slot2_skip_reason_codes.push('skip:comment_only_pressure_skipped_due_to_rag_ok_topicality');
            ragOkSlot2SkippedN += 1;
            pushBounded(ragOkSlot2SkippedSamples, { category: cat, top1: top1Key, top2: top2Key, note: 'comment_only_pressure_skipped', top1_topicality_strong: top1TopoStrong }, 10);
          }
        } else {
          const catHasCommentOnly = sorted.some(x => {
            const ev2 = safeArray(x.evidence);
            const hasTO2 = hasTitleOrOpEvidence(ev2);
            const hasC2 = hasCommentEvidence(ev2);
            return !hasTO2 && hasC2;
          });
          if (catHasCommentOnly) {
            commentOnlyPressureSlot2SkippedLowRelN += 1;
            pushBounded(commentOnlyPressureSkippedLowRelSamples, { category: cat, top1: top1Key, top2: top2Key }, 10);
          }
        }
      }

      if (!includeSlot2) {
        const top1Collision = hasCollisionForCandidate(collisions, top1);
        if (top1Collision) {
          includeSlot2 = true;
          slot2Reason = `slot:${cat}:slot2_collision_ambiguous`;
          collisionSlot2AddedN += 1;
          pushBounded(collisionSlot2Samples, { category: cat, a: top1Key, b: top2Key, top1_alias_norms: safeArray(top1.alias_norms).slice(0, 4), top2_alias_norms: safeArray(top2.alias_norms).slice(0, 4) }, 10);
        }
      }

      // v2.0: owner-scope slot2 pressure (conflict strongest; unknown without unlock also route-worthy)
      if (!includeSlot2 && isOwnerScopeCategory(cat)) {
        const ownerConflictPresent = sorted.some(x => ownerStatus(x) === 'CONFLICT');
        const ownerUnknownPresent = sorted.some(x => ownerStatus(x) === 'UNKNOWN');
        const ownerUnknownWithoutUnlockPresent = sorted.some(x =>
          ownerStatus(x) === 'UNKNOWN' &&
          !ownerHasSameSourceUnlock(x) &&
          !ownerHasSecondContext(x)
        );
        const ownerTitleOpPresent = sorted.some(x => hasTitleOrOpEvidence(safeArray(x.evidence)));

        if (ownerConflictPresent) owner_evidence_conflict_n += 1;
        if (ownerUnknownPresent) owner_evidence_unknown_n += 1;
        if (ownerUnknownWithoutUnlockPresent) owner_evidence_unknown_without_unlock_n += 1;

        const ownerCompetingPresent = sorted.some(x => ownerCompetingHeroContext(x));
        const tier3GapPresent = sorted.some(x => ownerRequiredLevel(x) === 'TIER3' && !ownerReadyTier3(x));
        const tier2GapPresent = sorted.some(x => ownerRequiredLevel(x) === 'TIER2' && !ownerReadyTier2(x));
        const secondContextGapPresent = sorted.some(x => ownerRequiredLevel(x) !== 'NONE' && !ownerSecondContextPresent(x) && !ownerSameHeroContextUnlock(x));
        const ownerTitlePrimaryConflictPresent = sorted.some(x => ownerHeroTitlePrimary(x) && competingHeroTitlePrimary(x));
        const weakOwnerPresent = sorted.some(x => {
          const st = ownerContextStrength(x);
          return (st === 'WEAK' || st === 'NONE' || st === '') && !ownerHasSameSourceUnlock(x) && !ownerHasExactTitleOpSupport(x);
        });

        if (ownerConflictPresent) {
          includeSlot2 = true;
          slot2Reason = `slot:${cat}:slot2_owner_scope_conflict`;
        } else if (ownerTitlePrimaryConflictPresent) {
          includeSlot2 = true;
          slot2Reason = `slot:${cat}:slot2_owner_title_primary_competing_hero_title_primary`;
        } else if (ownerCompetingPresent) {
          includeSlot2 = true;
          slot2Reason = `slot:${cat}:slot2_owner_competing_hero`;
        } else if (tier3GapPresent) {
          includeSlot2 = true;
          slot2Reason = `slot:${cat}:slot2_tier3_missing_context`;
        } else if (tier2GapPresent) {
          includeSlot2 = true;
          slot2Reason = `slot:${cat}:slot2_tier2_missing_context`;
        } else if (secondContextGapPresent && !ownerTitleOpPresent) {
          includeSlot2 = true;
          slot2Reason = `slot:${cat}:slot2_owner_second_context_gap`;
        } else if (ownerUnknownWithoutUnlockPresent && !ownerTitleOpPresent) {
          includeSlot2 = true;
          slot2Reason = `slot:${cat}:slot2_owner_scope_unknown`;
        } else if (weakOwnerPresent && !ownerTitleOpPresent) {
          includeSlot2 = true;
          slot2Reason = `slot:${cat}:slot2_owner_scope_weak_context`;
        }

        if (secondContextGapPresent) ownerSecondContextGapN += 1;
        if (ownerTitlePrimaryConflictPresent) ownerTitlePrimaryCompetingTitlePrimaryN += 1;
      }
    }

    if (includeSlot2 && top2) {
      stage.push(buildCandidateForReview(top2, 'selected', slot2Reason));
      inc(stageReasons, slot2Reason);
      inc(stageReasonPrefixes, prefixOf(slot2Reason));

      slotTrace.categories[cat].slot2 = stableKey(top2);
      slotTrace.categories[cat].slot2_included = true;
      slotTrace.categories[cat].slot2_reason = slot2Reason;
      slotTrace.categories[cat].top2_margin = margin;
    } else if (top2) {
      slotTrace.categories[cat].top2_margin = margin;
    }
  }

  // Sort + cap stage list
  stage.sort((a, b) => {
    const ds = (b.det_score ?? 0) - (a.det_score ?? 0);
    if (ds !== 0) return ds;
    const ak = `${a.category}||${a.canonical_slug}||${a.dictionary_entity_type}`;
    const bk = `${b.category}||${b.canonical_slug}||${b.dictionary_entity_type}`;
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });

  const stageCapped = stage.slice(0, totalCap);
  slotTrace.dropped_by_total_cap = Math.max(0, stage.length - stageCapped.length);

  // Per-category cap
  const final = [];
  const catCounts = {};
  for (const c of stageCapped) {
    const cat = toStr(c.category) || 'unknown';
    catCounts[cat] = catCounts[cat] || 0;
    if (catCounts[cat] >= perCatCap) continue;
    catCounts[cat] += 1;
    final.push(c);
  }

  for (const k of Object.keys(stageReasons).sort()) {
    if (stageReasonKeys.length >= 40) break;
    stageReasonKeys.push(k);
  }

  const needsFlagged = final.length > 0;

  // close_top2 extraction
  const closeTop2Samples = [];
  let closeTop2Ambiguity = false;
  for (const cat of Object.keys(slotTrace.categories)) {
    const rec = slotTrace.categories[cat];
    if (rec.slot2_included && toStr(rec.slot2_reason).includes('close_top2')) {
      closeTop2Ambiguity = true;
      closeTop2Samples.push({ category: cat, margin: rec.top2_margin, a: rec.slot1, b: rec.slot2 });
    }
  }

  // aggregate shortlist facts + owner scope conflict
  let preCommentOnlyN = 0;
  let preHasTitleOpN = 0;

  let fuzzyInShortlistN = 0;
  let collisionHitsN = 0;
  let fuzzyNearExactInShortlistN = 0;
  const tier3BindingPresentInPost = (Number(tier3Counts.matched_pairs_n || 0) > 0);

  const heroSlugSet = new Set();
  let ownerScopeCandidateN = 0;
  let ownerScopeCandidateHasTitleOpN = 0;

  // NEW v1.9: owner_evidence aggregation in final shortlist
  let ownerScopeConflictByLens = false;
  let ownerScopeUnknownByLens = false;

  const paritySamples = [];

  for (const c of final) {
    const ev = safeArray(c.evidence);
    const hasTO = hasTitleOrOpEvidence(ev);
    const hasC = hasCommentEvidence(ev);
    if (!hasTO && hasC) preCommentOnlyN++;
    if (hasTO) preHasTitleOpN++;

    const origins = safeArray(c.origins).map(toStr);
    if (origins.includes('fuzzy')) fuzzyInShortlistN++;
    if (c.det_fuzzy_near_exact === true) fuzzyNearExactInShortlistN++;

    const eqKind = equivalenceKind(c);
    if (eqKind) inc(equivalenceKindCounts, eqKind);

    if (isConceptCategory(c.category)) {
      const ie = getIntentEvidence(c);
      if (safeArray(ie?.intent_anchor_hits).length > 0) conceptIntentAnchorPresentN += 1;
      if (safeArray(ie?.neg_anchor_hits).length > 0) conceptIntentNegAnchorN += 1;
      if (ie?.requires_ow_context === true) conceptIntentNeedsContextN += 1;
    }

    const hasCollision = hasCollisionForCandidate(collisions, c);
    if (hasCollision) collisionHitsN++;

    if (toStr(c.category).toLowerCase() === 'hero') {
      const slug = toStr(c.canonical_slug);
      if (slug) heroSlugSet.add(slug);
    }

    if (isOwnerScopeCategory(c.category)) {
      ownerScopeCandidateN += 1;
      if (hasTO) ownerScopeCandidateHasTitleOpN += 1;

      const st = ownerStatus(c);
      if (st === 'CONFLICT') ownerScopeConflictByLens = true;
      if (st === 'UNKNOWN') {
        ownerScopeUnknownByLens = true;
        if (!ownerHasSameSourceUnlock(c) && !ownerHasSecondContext(c)) {
          owner_evidence_unknown_without_unlock_n += 1;
        }
      }

      if (ownerCompetingHeroContext(c)) ownerCompetingHeroPresentN += 1;
      const reqLevel = ownerRequiredLevel(c);
      if (reqLevel === 'TIER3' && !ownerReadyTier3(c)) tier3ContextGapN += 1;
      if (reqLevel === 'TIER2' && !ownerReadyTier2(c)) tier2ContextGapN += 1;
      const stg = ownerContextStrength(c);
      if ((stg === 'WEAK' || stg === 'NONE' || stg === '') && !ownerHasSameSourceUnlock(c) && !ownerHasExactTitleOpSupport(c)) ownerWeakContextN += 1;
    }

    if (hasProtectedContext(c)) protectedContextPresentN += 1;

    const hasNewDetGuard =
      hasAnyStorageReasonPrefix(c, [
        'storage:block_equivalence_failed',
        'storage:block_missing_intent_anchor',
        'storage:block_concept_neg_anchor',
        'storage:block_missing_owner_scope',
        'storage:block_owner_scope_conflict',
      ]);

    if (paritySamples.length < 12 && (origins.includes('fuzzy') || hasCollision || c.det_fuzzy_near_exact === true || hasNewDetGuard)) {
      paritySamples.push({
        key: `${toStr(c.category)}||${toStr(c.canonical_slug)}||${toStr(c.dictionary_entity_type)}`,
        origins,
        collision: hasCollision,
        fuzzy_near_exact: c.det_fuzzy_near_exact === true,
        equivalence_kind: eqKind,
        intent_anchor_hits_n: safeArray(getIntentEvidence(c)?.intent_anchor_hits).length,
        neg_anchor_hits_n: safeArray(getIntentEvidence(c)?.neg_anchor_hits).length,
        owner_status: ownerStatus(c),
        owner_same_source_unlock: ownerHasSameSourceUnlock(c),
        owner_second_context: ownerHasSecondContext(c),
        storage_reasons: safeArray(c.storage_reasons).slice(0, 6),
        alias_norms: safeArray(c.alias_norms).slice(0, 4),
      });
    }
  }

  const heroUniqueN = heroSlugSet.size;

  // v1.9: owner conflict uses lens when available; fallback to heuristic otherwise
  const hasAnyOwnerLens = final.some(c => isObject(getOwnerEvidence(c)));

  let ownerScopeConflict = false;
  let ownerScopeConflictReason = null;

  if (hasAnyOwnerLens) {
    // Strongest: explicit CONFLICT
    if (ownerScopeConflictByLens && ownerScopeCandidateHasTitleOpN === 0) {
      ownerScopeConflict = true;
      ownerScopeConflictReason = 'owner_conflict:lens_conflict_no_titleop';
    } else if (ownerScopeUnknownByLens && heroUniqueN >= 2 && ownerScopeCandidateHasTitleOpN === 0) {
      ownerScopeConflict = true;
      ownerScopeConflictReason = 'owner_conflict:lens_unknown_multi_hero_no_titleop';
    }
  } else {
    // Fallback heuristic (v1.8)
    ownerScopeConflict =
      (heroUniqueN >= 2) &&
      (ownerScopeCandidateN > 0) &&
      (ownerScopeCandidateHasTitleOpN === 0);
    ownerScopeConflictReason = ownerScopeConflict ? 'owner_conflict:heuristic_multi_hero_owner_scope_no_titleop' : null;
  }

  if (ownerScopeConflict) {
    ownerScopeConflictN += 1;
    pushBounded(ownerScopeConflictSamples, {
      hero_unique_n: heroUniqueN,
      owner_scope_candidate_n: ownerScopeCandidateN,
      owner_scope_candidate_has_title_op_n: ownerScopeCandidateHasTitleOpN,
      owner_conflict_reason: ownerScopeConflictReason,
      owner_evidence_conflict_n,
      owner_evidence_unknown_n,
    }, 10);
  }

  const triggerFamilies = [];
  if (closeTop2Ambiguity) triggerFamilies.push('ambiguity_close_top2');
  if (highRiskSelectedPresent || highRiskSuppressedPresent) triggerFamilies.push('high_risk_present');
  if (final.length === 1) triggerFamilies.push('shortlist_singleton');
  if (detSelected.length === 1) triggerFamilies.push('selected_singleton');
  if (preCommentOnlyN > 0) triggerFamilies.push('comment_only_present');

  if (fuzzyInShortlistN > 0) triggerFamilies.push('fuzzy_review_recommended');
  if (collisionHitsN > 0) triggerFamilies.push('collision_ambiguous');
  if (heroCloseTop2SkippedMultiMentionN > 0) triggerFamilies.push('multi_entity_co_mention');

  if (safeBypassBlockedSlot2N > 0) triggerFamilies.push('safe_bypass_blocks_review');
  if (tier3BindingPresentInPost) triggerFamilies.push('tier3_pair_correction');
  if (fuzzyNearExactInShortlistN > 0) triggerFamilies.push('fuzzy_near_exact_present');
  if (Object.keys(equivalenceKindCounts).length > 0) triggerFamilies.push('fuzzy_equivalence_present');
  if (conceptIntentAnchorPresentN > 0 || conceptIntentNegAnchorN > 0 || conceptIntentNeedsContextN > 0) triggerFamilies.push('concept_intent_guarded');
  if (ownerScopeConflict) triggerFamilies.push('owner_scope_conflict');
  if (owner_evidence_unknown_without_unlock_n > 0) triggerFamilies.push('owner_scope_unknown_needs_review');
  if (tier2ContextGapN > 0) triggerFamilies.push('tier2_context_gap');
  if (tier3ContextGapN > 0) triggerFamilies.push('tier3_context_gap');
  if (ownerSecondContextGapN > 0) triggerFamilies.push('owner_second_context_gap');
  if (ownerWeakContextN > 0) triggerFamilies.push('owner_scope_weak_context');
  if (ownerCompetingHeroPresentN > 0) triggerFamilies.push('owner_competing_hero_present');
  if (ownerTitlePrimaryCompetingTitlePrimaryN > 0) triggerFamilies.push('hero_scoped_comment_only_competing_hero_title_primary');
  if (protectedContextPresentN > 0) triggerFamilies.push('protected_context_present');

  const review_trigger_summary = {
    det_selected_pre_n: detSelected.length,
    det_suppressed_top_pre_n: detSuppressedTop.length,

    shortlist_pool_n: stage.length,
    lmm_review_candidates_pre_n: final.length,

    ambiguity_top2_margin_max: marginMax,
    close_top2_ambiguity: closeTop2Ambiguity,
    close_top2_samples: closeTop2Samples.slice(0, 8),

    high_risk_present: (highRiskSelectedPresent || highRiskSuppressedPresent),
    high_risk_selected_present: highRiskSelectedPresent,
    high_risk_suppressed_present: highRiskSuppressedPresent,

    selected_singleton: detSelected.length === 1,
    shortlist_singleton: final.length === 1,

    pre_shortlist_comment_only_n: preCommentOnlyN,
    pre_shortlist_has_title_op_n: preHasTitleOpN,

    fuzzy_in_shortlist_n: fuzzyInShortlistN,
    collision_hits_in_shortlist_n: collisionHitsN,

    tier3_binding_matched_pairs_n: Number(tier3Counts.matched_pairs_n || 0),
    fuzzy_near_exact_in_shortlist_n: fuzzyNearExactInShortlistN,
    equivalence_kind_counts: equivalenceKindCounts,
    concept_intent_anchor_present_n: conceptIntentAnchorPresentN,
    concept_intent_neg_anchor_n: conceptIntentNegAnchorN,
    concept_intent_requires_context_n: conceptIntentNeedsContextN,

    hero_unique_n: heroUniqueN,
    owner_scope_candidate_n: ownerScopeCandidateN,
    owner_scope_candidate_has_title_op_n: ownerScopeCandidateHasTitleOpN,
    owner_scope_conflict_present: ownerScopeConflict,
    owner_scope_conflict_reason: ownerScopeConflictReason,
    owner_evidence_conflict_n,
    owner_evidence_unknown_n,
    owner_evidence_unknown_without_unlock_n,
    tier2_context_gap_n: tier2ContextGapN,
    tier3_context_gap_n: tier3ContextGapN,
    owner_second_context_gap_n: ownerSecondContextGapN,
    owner_scope_weak_context_n: ownerWeakContextN,
    owner_competing_hero_present_n: ownerCompetingHeroPresentN,
    owner_title_primary_competing_hero_title_primary_n: ownerTitlePrimaryCompetingTitlePrimaryN,
    protected_context_present_n: protectedContextPresentN,

    trigger_families: triggerFamilies,

    caps: { per_category: perCatCap, total_per_post: totalCap, selected_by_category: catCounts },
  };

  const trace = [];
  for (const c of final) {
    if (trace.length >= MAX_TRACE) break;
    trace.push({
      key: `${toStr(c.category)}||${toStr(c.canonical_slug)}||${toStr(c.dictionary_entity_type)}`,
      score: c.det_score,
      lane: c.det_lane,
      reason: toStr(c.review_meta?.review_reason),
      ev_n: safeArray(c.evidence).length,
      origins: safeArray(c.origins),
      safe_blocks_review: c.det_safe_blocks_review === true,
      fuzzy_near_exact: c.det_fuzzy_near_exact === true,
      storage_intent: toStr(c.storage_intent),
      alias_only_signal: c.det_alias_only_signal === true,
      topicality_strong: topicalityStrong(c),
      comment_rel: commentRelBucket(c),
      pack_escaped: packEscaped(c),
      owner_status: ownerStatus(c),
      owner_context_strength: ownerContextStrength(c),
      owner_required_level: ownerRequiredLevel(c),
      owner_same_source_unlock: ownerHasSameSourceUnlock(c),
      owner_same_source_exact_canonical: ownerHasSameSourceExactCanonical(c),
      owner_title_op_support: ownerHasTitleOpSupport(c),
      owner_exact_title_op_support: ownerHasExactTitleOpSupport(c),
      owner_second_context: ownerHasSecondContext(c),
      owner_competing_hero_context: ownerCompetingHeroContext(c),
      protected_context: hasProtectedContext(c),
      equivalence_kind: equivalenceKind(c),
      intent_anchor_hits_n: safeArray(getIntentEvidence(c)?.intent_anchor_hits).length,
      neg_anchor_hits_n: safeArray(getIntentEvidence(c)?.neg_anchor_hits).length,
    });
  }

  return {
      needs_lmm_review_flagged: needsFlagged,

      lmm_review_candidates_stage: stageCapped,
      lmm_review_candidates_pre: final,
      lmm_review_candidates_pre_count: final.length,

      lmm_review_reason_codes_pre: { counts: stageReasons, prefix_counts: stageReasonPrefixes, keys: stageReasonKeys },

      review_trigger_summary,

      slot_builder_parity_meta: {
        fuzzy_in_shortlist_n: fuzzyInShortlistN,
        collision_hits_in_shortlist_n: collisionHitsN,
        hero_close_top2_skipped_multi_mention_n: heroCloseTop2SkippedMultiMentionN,
        hero_close_top2_skipped_samples: heroCloseTop2SkippedSamples,

        collision_slot2_added_n: collisionSlot2AddedN,
        collision_slot2_samples: collisionSlot2Samples,

        safe_bypass_blocked_slot2_n: safeBypassBlockedSlot2N,
        safe_bypass_blocked_slot2_samples: safeBypassBlockedSlot2Samples,

        tier3_binding_slot2_skipped_n: tier3BindingSlot2SkippedN,
        tier3_binding_slot2_skipped_samples: tier3BindingSlot2SkippedSamples,

        fuzzy_near_exact_slot2_skipped_n: fuzzyNearExactSlot2SkippedN,
        fuzzy_near_exact_slot2_skipped_samples: fuzzyNearExactSlot2SkippedSamples,

        rag_ok_slot2_skipped_n: ragOkSlot2SkippedN,
        rag_ok_slot2_skipped_samples: ragOkSlot2SkippedSamples,

        alias_only_slot2_skipped_n: aliasOnlySlot2SkippedN,
        alias_only_slot2_skipped_samples: aliasOnlySlot2SkippedSamples,

        comment_only_pressure_slot2_skipped_low_rel_n: commentOnlyPressureSlot2SkippedLowRelN,
        comment_only_pressure_slot2_skipped_low_rel_samples: commentOnlyPressureSkippedLowRelSamples,
        pack_escaped_slot2_avoided_n: packEscapedSlot2AvoidedN,
        pack_escaped_slot2_avoided_samples: packEscapedSlot2AvoidedSamples,

        owner_scope_conflict_n: ownerScopeConflictN,
        owner_scope_conflict_samples: ownerScopeConflictSamples,

        // v2.0
        owner_evidence_conflict_n,
        owner_evidence_unknown_n,
        owner_evidence_unknown_without_unlock_n,
        tier2_context_gap_n: tier2ContextGapN,
        tier3_context_gap_n: tier3ContextGapN,
        owner_scope_weak_context_n: ownerWeakContextN,
        owner_competing_hero_present_n: ownerCompetingHeroPresentN,
        protected_context_present_n: protectedContextPresentN,
      exact_context_safe_bypass_n: exactContextSafeBypassN,
      exact_context_safe_samples: exactContextSafeSamples,
        equivalence_kind_counts: equivalenceKindCounts,
        concept_intent_anchor_present_n: conceptIntentAnchorPresentN,
        concept_intent_neg_anchor_n: conceptIntentNegAnchorN,
        concept_intent_requires_context_n: conceptIntentNeedsContextN,

        samples: paritySamples,
      },

      lmm_shortlist_trace: { slotting: slotTrace, sample: trace },
  };
}

module.exports = {
  buildSlotStagePatch,
};
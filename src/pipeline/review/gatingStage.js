function isObject(x) { return x && typeof x === 'object' && !Array.isArray(x); }
function safeArray(x) { return Array.isArray(x) ? x : []; }
function uniq(arr) { return [...new Set(safeArray(arr).filter(Boolean))]; }
function toStr(v) { return v === null || v === undefined ? '' : String(v); }

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

function isCommentOnly(evList) {
  const hasTO = hasTitleOrOpEvidence(evList);
  const hasC = hasCommentEvidence(evList);
  return !hasTO && hasC;
}

function isHighRisk(c) {
  return toStr(c?.promotion_risk).toUpperCase() === 'HIGH';
}

function stableKey(c) {
  return `${toStr(c.category)}||${toStr(c.canonical_slug)}||${toStr(c.dictionary_entity_type)}`;
}

function pushBounded(arr, obj, cap) {
  if (arr.length < cap) arr.push(obj);
}

function annotateReviewDecision(c, patch) {
  if (!isObject(c)) return c;
  const meta = isObject(c.review_gating_meta) ? c.review_gating_meta : {};
  c.review_gating_meta = { ...meta, ...patch };
  return c;
}

function markReviewDrop(c, reason, family, payload) {
  const trace = [];
  if (toStr(reason)) trace.push(toStr(reason));
  for (const r of safeArray(payload?.storage_blockers)) trace.push(toStr(r));
  if (toStr(payload?.review_reason)) trace.push(`review_reason:${toStr(payload.review_reason)}`);
  annotateReviewDecision(c, {
    review_gate_decision: 'DROP',
    review_survived_gating: false,
    review_drop_reason_primary: toStr(reason) || null,
    review_drop_reason_family: toStr(family) || null,
    review_prune_trace: uniq(trace.filter(Boolean)).slice(0, 3),
  });
  return c;
}

function markReviewKeep(c, reason, payload) {
  const trace = [];
  if (toStr(reason)) trace.push(toStr(reason));
  if (toStr(payload?.review_reason)) trace.push(`review_reason:${toStr(payload.review_reason)}`);
  annotateReviewDecision(c, {
    review_gate_decision: 'KEEP',
    review_survived_gating: true,
    review_keep_reason_primary: toStr(reason) || null,
    review_prune_trace: uniq(trace.filter(Boolean)).slice(0, 3),
  });
  return c;
}


function compactEvidencePreview(preview, maxItems = 4) {
  const out = [];
  for (const pv0 of safeArray(preview)) {
    const pv = isObject(pv0) ? {
      source_type: toStr(pv0.source_type) || '',
      source_id: toStr(pv0.source_id) || '',
      comment_rank: Number.isFinite(pv0.comment_rank) ? pv0.comment_rank : null,
      comment_score: Number.isFinite(pv0.comment_score) ? pv0.comment_score : null,
      matched_text: toStr(pv0.matched_text) || '',
      matched_text_norm: toStr(pv0.matched_text_norm) || '',
      context_snippet: toStr(pv0.context_snippet).slice(0, 240) || '',
      reason: toStr(pv0.reason) || '',
    } : null;
    if (!pv) continue;
    const hasHumanValue =
      toStr(pv.matched_text).trim() ||
      toStr(pv.matched_text_norm).trim() ||
      toStr(pv.context_snippet).trim() ||
      toStr(pv.reason).trim();
    if (!hasHumanValue) continue;
    out.push(pv);
    if (out.length >= maxItems) break;
  }
  return out;
}

function reviewDriverReasonFamily(c) {
  const rm = isObject(c?.review_meta) ? c.review_meta : {};
  const source = toStr(rm.review_source).trim();
  const reviewReason = toStr(rm.review_reason).trim();
  const codes = safeArray(rm.reason_codes).map(toStr).filter(Boolean);

  if (reviewReason.includes(':slot2_')) return 'slot2';
  if (codes.some((r) => r.startsWith('slot2:') || r.includes(':slot2_'))) return 'slot2';
  if (reviewReason.includes('collision')) return 'collision';
  if (codes.some((r) => r.includes('collision'))) return 'collision';
  if (reviewReason.includes('owner') || reviewReason.includes('tier')) return 'owner_tier';
  if (codes.some((r) => r.includes('owner') || r.includes('tier'))) return 'owner_tier';
  if (reviewReason.includes('fuzzy') || source === 'fuzzy') return 'fuzzy';
  if (codes.some((r) => r.includes('fuzzy') || r.startsWith('equivalence:'))) return 'fuzzy';
  if (reviewReason.includes('concept') || reviewReason.includes('intent')) return 'concept_intent';
  if (codes.some((r) => r.includes('intent') || r.includes('concept'))) return 'concept_intent';
  return source || prefixOf(reviewReason) || null;
}

function prefixOf(reason) {
  const s = toStr(reason);
  const i = s.indexOf(':');
  return i > 0 ? s.slice(0, i) : (s || null);
}

function compactReviewSample(c) {
  const cc = isObject(c) ? c : {};
  const ev = safeArray(cc.evidence);
  const es = isObject(cc.evidence_summary) ? cc.evidence_summary : {};
  const rm = isObject(cc.review_meta) ? cc.review_meta : {};
  const gm = isObject(cc.review_gating_meta) ? cc.review_gating_meta : {};
  return {
    key: stableKey(cc),
    category: toStr(cc.category),
    canonical_slug: toStr(cc.canonical_slug),
    dictionary_entity_type: toStr(cc.dictionary_entity_type),
    det_score: Number.isFinite(Number(cc.det_score)) ? Number(cc.det_score) : null,
    det_lane: toStr(cc.det_lane || '' ) || null,
    origins: safeArray(cc.origins).slice(0, 4),
    review_reason: toStr(rm.review_reason) || null,
    review_source: toStr(rm.review_source) || null,
    reason_codes: safeArray(rm.reason_codes).map(toStr).filter(Boolean).slice(0, 6),
    storage_intent: toStr(cc.storage_intent) || null,
    storage_reasons: safeArray(cc.storage_reasons).map(toStr).filter(Boolean).slice(0, 6),
    storage_blockers: safeArray(cc.storage_blockers).map(toStr).filter(Boolean).slice(0, 6),
    storage_reason_primary: toStr(cc.storage_reason_primary) || null,
    storage_reason_family: toStr(cc.storage_reason_family) || null,
    storage_reason_trace: safeArray(cc.storage_reason_trace).map(toStr).filter(Boolean).slice(0, 6),
    selection_reason_primary: toStr(cc.selection_reason_primary) || null,
    suppression_reason_primary: toStr(cc.suppression_reason_primary) || null,
    selection_competition_reason: toStr(cc.selection_competition_reason) || null,
    drop_reason_primary: toStr(cc.drop_reason_primary) || null,
    drop_reason_family: toStr(cc.drop_reason_family) || null,
    drop_explanation_trace: safeArray(cc.drop_explanation_trace).map(toStr).filter(Boolean).slice(0, 6),
    same_canonical_selected_elsewhere: cc.same_canonical_selected_elsewhere === true,
    same_canonical_storage_summary: isObject(cc.same_canonical_storage_summary) ? cc.same_canonical_storage_summary : null,
    owner_status: ownerStatus(cc),
    equivalence_kind: equivalenceKind(cc),
    comment_only: isCommentOnly(ev),
    has_title_op: es.has_title_op === true ? true : (hasTitleOrOpEvidence(ev) ? true : false),
    has_comment: es.has_comment === true ? true : (hasCommentEvidence(ev) ? true : false),
    strong_support: es.comment_answer_slot_supported === true || cc.strong_comment_support === true,
    evidence_preview: compactEvidencePreview(cc.evidence_preview),
    review_driver_reason_family: reviewDriverReasonFamily(cc),
    review_gate_decision: toStr(gm.review_gate_decision) || null,
    review_survived_gating: gm.review_survived_gating === true ? true : (gm.review_survived_gating === false ? false : null),
    review_keep_reason_primary: toStr(gm.review_keep_reason_primary) || null,
    review_drop_reason_primary: toStr(gm.review_drop_reason_primary) || null,
    review_drop_reason_family: toStr(gm.review_drop_reason_family) || null,
    review_prune_trace: safeArray(gm.review_prune_trace).map(toStr).filter(Boolean).slice(0, 4),
  };
}

function inc(obj, key, by = 1) {
  obj[key] = (obj[key] || 0) + by;
}

function isCommentOnlySensitiveCategory(catRaw) {
  const c = toStr(catRaw).toLowerCase();
  return (
    c === 'hero' ||
    c === 'map' ||
    c === 'rank' ||
    c === 'queue' ||
    c === 'platform' ||
    c === 'mode' ||
    c === 'role' ||
    c === 'ability' ||
    c === 'perk'
  );
}

function isTopPullCommentOnlyReason(c) {
  const r = toStr(c?.review_meta?.review_reason);
  return r.includes(':slot2_comment_only_present');
}

function originsSet(c) {
  return new Set(safeArray(c?.origins).map(toStr));
}

function isFuzzyOrigin(c) { return originsSet(c).has('fuzzy'); }
function isExactOrigin(c) { return originsSet(c).has('exact'); }

function isFuzzyOnly(c) {
  const s = originsSet(c);
  return s.has('fuzzy') && !s.has('exact');
}

function isFuzzyReviewableCategory(catRaw) {
  const c = toStr(catRaw).toLowerCase();
  return c === 'hero' || c === 'map';
}

function isCollisionSlot2Reason(c) {
  const r = toStr(c?.review_meta?.review_reason);
  return r.includes(':slot2_collision_ambiguous');
}

function categoryKey(catRaw) {
  return toStr(catRaw).toLowerCase() || 'unknown';
}

function isSlot2Pull(c) {
  const r = toStr(c?.review_meta?.review_reason);
  return r.includes(':slot2_');
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

function isHeroScopedCategory(catRaw) {
  const c = toStr(catRaw).toLowerCase();
  return c === 'ability' || c === 'perk';
}

function getEvidenceSummary(c) {
  return isObject(c?.evidence_summary) ? c.evidence_summary : null;
}

function getOwnerEvidence(c) {
  if (isObject(c?.owner_evidence)) return c.owner_evidence;
  const es = getEvidenceSummary(c);
  return isObject(es?.owner_evidence) ? es.owner_evidence : null;
}

function getIntentEvidence(c) {
  if (isObject(c?.intent_evidence)) return c.intent_evidence;
  const es = getEvidenceSummary(c);
  return isObject(es?.intent_evidence) ? es.intent_evidence : null;
}

function getEquivalence(c) {
  if (isObject(c?.equivalence)) return c.equivalence;
  const es = getEvidenceSummary(c);
  return isObject(es?.equivalence) ? es.equivalence : null;
}

function ownerStatus(c) {
  const oe = getOwnerEvidence(c);
  const s = toStr(oe?.owner_status).toUpperCase();
  if (s === 'KNOWN' || s === 'CONFLICT' || s === 'UNKNOWN') return s;
  return 'NONE';
}

function ownerSameSourceUnlock(c) {
  const oe = getOwnerEvidence(c);
  return oe?.owner_same_source_unlock === true;
}

function ownerSecondContext(c) {
  const oe = getOwnerEvidence(c);
  return oe?.owner_second_context === true;
}

function ownerSameSourceExactCanonical(c) {
  const oe = getOwnerEvidence(c);
  return oe?.owner_same_source_exact_canonical === true;
}

function ownerTitleOpSupport(c) {
  const oe = getOwnerEvidence(c);
  return oe?.owner_title_op_support === true;
}

function ownerExactTitleOpSupport(c) {
  const oe = getOwnerEvidence(c);
  return oe?.owner_exact_title_op_support === true;
}

function ownerCompetingHeroContext(c) {
  const oe = getOwnerEvidence(c);
  return oe?.owner_competing_hero_context === true;
}

function ownerContextStrength(c) {
  const oe = getOwnerEvidence(c);
  return toStr(oe?.owner_context_strength).toUpperCase() || 'NONE';
}

function ownerRequiredLevel(c) {
  const oe = getOwnerEvidence(c);
  return toStr(oe?.owner_required_level).toUpperCase() || '';
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

function intentRequiresContext(c) {
  const ie = getIntentEvidence(c);
  return ie?.requires_context === true || ie?.requires_intent_anchor === true;
}

function intentHasAnchor(c) {
  const ie = getIntentEvidence(c);
  if (!ie) return false;
  if (ie.intent_anchor_present === true) return true;
  const hits = safeArray(ie.intent_anchor_hits);
  return hits.length > 0;
}

function intentNegHits(c) {
  const ie = getIntentEvidence(c);
  return safeArray(ie?.neg_anchor_hits);
}

function equivalenceKind(c) {
  const eq = getEquivalence(c);
  const k = toStr(eq?.kind).toUpperCase();
  if (!k) return 'NONE';
  return k;
}

function candidateCorroboratedForSensitiveKeep(c) {
  const es = getEvidenceSummary(c);
  const independentN = Number(es?.independent_evidence_n || 0);
  const bestRank = Number.isFinite(es?.best_comment_rank) ? es.best_comment_rank : null;

  if (independentN >= 2) return true;
  if (bestRank !== null && bestRank <= 3) return true;
  return false;
}

function commentExactRelevanceBucket(c) {
  const es = getEvidenceSummary(c);
  const top = toStr(c?.comment_exact_relevance_bucket || '').toUpperCase();
  if (top === 'HIGH' || top === 'MED' || top === 'LOW') return top;
  const nested = toStr(es?.comment_exact_relevance_bucket || '').toUpperCase();
  if (nested === 'HIGH' || nested === 'MED' || nested === 'LOW') return nested;
  const det = toStr(c?.det_comment_exact_relevance_bucket || '').toUpperCase();
  if (det === 'HIGH' || det === 'MED' || det === 'LOW') return det;
  return null;
}

function topicalityStrong(c) {
  const es = getEvidenceSummary(c);
  if (typeof es?.topicality_strong === 'boolean') return es.topicality_strong;
  return null;
}

function packEscaped(c) {
  const pm = isObject(c?.pack_meta) ? c.pack_meta : null;
  return pm?.pack_risky_alias_escaped === true;
}

function collectReasons(c) {
  const out = [];
  const direct = safeArray(c?.reason_codes);
  for (const r of direct) out.push(toStr(r));

  const sup = safeArray(c?.suppression_reasons);
  for (const r of sup) out.push(toStr(r));

  const stor = safeArray(c?.storage_reasons);
  for (const r of stor) out.push(toStr(r));

  const review = safeArray(c?.review_meta?.reason_codes);
  for (const r of review) out.push(toStr(r));

  return out.filter(Boolean);
}

function hasAnyReason(c, prefixes) {
  const reasons = collectReasons(c);
  for (const r of reasons) {
    for (const p of prefixes) {
      if (r === p || r.startsWith(p)) return true;
    }
  }
  return false;
}

function categoryPullReasonTokens(c) {
  const out = new Set();
  const rr = toStr(c?.review_meta?.review_reason);
  const reasons = collectReasons(c);
  const buckets = [rr, ...reasons];
  for (const raw of buckets) {
    const s = toStr(raw).toLowerCase();
    if (!s) continue;
    if (s.includes('comment_only_top_candidate') || s.includes('category_comment_only_top_pull')) out.add('comment_only_top_candidate');
    if (s.includes('soft_top_candidate_reviewable_category')) out.add('soft_top_candidate_reviewable_category');
    if (s.includes('fuzzy_top_without_primary_support') || s.includes('category_fuzzy_no_primary_pull')) out.add('fuzzy_top_without_primary_support');
    if (s.includes('fuzzy_node_review_recommended') || s.includes('category_fuzzy_review_pull')) out.add('fuzzy_node_review_recommended');
    if (s.includes('fuzzy_alias_rollout_fallback') || s.includes('category_fuzzy_alias_rollout_pull')) out.add('fuzzy_alias_rollout_fallback');
    if (s.includes('exact_canonical_not_primary_or_comment_only')) out.add('exact_canonical_not_primary_or_comment_only');
    if (s.includes('top_candidate_flagged_for_review')) out.add('top_candidate_flagged_for_review');
    if (s.includes('candidate_review_signal')) out.add('candidate_review_signal');
  }
  return Array.from(out);
}

function candidateHasDetSafeReviewBypass(c) {
  if (c?.det_safe_blocks_review === true) return true;
  if (hasAnyReason(c, [
    'safe_bypass:',
    'allow:deterministic_safe_comment_exact',
    'allow:protected_exact_context_safe',
  ])) return true;
  const si = toStr(c?.storage_intent).toUpperCase();
  const es = getEvidenceSummary(c);
  const topo = es?.topicality_strong === true || c?.det_topicality_strong === true;
  if (si === 'RAG_OK' && topo) return true;
  return false;
}

function candidateHasLowValueCategoryPullOnly(c) {
  const tokens = categoryPullReasonTokens(c);
  if (!tokens.length) return false;
  const low = new Set([
    'comment_only_top_candidate',
    'soft_top_candidate_reviewable_category',
    'candidate_review_signal',
    'exact_canonical_not_primary_or_comment_only',
    'top_candidate_flagged_for_review',
  ]);
  return tokens.every(t => low.has(t));
}

function candidateHasHeroHighValueCategorySignal(c) {
  const tokens = categoryPullReasonTokens(c);
  return tokens.some(t => (
    t === 'fuzzy_top_without_primary_support' ||
    t === 'fuzzy_node_review_recommended' ||
    t === 'fuzzy_alias_rollout_fallback'
  ));
}

function fallbackFlaggedCategoryTokens(c) {
  const tokens = categoryPullReasonTokens(c);
  const flagged = new Set([
    'comment_only_top_candidate',
    'soft_top_candidate_reviewable_category',
    'fuzzy_top_without_primary_support',
    'fuzzy_node_review_recommended',
    'fuzzy_alias_rollout_fallback',
    'top_candidate_flagged_for_review',
    'candidate_review_signal',
  ]);
  return tokens.filter(t => flagged.has(t));
}

function candidateEligibleForFallbackRecovery(c, closeTop2, strongSupport) {
  const cat = categoryKey(c?.category);
  const flaggedTokens = fallbackFlaggedCategoryTokens(c);
  if (!flaggedTokens.length) return false;

  if (candidateHasDetSafeReviewBypass(c)) return false;
  if (packEscaped(c)) return false;

  const dropReason = toStr(c?.review_gating_meta?.review_drop_reason_primary);
  const hardDrop = new Set([
    'review_drop:equivalence_failed_deterministic',
    'review_drop:concept_missing_intent_anchor',
    'review_drop:concept_neg_anchor_hit',
    'review_drop:owner_scope_deterministically_blocked',
    'review_drop:tier2_missing_context',
    'review_drop:tier3_missing_context',
    'review_drop:owner_scope_weak_context',
    'review_drop:rag_ok_primary_confident',
    'review_drop:rag_ok_primary_confident_topicality_strong',
    'review_drop:pack_escape_not_ambiguity_route_worthy',
    'review_drop:high_risk_only_no_ambiguity',
    'review_drop:low_signal_comment_only_hero_map',
  ]);
  if (hardDrop.has(dropReason)) return false;

  const commentOnly = isCommentOnly(safeArray(c?.evidence));
  const hasTO = hasTitleOrOpEvidence(safeArray(c?.evidence));
  if (commentOnly && isCommentOnlySensitiveCategory(cat) && !strongSupport && !closeTop2) return false;

  const heroMap = cat === 'hero' || cat === 'map';
  const highValue = candidateHasHeroHighValueCategorySignal(c);
  if (!heroMap && !highValue) return false;

  const eqKind = equivalenceKind(c);
  if (isFuzzyOnly(c) && eqKind === 'NONE' && !strongSupport && !closeTop2) return false;

  if (!hasTO && !closeTop2 && !strongSupport && !highValue && !heroMap) return false;
  return true;
}

function fallbackRecoveryRank(c) {
  const det = Number.isFinite(Number(c?.det_score)) ? Number(c.det_score) : -9999;
  const exactBoost = isExactOrigin(c) ? 5 : 0;
  const toBoost = hasTitleOrOpEvidence(safeArray(c?.evidence)) ? 2 : 0;
  const heroMapBoost = (categoryKey(c?.category) === 'hero' || categoryKey(c?.category) === 'map') ? 1 : 0;
  return det + exactBoost + toBoost + heroMapBoost;
}

const TRACE_CAP = 18;
const PRUNE_SAMPLE_CAP = 24;

/**
 * @param {object} j - score output merged with slot stage patch
 * @returns {object} patch fields to merge (overwrites lmm_review_candidates_pre with post-gate list)
 */
function applyReviewShortlistGatingPatch(j) {
  j = isObject(j) ? j : {};

  const pre = safeArray(j.lmm_review_candidates_pre);
  const summary = isObject(j.review_trigger_summary) ? j.review_trigger_summary : {};

  const strongSupport =
    (j.answer_slot_strong_support === true) ||
    (Number(j.answer_slot_tier1_comment_count || 0) > 0) ||
    (Number(j.answer_slot_contradiction_count || 0) > 0);

  const closeTop2 = summary.close_top2_ambiguity === true;
  const triggerFamilies = safeArray(summary.trigger_families).map(toStr);
  const multiEntityCoMention = triggerFamilies.includes('multi_entity_co_mention');

  const tier3SuppressSet = new Set(safeArray(j.tier3_binding_suppress_keys).map(toStr));
  const tier3BoostSet = new Set(safeArray(j.tier3_binding_boost_keys).map(toStr));

  // Precompute "category has exact" for fuzzy runner-up shadow
  const categoryHasExact = {};
  for (const c of pre) {
    const cat = categoryKey(c.category);
    if (isExactOrigin(c)) categoryHasExact[cat] = true;
  }

  // Precompute per-category slot1
  const slot1ByCategory = {};
  for (const c of pre) {
    const rr = toStr(c?.review_meta?.review_reason);
    if (!rr.includes(':slot1_top')) continue;
    const cat = categoryKey(c.category);
    slot1ByCategory[cat] = c;
  }

  const fams = safeArray(summary.trigger_families).map(toStr);
  const collisionFamilyPresent = fams.includes('collision_ambiguous');

  // UNIQUE hero presence for owner/hero-scoped rules fallback
  const heroCandidates = pre.filter((c) => categoryKey(c.category) === 'hero');
  const uniqueHeroSlugs = new Set();
  for (const hc of heroCandidates) {
    const slug = toStr(hc.canonical_slug) || toStr(hc.hero_slug);
    if (slug) uniqueHeroSlugs.add(slug);
  }
  const heroN = uniqueHeroSlugs.size;

  const counts = {
    in_pre: pre.length,
    out_pre: 0,

    dropped_tier3_binding_suppressed: 0,
    dropped_fuzzy_near_exact_deterministic: 0,
    dropped_rag_ok_primary_confident: 0,
    dropped_rag_ok_primary_confident_topicality_strong: 0,
    dropped_alias_only_weak_slot2: 0,

    dropped_pack_escape_not_ambiguity_route_worthy: 0,
    dropped_comment_exact_low_relevance: 0,

    dropped_comment_only_weak: 0,
    dropped_comment_only_top_pull: 0,
    dropped_high_risk_only_no_ambiguity: 0,
    dropped_det_safe_low_value_category_pull: 0,
    dropped_soft_top_candidate_not_route_worthy: 0,
    dropped_map_low_value_category_pull_singleton: 0,
    dropped_hero_low_value_category_pull_singleton: 0,
    dropped_co_mentioned_exact_pair_not_route_worthy: 0,
    dropped_low_signal_comment_only_hero_map: 0,

    fallback_flagged_category_pull_count: 0,
    flagged_category_empty_after_selection_count: 0,
    flagged_category_recovered_count: 0,

    dropped_fuzzy_only_no_corroboration: 0,
    dropped_fuzzy_origin_category_not_reviewable: 0,
    dropped_fuzzy_runner_up_shadow: 0,
    dropped_fuzzy_without_equivalence: 0,

    dropped_collision_slot2_shadowed_by_title_op: 0,
    noted_collision_not_competing: 0,
    noted_close_top2_invalidated_singleton: 0,
    noted_close_top2_missing_runner_up_post_gating: 0,

    dropped_owner_scope_missing_hero_context: 0,
    dropped_owner_scope_no_competing_owner: 0,
    dropped_owner_scope_deterministically_blocked: 0,
    dropped_tier2_missing_context: 0,
    dropped_tier3_missing_context: 0,
    dropped_owner_scope_weak_context: 0,

    dropped_hero_scoped_single_owner_resolved: 0,
    dropped_hero_scoped_weak_without_title_op: 0,

    dropped_equivalence_failed_deterministic: 0,
    dropped_concept_missing_intent_anchor: 0,
    dropped_concept_neg_anchor_hit: 0,

    kept: 0,
    kept_comment_only_supported: 0,
    kept_comment_only_supported_sensitive_corroborated: 0,
    kept_tier3_binding_boosted_note: 0,
  };

  const equivalence_status_counts = { NONE: 0 };
  const intent_evidence_status_counts = {
    not_applicable: 0,
    requires_anchor_present: 0,
    requires_anchor_missing: 0,
    neg_anchor_hit: 0,
  };
  const owner_evidence_status_counts = { KNOWN: 0, UNKNOWN: 0, CONFLICT: 0, NONE: 0 };

  const equivalence_samples = [];
  const intent_evidence_samples = [];
  const owner_evidence_samples = [];

  const trace = { dropped: [], kept: [], notes: [] };
  const review_prune_reason_counts = {};
  const review_keep_reason_counts = {};
  const review_prune_samples = [];
  const fallback_flagged_category_pull_by_category = {};
  const fallback_flagged_category_pull_by_reason = {};
  const review_fallback_recovery_counts = {};
  const review_fallback_recovery_samples = [];
  const review_low_signal_hero_map_counts = { total: 0, by_category: {} };
  const out = [];

  function addPrune(reason, countField, payload, candidate) {
    if (countField) counts[countField] = (counts[countField] || 0) + 1;
    if (candidate) {
      markReviewDrop(candidate, reason, reason.replace(/^review_drop:/, '') || 'review_drop', payload);
    }
    inc(review_prune_reason_counts, reason);
    pushBounded(trace.dropped, { reason, ...payload }, TRACE_CAP);
    pushBounded(review_prune_samples, { reason, ...payload }, PRUNE_SAMPLE_CAP);
  }

  for (const c of pre) {
    const key = stableKey(c);

    const ev = safeArray(c.evidence);
    const commentOnly = isCommentOnly(ev);
    const highRisk = isHighRisk(c);
    const catRaw = toStr(c.category);
    const cat = categoryKey(catRaw);

    const fuzzy = isFuzzyOrigin(c);
    const exact = isExactOrigin(c);
    const fuzzyOnly = isFuzzyOnly(c);
    const hasTO = hasTitleOrOpEvidence(ev);

    const slot2Pull = isSlot2Pull(c);

    const eqKind = equivalenceKind(c);
    if (!Object.prototype.hasOwnProperty.call(equivalence_status_counts, eqKind)) equivalence_status_counts[eqKind] = 0;
    equivalence_status_counts[eqKind] += 1;
    if (equivalence_samples.length < 10 && fuzzy) {
      equivalence_samples.push({
        key,
        category: catRaw,
        origins: safeArray(c.origins),
        equivalence_kind: eqKind,
        review_reason: toStr(c?.review_meta?.review_reason),
      });
    }

    const requiresIntent = intentRequiresContext(c);
    const hasIntentAnchor = intentHasAnchor(c);
    const negHits = intentNegHits(c);
    if (requiresIntent) {
      if (negHits.length > 0) intent_evidence_status_counts.neg_anchor_hit += 1;
      else if (hasIntentAnchor) intent_evidence_status_counts.requires_anchor_present += 1;
      else intent_evidence_status_counts.requires_anchor_missing += 1;
    } else {
      intent_evidence_status_counts.not_applicable += 1;
    }
    if (intent_evidence_samples.length < 10 && (requiresIntent || negHits.length > 0)) {
      intent_evidence_samples.push({
        key,
        category: catRaw,
        requires_intent_anchor: requiresIntent,
        intent_anchor_present: hasIntentAnchor,
        neg_anchor_hits: negHits,
        review_reason: toStr(c?.review_meta?.review_reason),
      });
    }

    const os = ownerStatus(c);
    owner_evidence_status_counts[os] += 1;
    if (owner_evidence_samples.length < 10 && isOwnerScopeCategory(catRaw)) {
      owner_evidence_samples.push({
        key,
        category: catRaw,
        owner_status: os,
        owner_context_strength: ownerContextStrength(c),
        owner_required_level: ownerRequiredLevel(c),
        owner_same_source_unlock: ownerSameSourceUnlock(c),
        owner_same_source_exact_canonical: ownerSameSourceExactCanonical(c),
        owner_title_op_support: ownerTitleOpSupport(c),
        owner_exact_title_op_support: ownerExactTitleOpSupport(c),
        owner_second_context: ownerSecondContext(c),
        owner_competing_hero_context: ownerCompetingHeroContext(c),
        protected_context: hasProtectedContext(c),
        review_reason: toStr(c?.review_meta?.review_reason),
      });
    }

    const deterministicEquivalenceBlocked = hasAnyReason(c, [
      'suppress:equivalence_failed',
      'storage:block_equivalence_failed',
    ]);
    const deterministicIntentMissing = hasAnyReason(c, [
      'suppress:concept_missing_intent_anchor',
      'storage:block_missing_intent_anchor',
    ]);
    const deterministicNegAnchor = hasAnyReason(c, [
      'suppress:concept_neg_anchor_hit:',
      'storage:block_concept_neg_anchor:',
    ]);
    const deterministicOwnerBlocked = hasAnyReason(c, [
      'suppress:owner_scope_missing_owner',
      'suppress:owner_scope_conflict_multi_owner',
      'suppress:owner_scope_weak_context',
      'suppress:tier2_missing_context',
      'suppress:tier3_missing_context',
      'storage:block_missing_owner_scope',
      'storage:block_owner_scope_conflict',
      'storage:block_owner_scope_weak_context',
      'storage:block_tier2_missing_context',
      'storage:block_tier3_missing_context',
    ]);
    const deterministicTier2Blocked = hasAnyReason(c, [
      'suppress:tier2_missing_context',
      'storage:block_tier2_missing_context',
    ]);
    const deterministicTier3Blocked = hasAnyReason(c, [
      'suppress:tier3_missing_context',
      'storage:block_tier3_missing_context',
    ]);
    const deterministicOwnerWeakBlocked = hasAnyReason(c, [
      'suppress:owner_scope_weak_context',
      'storage:block_owner_scope_weak_context',
    ]);

    // ---- Tier3 binding hard suppress ----
    if (tier3SuppressSet.has(key)) {
      counts.dropped_tier3_binding_suppressed += 1;
      markReviewDrop(c, 'review_drop:tier3_binding_suppressed', 'tier3_binding_suppressed', {
        review_reason: toStr(c?.review_meta?.review_reason),
      });
      pushBounded(trace.dropped, {
        key,
        reason: 'review_drop:tier3_binding_suppressed',
        category: catRaw,
        review_reason: toStr(c?.review_meta?.review_reason),
      }, TRACE_CAP);
      continue;
    }

    // ---- Deterministic equivalence parity clamp ----
    if (deterministicEquivalenceBlocked || (fuzzyOnly && eqKind === 'NONE' && !strongSupport && !closeTop2)) {
      counts.dropped_equivalence_failed_deterministic += 1;
      markReviewDrop(c, 'review_drop:equivalence_failed_deterministic', 'equivalence_failed_deterministic', {
        review_reason: toStr(c?.review_meta?.review_reason),
      });
      if (fuzzyOnly && eqKind === 'NONE') counts.dropped_fuzzy_without_equivalence += 1;
      pushBounded(trace.dropped, {
        key,
        reason: 'review_drop:equivalence_failed_deterministic',
        category: catRaw,
        equivalence_kind: eqKind,
        origins: safeArray(c.origins),
        review_reason: toStr(c?.review_meta?.review_reason),
      }, TRACE_CAP);
      continue;
    }

    // ---- Deterministic concept-intent parity clamp ----
    if (deterministicNegAnchor || (requiresIntent && negHits.length > 0 && !closeTop2)) {
      counts.dropped_concept_neg_anchor_hit += 1;
      markReviewDrop(c, 'review_drop:concept_neg_anchor_hit', 'concept_neg_anchor_hit', {
        storage_blockers: negHits,
        review_reason: toStr(c?.review_meta?.review_reason),
      });
      pushBounded(trace.dropped, {
        key,
        reason: 'review_drop:concept_neg_anchor_hit',
        category: catRaw,
        neg_anchor_hits: negHits,
        review_reason: toStr(c?.review_meta?.review_reason),
      }, TRACE_CAP);
      continue;
    }

    if (deterministicIntentMissing || (requiresIntent && !hasIntentAnchor && !strongSupport && !closeTop2)) {
      counts.dropped_concept_missing_intent_anchor += 1;
      markReviewDrop(c, 'review_drop:concept_missing_intent_anchor', 'concept_missing_intent_anchor', {
        review_reason: toStr(c?.review_meta?.review_reason),
      });
      pushBounded(trace.dropped, {
        key,
        reason: 'review_drop:concept_missing_intent_anchor',
        category: catRaw,
        requires_intent_anchor: requiresIntent,
        intent_anchor_present: hasIntentAnchor,
        review_reason: toStr(c?.review_meta?.review_reason),
      }, TRACE_CAP);
      continue;
    }

    const ownerCompeting = ownerCompetingHeroContext(c);
    const protectedCtx = hasProtectedContext(c);
    const exactOwnerSupport = ownerSameSourceExactCanonical(c) || ownerExactTitleOpSupport(c);
    const slot2OrConflict = slot2Pull || closeTop2 || os === 'CONFLICT' || ownerCompeting;

    if (deterministicTier3Blocked && !slot2OrConflict && !protectedCtx && !exactOwnerSupport) {
      addPrune('review_drop:tier3_missing_context', 'dropped_tier3_missing_context', {
        key,
        category: catRaw,
        owner_status: os,
        owner_required_level: ownerRequiredLevel(c),
        owner_context_strength: ownerContextStrength(c),
        protected_context: protectedCtx,
        review_reason: toStr(c?.review_meta?.review_reason),
      }, c);
      continue;
    }

    if (deterministicTier2Blocked && !slot2OrConflict && !exactOwnerSupport && !ownerSameSourceUnlock(c)) {
      addPrune('review_drop:tier2_missing_context', 'dropped_tier2_missing_context', {
        key,
        category: catRaw,
        owner_status: os,
        owner_required_level: ownerRequiredLevel(c),
        owner_context_strength: ownerContextStrength(c),
        review_reason: toStr(c?.review_meta?.review_reason),
      }, c);
      continue;
    }

    if (deterministicOwnerWeakBlocked && !slot2OrConflict && !protectedCtx && !exactOwnerSupport) {
      addPrune('review_drop:owner_scope_weak_context', 'dropped_owner_scope_weak_context', {
        key,
        category: catRaw,
        owner_status: os,
        owner_context_strength: ownerContextStrength(c),
        protected_context: protectedCtx,
        review_reason: toStr(c?.review_meta?.review_reason),
      }, c);
      continue;
    }

    // ---- NEW v1.8: pack escape hatch clamp (avoid routing pack-noise to LMM) ----
    if (packEscaped(c) && !closeTop2 && !slot2Pull) {
      counts.dropped_pack_escape_not_ambiguity_route_worthy += 1;
      markReviewDrop(c, 'review_drop:pack_escape_not_ambiguity_route_worthy', 'pack_escape_not_ambiguity_route_worthy', {
        review_reason: toStr(c?.review_meta?.review_reason),
      });
      pushBounded(trace.dropped, {
        key,
        reason: 'review_drop:pack_escape_not_ambiguity_route_worthy',
        category: catRaw,
        escaped: true,
        review_reason: toStr(c?.review_meta?.review_reason),
      }, TRACE_CAP);
      continue;
    }

    // ---- Fuzzy near-exact deterministic prune ----
    if (c?.det_fuzzy_near_exact === true && fuzzyOnly && hasTO && !slot2Pull) {
      counts.dropped_fuzzy_near_exact_deterministic += 1;
      markReviewDrop(c, 'review_drop:fuzzy_near_exact_deterministic', 'fuzzy_near_exact_deterministic', {
        review_reason: toStr(c?.review_meta?.review_reason),
      });
      pushBounded(trace.dropped, {
        key,
        reason: 'review_drop:fuzzy_near_exact_deterministic',
        category: catRaw,
        has_title_op: true,
        origins: safeArray(c.origins),
      }, TRACE_CAP);
      continue;
    }

    // ---- RAG_OK confident prune ----
    const si = toStr(c?.storage_intent).toUpperCase();
    const topo = topicalityStrong(c);
    if (si === 'RAG_OK' && hasTO && !slot2Pull) {
      if (topo === true) {
        markReviewDrop(c, 'review_drop:rag_ok_primary_confident_topicality_strong', 'rag_ok_primary_confident_topicality_strong', {
          review_reason: toStr(c?.review_meta?.review_reason),
        });
        counts.dropped_rag_ok_primary_confident_topicality_strong += 1;
        pushBounded(trace.dropped, {
          key,
          reason: 'review_drop:rag_ok_primary_confident_topicality_strong',
          category: catRaw,
          storage_intent: si,
        }, TRACE_CAP);
      } else {
        counts.dropped_rag_ok_primary_confident += 1;
        markReviewDrop(c, 'review_drop:rag_ok_primary_confident', 'rag_ok_primary_confident', {
          review_reason: toStr(c?.review_meta?.review_reason),
        });
        pushBounded(trace.dropped, {
          key,
          reason: 'review_drop:rag_ok_primary_confident',
          category: catRaw,
          storage_intent: si,
          topicality_strong: topo,
        }, TRACE_CAP);
      }
      continue;
    }

    // ---- Alias-only weak slot2 prune ----
    if (c?.det_alias_only_signal === true && slot2Pull && !strongSupport && !closeTop2) {
      counts.dropped_alias_only_weak_slot2 += 1;
      markReviewDrop(c, 'review_drop:alias_only_weak_slot2', 'alias_only_weak_slot2', {
        review_reason: toStr(c?.review_meta?.review_reason),
      });
      pushBounded(trace.dropped, {
        key,
        reason: 'review_drop:alias_only_weak_slot2',
        category: catRaw,
        review_reason: toStr(c?.review_meta?.review_reason),
      }, TRACE_CAP);
      continue;
    }

    // ---- NEW v1.8: comment exact low relevance prune ----
    if (commentOnly && !strongSupport && !closeTop2) {
      const rel = commentExactRelevanceBucket(c);
      if (rel === 'LOW') {
        counts.dropped_comment_exact_low_relevance += 1;
        markReviewDrop(c, 'review_drop:comment_exact_low_relevance', 'comment_exact_low_relevance', {
          review_reason: toStr(c?.review_meta?.review_reason),
        });
        pushBounded(trace.dropped, {
          key,
          reason: 'review_drop:comment_exact_low_relevance',
          category: catRaw,
          relevance: rel,
          review_reason: toStr(c?.review_meta?.review_reason),
        }, TRACE_CAP);
        continue;
      }
    }

    // ---- Hero-scoped contract ----
    if (isHeroScopedCategory(catRaw)) {
      const ownerUnlock = ownerSameSourceUnlock(c) || ownerSecondContext(c);

      if ((os === 'KNOWN' || heroN === 1) && !slot2Pull) {
        counts.dropped_hero_scoped_single_owner_resolved += 1;
        markReviewDrop(c, 'review_drop:hero_scoped_single_owner_resolved', 'hero_scoped_single_owner_resolved', {
          review_reason: toStr(c?.review_meta?.review_reason),
        });
        pushBounded(trace.dropped, {
          key,
          reason: 'review_drop:hero_scoped_single_owner_resolved',
          category: catRaw,
          hero_unique_n: heroN,
          owner_status: os,
          owner_unlock: ownerUnlock,
          has_title_op: hasTO,
          review_reason: toStr(c?.review_meta?.review_reason),
        }, TRACE_CAP);
        continue;
      }

      if ((os === 'UNKNOWN' || (heroN >= 2 && !hasTO)) && !ownerUnlock && !closeTop2) {
        counts.dropped_hero_scoped_weak_without_title_op += 1;
        markReviewDrop(c, 'review_drop:hero_scoped_weak_without_title_op', 'hero_scoped_weak_without_title_op', {
          review_reason: toStr(c?.review_meta?.review_reason),
        });
        pushBounded(trace.dropped, {
          key,
          reason: 'review_drop:hero_scoped_weak_without_title_op',
          category: catRaw,
          hero_unique_n: heroN,
          owner_status: os,
          owner_unlock: ownerUnlock,
          has_title_op: hasTO,
          review_reason: toStr(c?.review_meta?.review_reason),
        }, TRACE_CAP);
        continue;
      }
    }

    // ---- Owner-scope leak suppression ----
    if (isOwnerScopeCategory(catRaw)) {
      const ownerUnlock = ownerSameSourceUnlock(c) || ownerSecondContext(c);

      if (deterministicOwnerBlocked && os !== 'CONFLICT') {
        counts.dropped_owner_scope_deterministically_blocked += 1;
        markReviewDrop(c, 'review_drop:owner_scope_deterministically_blocked', 'owner_scope_deterministically_blocked', {
          review_reason: toStr(c?.review_meta?.review_reason),
        });
        pushBounded(trace.dropped, {
          key,
          reason: 'review_drop:owner_scope_deterministically_blocked',
          category: catRaw,
          owner_status: os,
          owner_unlock: ownerUnlock,
          review_reason: toStr(c?.review_meta?.review_reason),
        }, TRACE_CAP);
        continue;
      }

      if ((os === 'UNKNOWN' || (os === 'NONE' && heroN === 0)) && !ownerUnlock && !strongSupport && !closeTop2) {
        counts.dropped_owner_scope_missing_hero_context += 1;
        markReviewDrop(c, 'review_drop:owner_scope_missing_hero_context', 'owner_scope_missing_hero_context', {
          review_reason: toStr(c?.review_meta?.review_reason),
        });
        pushBounded(trace.dropped, {
          key,
          reason: 'review_drop:owner_scope_missing_hero_context',
          category: catRaw,
          hero_unique_n: heroN,
          owner_status: os,
          owner_unlock: ownerUnlock,
          review_reason: toStr(c?.review_meta?.review_reason),
        }, TRACE_CAP);
        continue;
      }

      if ((os === 'KNOWN' || (heroN < 2 && heroN > 0)) && slot2Pull && !ownerUnlock) {
        counts.dropped_owner_scope_no_competing_owner += 1;
        markReviewDrop(c, 'review_drop:owner_scope_no_competing_owner', 'owner_scope_no_competing_owner', {
          review_reason: toStr(c?.review_meta?.review_reason),
        });
        pushBounded(trace.dropped, {
          key,
          reason: 'review_drop:owner_scope_no_competing_owner',
          category: catRaw,
          hero_unique_n: heroN,
          owner_status: os,
          owner_unlock: ownerUnlock,
          review_reason: toStr(c?.review_meta?.review_reason),
        }, TRACE_CAP);
        continue;
      }
    }

    // ---- Collision deterministic resolution ----
    if (isCollisionSlot2Reason(c)) {
      const slot1 = slot1ByCategory[cat];
      const slot1HasTO = slot1 ? hasTitleOrOpEvidence(safeArray(slot1.evidence)) : false;
      const slot2HasTO = hasTO;

      if (slot1 && slot1HasTO && !slot2HasTO) {
        counts.dropped_collision_slot2_shadowed_by_title_op += 1;
        markReviewDrop(c, 'review_drop:collision_slot2_shadowed_by_title_op', 'collision_slot2_shadowed_by_title_op', {
          review_reason: toStr(c?.review_meta?.review_reason),
        });
        pushBounded(trace.dropped, {
          key,
          reason: 'review_drop:collision_slot2_shadowed_by_title_op',
          category: catRaw,
          slot1_key: stableKey(slot1),
          slot1_has_title_op: slot1HasTO,
          slot2_has_title_op: slot2HasTO,
          review_reason: toStr(c?.review_meta?.review_reason),
        }, TRACE_CAP);
        continue;
      }
    }

    // ---- Fuzzy gates ----
    if (fuzzyOnly && !hasTO && !strongSupport) {
      counts.dropped_fuzzy_only_no_corroboration += 1;
      markReviewDrop(c, 'review_drop:fuzzy_only_no_corroboration', 'fuzzy_only_no_corroboration', {
        review_reason: toStr(c?.review_meta?.review_reason),
      });
      pushBounded(trace.dropped, {
        key,
        reason: 'review_drop:fuzzy_only_no_corroboration',
        category: catRaw,
        origins: safeArray(c.origins),
        equivalence_kind: eqKind,
        has_title_op: hasTO,
        strong_support: strongSupport,
      }, TRACE_CAP);
      continue;
    }

    if (fuzzy && !isFuzzyReviewableCategory(catRaw)) {
      counts.dropped_fuzzy_origin_category_not_reviewable += 1;
      markReviewDrop(c, 'review_drop:fuzzy_origin_category_not_reviewable', 'fuzzy_origin_category_not_reviewable', {
        review_reason: toStr(c?.review_meta?.review_reason),
      });
      pushBounded(trace.dropped, {
        key,
        reason: 'review_drop:fuzzy_origin_category_not_reviewable',
        category: catRaw,
        origins: safeArray(c.origins),
        equivalence_kind: eqKind,
      }, TRACE_CAP);
      continue;
    }

    if (fuzzy && !exact && categoryHasExact[cat] === true) {
      counts.dropped_fuzzy_runner_up_shadow += 1;
      markReviewDrop(c, 'review_drop:fuzzy_runner_up_shadow', 'fuzzy_runner_up_shadow', {
        review_reason: toStr(c?.review_meta?.review_reason),
      });
      pushBounded(trace.dropped, {
        key,
        reason: 'review_drop:fuzzy_runner_up_shadow',
        category: catRaw,
        origins: safeArray(c.origins),
        equivalence_kind: eqKind,
      }, TRACE_CAP);
      continue;
    }

    // ---- Category review parity (old monolith anti-reflag bundle) ----
    const pullTokens = categoryPullReasonTokens(c);
    const flaggedRecoveryTokens = fallbackFlaggedCategoryTokens(c);
    if (flaggedRecoveryTokens.length) {
      counts.fallback_flagged_category_pull_count += 1;
      inc(fallback_flagged_category_pull_by_category, catRaw || 'unknown');
      for (const tok of flaggedRecoveryTokens) inc(fallback_flagged_category_pull_by_reason, tok);
    }
    const detSafeBypass = candidateHasDetSafeReviewBypass(c);
    const lowValuePullOnly = candidateHasLowValueCategoryPullOnly(c);
    const heroHighValuePull = candidateHasHeroHighValueCategorySignal(c);
    const singletonPre = pre.length === 1;
    const categorySingleton = pre.filter(x => categoryKey(x?.category) === cat).length === 1;

    if (multiEntityCoMention && closeTop2 && (cat === 'rank' || cat === 'platform' || cat === 'queue')) {
      counts.dropped_co_mentioned_exact_pair_not_route_worthy += 1;
      addPrune('review_drop:co_mentioned_exact_pair_not_route_worthy', null, {
        key,
        category: catRaw,
        pull_tokens: pullTokens,
        review_reason: toStr(c?.review_meta?.review_reason),
      }, c);
      continue;
    }

    if (detSafeBypass && lowValuePullOnly && !closeTop2) {
      counts.dropped_det_safe_low_value_category_pull += 1;
      addPrune('review_drop:det_safe_low_value_category_pull', null, {
        key,
        category: catRaw,
        pull_tokens: pullTokens,
        storage_intent: toStr(c?.storage_intent),
        review_reason: toStr(c?.review_meta?.review_reason),
      }, c);
      continue;
    }

    if ((cat === 'rank' || cat === 'platform' || cat === 'queue' || cat === 'mode' || cat === 'role') &&
        pullTokens.includes('soft_top_candidate_reviewable_category') &&
        pullTokens.length === 1 &&
        !closeTop2 && !slot2Pull) {
      counts.dropped_soft_top_candidate_not_route_worthy += 1;
      addPrune('review_drop:soft_top_candidate_not_route_worthy', null, {
        key,
        category: catRaw,
        pull_tokens: pullTokens,
        review_reason: toStr(c?.review_meta?.review_reason),
      }, c);
      continue;
    }

    if ((cat === 'hero' || cat === 'map') && commentOnly && !strongSupport && !closeTop2 && !slot2Pull) {
      const lowSignalHeroMap = pullTokens.length === 0 || (!heroHighValuePull && lowValuePullOnly);
      if (lowSignalHeroMap) {
        counts.dropped_low_signal_comment_only_hero_map += 1;
        review_low_signal_hero_map_counts.total += 1;
        inc(review_low_signal_hero_map_counts.by_category, catRaw || 'unknown');
        addPrune('review_drop:low_signal_comment_only_hero_map', null, {
          key,
          category: catRaw,
          pull_tokens: pullTokens,
          review_reason: toStr(c?.review_meta?.review_reason),
        }, c);
        continue;
      }
    }

    if (cat === 'map' && !closeTop2 && categorySingleton && !slot2Pull) {
      const mapLowValue = new Set(['comment_only_top_candidate','soft_top_candidate_reviewable_category','candidate_review_signal']);
      const onlyMapLowValue = pullTokens.length > 0 && pullTokens.every(t => mapLowValue.has(t));
      if (onlyMapLowValue) {
        counts.dropped_map_low_value_category_pull_singleton += 1;
        addPrune('review_drop:map_low_value_category_pull_singleton', null, {
          key,
          category: catRaw,
          pull_tokens: pullTokens,
          review_reason: toStr(c?.review_meta?.review_reason),
        });
        continue;
      }
    }

    if (cat === 'hero' && !closeTop2 && categorySingleton && !slot2Pull) {
      const heroLowValue = new Set(['exact_canonical_not_primary_or_comment_only','top_candidate_flagged_for_review']);
      const onlyHeroLowValue = pullTokens.length > 0 && pullTokens.every(t => heroLowValue.has(t));
      if (onlyHeroLowValue && !heroHighValuePull) {
        counts.dropped_hero_low_value_category_pull_singleton += 1;
        addPrune('review_drop:hero_low_value_category_pull_singleton', null, {
          key,
          category: catRaw,
          pull_tokens: pullTokens,
          review_reason: toStr(c?.review_meta?.review_reason),
        });
        continue;
      }
    }

    // ---- Comment-only / high-risk gates ----
    if (commentOnly && strongSupport) {
      const sensitive = isCommentOnlySensitiveCategory(catRaw);

      if (sensitive) {
        const ok = candidateCorroboratedForSensitiveKeep(c) || closeTop2;
        if (!ok) {
          counts.dropped_comment_only_weak += 1;
          markReviewDrop(c, 'review_drop:comment_only_supported_but_not_corroborated_sensitive', 'comment_only_supported_but_not_corroborated_sensitive', {
            review_reason: toStr(c?.review_meta?.review_reason),
          });
          pushBounded(trace.dropped, {
            key,
            reason: 'review_drop:comment_only_supported_but_not_corroborated_sensitive',
            category: catRaw,
            comment_only: true,
            strong_support: true,
            close_top2: closeTop2,
            independent_evidence_n: getEvidenceSummary(c)?.independent_evidence_n ?? null,
            best_comment_rank: getEvidenceSummary(c)?.best_comment_rank ?? null,
          }, TRACE_CAP);
          continue;
        }
        counts.kept_comment_only_supported_sensitive_corroborated += 1;
      }

      counts.kept_comment_only_supported += 1;
      markReviewKeep(c, sensitive ? 'review_keep:comment_only_supported_sensitive_corroborated' : 'review_keep:comment_only_answer_slot_supported', {
        review_reason: toStr(c?.review_meta?.review_reason),
      });
      pushBounded(trace.kept, {
        key,
        reason: sensitive ? 'review_keep:comment_only_supported_sensitive_corroborated' : 'review_keep:comment_only_answer_slot_supported',
        category: catRaw,
        high_risk: highRisk,
        comment_only: true,
        owner_status: os,
        equivalence_kind: eqKind,
      }, TRACE_CAP);
      out.push(c);
      counts.kept += 1;
      continue;
    }

    if (commentOnly && isCommentOnlySensitiveCategory(catRaw) && !strongSupport && !closeTop2) {
      counts.dropped_comment_only_weak += 1;
      markReviewDrop(c, 'review_drop:comment_only_weak_no_support', 'comment_only_weak_no_support', {
        review_reason: toStr(c?.review_meta?.review_reason),
      });
      pushBounded(trace.dropped, {
        key,
        reason: 'review_drop:comment_only_weak_no_support',
        category: catRaw,
        high_risk: highRisk,
        comment_only: true,
        strong_support: false,
        close_top2: closeTop2,
      }, TRACE_CAP);
      continue;
    }

    if (commentOnly && isCommentOnlySensitiveCategory(catRaw) && isTopPullCommentOnlyReason(c) && !strongSupport) {
      counts.dropped_comment_only_top_pull += 1;
      markReviewDrop(c, 'review_drop:comment_only_top_pull_not_route_worthy', 'comment_only_top_pull_not_route_worthy', {
        review_reason: toStr(c?.review_meta?.review_reason),
      });
      pushBounded(trace.dropped, {
        key,
        reason: 'review_drop:comment_only_top_pull_not_route_worthy',
        category: catRaw,
        high_risk: highRisk,
        comment_only: true,
        strong_support: false,
        close_top2: closeTop2,
        review_reason: toStr(c?.review_meta?.review_reason),
      }, TRACE_CAP);
      continue;
    }

    if (highRisk && !closeTop2) {
      counts.dropped_high_risk_only_no_ambiguity += 1;
      markReviewDrop(c, 'review_drop:high_risk_only_no_ambiguity', 'high_risk_only_no_ambiguity', {
        review_reason: toStr(c?.review_meta?.review_reason),
      });
      pushBounded(trace.dropped, {
        key,
        reason: 'review_drop:high_risk_only_no_ambiguity',
        category: catRaw,
        high_risk: true,
        comment_only: commentOnly,
        strong_support: strongSupport,
        close_top2: closeTop2,
      }, TRACE_CAP);
      continue;
    }

    // Keep (default)
    markReviewKeep(c, 'review_keep:default_pass', {
      review_reason: toStr(c?.review_meta?.review_reason),
    });
    out.push(c);
    counts.kept += 1;

    if (tier3BoostSet.has(key)) {
      counts.kept_tier3_binding_boosted_note += 1;
      pushBounded(trace.kept, {
        key,
        reason: 'review_keep:tier3_binding_boosted_candidate',
        category: catRaw,
        origins: safeArray(c.origins),
        equivalence_kind: eqKind,
        owner_status: os,
      }, TRACE_CAP);
    } else {
      pushBounded(trace.kept, {
        key,
        category: catRaw,
        high_risk: highRisk,
        comment_only: commentOnly,
        origins: safeArray(c.origins),
        equivalence_kind: eqKind,
        intent_requires_context: requiresIntent,
        intent_anchor_present: hasIntentAnchor,
        owner_status: os,
      }, TRACE_CAP);
    }
  }

  if (out.length === 0 && counts.fallback_flagged_category_pull_count > 0) {
    counts.flagged_category_empty_after_selection_count += 1;

    const recoveryPool = safeArray(pre)
      .filter((c) => candidateEligibleForFallbackRecovery(c, closeTop2, strongSupport))
      .sort((a, b) => fallbackRecoveryRank(b) - fallbackRecoveryRank(a));

    if (recoveryPool.length > 0) {
      const recovered = recoveryPool[0];
      markReviewKeep(recovered, 'review_keep:fallback_flagged_category_recovery', {
        review_reason: toStr(recovered?.review_meta?.review_reason),
      });
      out.push(recovered);
      counts.kept += 1;
      counts.flagged_category_recovered_count += 1;
      inc(review_keep_reason_counts, 'review_keep:fallback_flagged_category_recovery');
      inc(review_fallback_recovery_counts, 'review_keep:fallback_flagged_category_recovery');
      const rec = {
        key: stableKey(recovered),
        category: toStr(recovered?.category),
        canonical_slug: toStr(recovered?.canonical_slug),
        review_reason: toStr(recovered?.review_meta?.review_reason),
        pull_tokens: fallbackFlaggedCategoryTokens(recovered),
        det_score: Number.isFinite(Number(recovered?.det_score)) ? Number(recovered.det_score) : null,
        review_drop_reason_primary_before_recovery: toStr(recovered?.review_gating_meta?.review_drop_reason_primary) || null,
      };
      pushBounded(review_fallback_recovery_samples, rec, 12);
      pushBounded(trace.kept, {
        ...rec,
        reason: 'review_keep:fallback_flagged_category_recovery',
      }, TRACE_CAP);
      pushBounded(trace.notes, {
        note: 'review_note:fallback_flagged_category_recovery_applied',
        detail: `recovered ${toStr(recovered?.category)}:${toStr(recovered?.canonical_slug)}`,
      }, TRACE_CAP);
    }
  }

  if (collisionFamilyPresent) {
    const collisionSlot2N = pre.filter(isCollisionSlot2Reason).length;
    if (collisionSlot2N === 0) {
      counts.noted_collision_not_competing += 1;
      pushBounded(trace.notes, {
        note: 'review_note:collision_not_competing',
        detail: 'trigger_families include collision_ambiguous but no slot2_collision_ambiguous candidates in shortlist',
      }, TRACE_CAP);
    }
  }

  if (closeTop2 === true && out.length === 1) {
    counts.noted_close_top2_invalidated_singleton += 1;
    pushBounded(trace.notes, {
      note: 'review_note:close_top2_invalidated_singleton',
      detail: 'close_top2_ambiguity was true pre-gating but shortlist collapsed to singleton after gating',
    }, TRACE_CAP);
  }

  if (closeTop2 === true) {
    const slot2Remaining = out.some(isSlot2Pull);
    if (!slot2Remaining) {
      counts.noted_close_top2_missing_runner_up_post_gating += 1;
      pushBounded(trace.notes, {
        note: 'review_note:close_top2_missing_runner_up_post_gating',
        detail: 'close_top2_ambiguity was true but no slot2 candidates remained after gating; verify upstream triggers',
      }, TRACE_CAP);
    }
  }


  for (const rec of safeArray(trace.dropped)) {
    const reason = toStr(rec?.reason);
    if (!reason.startsWith('review_drop:')) continue;
    inc(review_prune_reason_counts, reason);
    if (review_prune_samples.length < PRUNE_SAMPLE_CAP) review_prune_samples.push(rec);
  }

  for (const rec of safeArray(trace.kept)) {
    const reason = toStr(rec?.reason);
    if (!reason.startsWith('review_keep:')) continue;
    inc(review_keep_reason_counts, reason);
  }

  counts.out_pre = out.length;

  const review_candidate_samples = safeArray(pre).slice(0, 12).map(compactReviewSample);
  const review_shortlist_pre_prune_samples = safeArray(pre).slice(0, 12).map(compactReviewSample);
  const review_shortlist_post_prune_samples = safeArray(out).slice(0, 12).map(compactReviewSample);

  return {
      lmm_review_candidates_pre: out,
      review_candidate_samples,
      review_shortlist_pre_prune_samples,
      review_shortlist_post_prune_samples,
      lmm_review_candidates_pre_count: out.length,
      review_gating_counts: counts,
      review_gating_trace: trace,
      review_prune_reason_counts,
      review_keep_reason_counts,
      review_prune_samples,
      fallback_flagged_category_pull_by_category,
      fallback_flagged_category_pull_by_reason,
      review_fallback_recovery_counts,
      review_fallback_recovery_samples,
      review_low_signal_hero_map_counts,
      equivalence_status_counts,
      intent_evidence_status_counts,
      owner_evidence_status_counts,
      equivalence_samples,
      intent_evidence_samples,
      owner_evidence_samples,
  };
}

module.exports = {
  applyReviewShortlistGatingPatch,
};

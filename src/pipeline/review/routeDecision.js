function isObject(x) { return x && typeof x === 'object' && !Array.isArray(x); }
function safeArray(x) { return Array.isArray(x) ? x : []; }
function toStr(v) { return v === null || v === undefined ? '' : String(v); }
function stableUniqStrings(arr) {
  const out = [];
  const seen = new Set();
  for (const v of safeArray(arr)) {
    const s = toStr(v);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function normSourceType(st) { return toStr(st).trim().toLowerCase(); }

function hasTitleOrOpEvidence(evList) {
  for (const ev of safeArray(evList)) {
    const st = normSourceType(ev?.source_type);
    if (st === 'title' || st === 'op') return true;
  }
  return false;
}

function extractReasonCounts(preReasonCounts) {
  if (!isObject(preReasonCounts)) return {};
  if (isObject(preReasonCounts.counts)) return preReasonCounts.counts;
  const keys = Object.keys(preReasonCounts);
  const looksLikeCounts = keys.some(k => typeof preReasonCounts[k] === 'number');
  return looksLikeCounts ? preReasonCounts : {};
}

function analyzePostReasons(preReasonCounts) {
  const counts = extractReasonCounts(preReasonCounts);
  const keys = Object.keys(counts);

  const has_any_reasons = keys.length > 0;

  let anyNonGlobal = false;
  let anyGlobal = false;

  for (const k of keys) {
    if (k.startsWith('global:')) anyGlobal = true;
    else anyNonGlobal = true;
  }

  const has_non_global = anyNonGlobal;
  const only_global = has_any_reasons && !anyNonGlobal && anyGlobal;

  return { has_any_reasons, has_non_global, only_global, keys, counts };
}

function buildReasonKeyList(preReasonCounts, maxN = 24) {
  const counts = extractReasonCounts(preReasonCounts);
  const entries = Object.entries(counts).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  return entries.slice(0, maxN).map(([k, v]) => ({ k, v }));
}

function getTriggerFamilies(summary) {
  const s = isObject(summary) ? summary : {};
  return safeArray(s.trigger_families).map(toStr);
}

function hasFamily(summary, family) {
  return getTriggerFamilies(summary).includes(toStr(family));
}

function categoryKey(catRaw) { return toStr(catRaw).toLowerCase() || 'unknown'; }

function shortlistHasHeroOrMap(cands) {
  for (const c of safeArray(cands)) {
    const cat = categoryKey(c?.category);
    if (cat === 'hero' || cat === 'map') return true;
  }
  return false;
}

function shortlistHasOwnerScoped(cands) {
  for (const c of safeArray(cands)) {
    const cat = categoryKey(c?.category);
    if (cat === 'ability' || cat === 'perk' || cat === 'role' || cat === 'mode' || cat === 'queue' || cat === 'rank' || cat === 'platform') return true;
  }
  return false;
}

function shortlistHasHeroScoped(cands) {
  for (const c of safeArray(cands)) {
    const cat = categoryKey(c?.category);
    if (cat === 'ability' || cat === 'perk') return true;
  }
  return false;
}

function collectReasons(c) {
  const out = [];
  for (const r of safeArray(c?.reason_codes)) out.push(toStr(r));
  for (const r of safeArray(c?.suppression_reasons)) out.push(toStr(r));
  for (const r of safeArray(c?.storage_reasons)) out.push(toStr(r));
  for (const r of safeArray(c?.review_meta?.reason_codes)) out.push(toStr(r));
  if (c?.review_meta?.review_reason) out.push(toStr(c.review_meta.review_reason));
  return out.filter(Boolean);
}

function categoryPullReasonTokens(c) {
  const out = new Set();
  for (const raw of collectReasons(c)) {
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

function anyDetSafeCategoryBypass(cands) {
  return safeArray(cands).some(c => {
    if (c?.det_safe_blocks_review === true) return true;
    const si = toStr(c?.storage_intent).toUpperCase();
    const es = isObject(c?.evidence_summary) ? c.evidence_summary : null;
    const topo = c?.det_topicality_strong === true || es?.topicality_strong === true;
    if (si === 'RAG_OK' && topo) return true;
    return collectReasons(c).some(r => toStr(r).startsWith('safe_bypass:') || toStr(r).startsWith('allow:deterministic_safe_comment_exact'));
  });
}

function categoryCounts(cands) {
  const out = {};
  for (const c of safeArray(cands)) {
    const cat = categoryKey(c?.category);
    out[cat] = (out[cat] || 0) + 1;
  }
  return out;
}

function stableCandidateKey(c) {
  const cc = isObject(c) ? c : {};
  return `${toStr(cc.category)}||${toStr(cc.canonical_slug)}||${toStr(cc.dictionary_entity_type)}`;
}

function candidateDriverSummary(c) {
  const cc = isObject(c) ? c : {};
  const es = isObject(cc.evidence_summary) ? cc.evidence_summary : {};
  return {
    key: stableCandidateKey(cc),
    category: toStr(cc.category) || '',
    canonical_slug: toStr(cc.canonical_slug) || '',
    dictionary_entity_type: toStr(cc.dictionary_entity_type) || '',
    storage_intent: toStr(cc.storage_intent) || '',
    lane: toStr(cc.det_lane || cc.lane || '') || '',
    selection_reason_primary: toStr(cc.selection_reason_primary) || '',
    suppression_reason_primary: toStr(cc.suppression_reason_primary) || '',
    storage_reason_primary: toStr(cc.storage_reason_primary) || '',
    review_gate_decision: toStr(cc.review_gate_decision) || '',
    review_keep_reason_primary: toStr(cc.review_keep_reason_primary) || '',
    review_drop_reason_primary: toStr(cc.review_drop_reason_primary) || '',
    same_canonical_selected_elsewhere: cc.same_canonical_selected_elsewhere === true,
    reason_codes: safeArray(cc.reason_codes).map(toStr).filter(Boolean).slice(0, 8),
    storage_reasons: safeArray(cc.storage_reasons).map(toStr).filter(Boolean).slice(0, 8),
    review_reason_codes: safeArray(cc?.review_meta?.reason_codes).map(toStr).filter(Boolean).slice(0, 8),
    has_title_op: es.has_title_op === true,
    comment_only: es.comment_only === true,
    best_comment_rank: Number.isFinite(es.best_comment_rank) ? es.best_comment_rank : null,
    evidence_sources: stableUniqStrings(safeArray(cc.evidence).map((ev) => toStr(ev?.source_type).toLowerCase()).filter(Boolean)).slice(0, 4),
  };
}

function buildRouteDriverBundle(preCandidates, postCandidates, maxItems = 5) {
  const pre = safeArray(preCandidates).map(candidateDriverSummary);
  const post = safeArray(postCandidates).map(candidateDriverSummary);

  const blockedKeys = new Set(post.map((c) => c.key));
  const blocked = pre.filter((c) => !blockedKeys.has(c.key)).slice(0, maxItems);
  const actionable = post.slice(0, maxItems);

  return {
    pre: pre.slice(0, maxItems),
    post: post.slice(0, maxItems),
    blocked,
    actionable,
    pre_keys: pre.slice(0, maxItems).map((c) => c.key),
    post_keys: post.slice(0, maxItems).map((c) => c.key),
    blocked_keys: blocked.map((c) => c.key),
    actionable_keys: actionable.map((c) => c.key),
  };
}


function gateReasonFamily(reasonCode) {
  const s = toStr(reasonCode).trim();
  if (!s) return null;
  const idx = s.indexOf(':');
  return idx >= 0 ? s.slice(0, idx) : s;
}

function summarizeGuardHits(gates) {
  const counts = {};
  const samples = [];
  for (const g of safeArray(gates)) {
    if (!g || g.hit !== true) continue;
    const id = toStr(g.id).trim();
    if (!id) continue;
    counts[id] = (counts[id] || 0) + 1;
    if (samples.length < 12) samples.push({ id, block: g.block === true });
  }
  return { counts, samples };
}

function normalizeBlockedBy(reasonCode, routeBlockReasonPrimary, routeBlockReasonFamily, categoryRouteBlockReason) {
  const out = [];
  const reason = toStr(routeBlockReasonPrimary || reasonCode).trim();
  if (reason) {
    out.push({
      reason_code: reason,
      family: toStr(routeBlockReasonFamily).trim() || gateReasonFamily(reason),
      category_route_block_reason: toStr(categoryRouteBlockReason).trim() || null,
    });
  }
  return out;
}

function candidateKeyLabel(c) {
  const cc = isObject(c) ? c : {};
  return {
    key: stableCandidateKey(cc),
    label: toStr(cc.label || cc.display_name || cc.canonical_name || cc.canonical_slug || ''),
    category: toStr(cc.category || ''),
    canonical_slug: toStr(cc.canonical_slug || ''),
    dictionary_entity_type: toStr(cc.dictionary_entity_type || ''),
    storage_intent: toStr(cc.storage_intent || ''),
  };
}

function routeDriverKeptVsBlocked(preCandidates, postCandidates, maxItems = 8) {
  const pre = safeArray(preCandidates);
  const post = safeArray(postCandidates);
  const postKeys = new Set(post.map(stableCandidateKey));
  const blocked = pre.filter((c) => !postKeys.has(stableCandidateKey(c)));
  return {
    pre_n: pre.length,
    kept_n: post.length,
    blocked_n: blocked.length,
    pre_keys: pre.slice(0, maxItems).map((c) => stableCandidateKey(c)),
    kept_keys: post.slice(0, maxItems).map((c) => stableCandidateKey(c)),
    blocked_keys: blocked.slice(0, maxItems).map((c) => stableCandidateKey(c)),
    pre_labels: pre.slice(0, maxItems).map(candidateKeyLabel),
    kept_labels: post.slice(0, maxItems).map(candidateKeyLabel),
    blocked_labels: blocked.slice(0, maxItems).map(candidateKeyLabel),
  };
}

function routeWorthyStrongFamilies(fams, candidatesPre) {
  const baseStrong = new Set([
    'collision_ambiguous',
    'owner_scope_conflict',
    'owner_scope_unknown_needs_review',
    'owner_competing_hero_present',
    'tier3_pair_correction',
    'tier3_context_gap',
  ]);

  const heroMap = shortlistHasHeroOrMap(candidatesPre);
  const ownerScoped = shortlistHasOwnerScoped(candidatesPre);

  const out = [];
  for (const f of safeArray(fams)) {
    if (baseStrong.has(f)) {
      out.push(f);
      continue;
    }

    if ((f === 'tier2_context_gap' || f === 'owner_scope_weak_context') && (ownerScoped || heroMap)) {
      out.push(f);
      continue;
    }

    // fuzzy families are only strong when shortlist includes hero/map
    if (
      heroMap &&
      (f === 'fuzzy_review_recommended' || f === 'fuzzy_equivalence_present')
    ) {
      out.push(f);
      continue;
    }
  }
  return out;
}

function getCloseTop2MinMargin(summary) {
  const s = isObject(summary) ? summary : {};
  const samples = safeArray(s.close_top2_samples);
  let min = null;
  for (const rec of samples) {
    const m = Number(rec?.margin);
    if (!Number.isFinite(m)) continue;
    if (min === null || m < min) min = m;
  }
  return min;
}

function closeTop2ComboAllowsRouting(summary) {
  const s = isObject(summary) ? summary : {};
  const closeTop2 = s.close_top2_ambiguity === true;
  if (!closeTop2) return false;

  const titleOpN = Number(s.pre_shortlist_has_title_op_n ?? 0);
  const minMargin = getCloseTop2MinMargin(s);

  const REQUIRE_TITLE_OP_N = 2;
  const MAX_MARGIN = 0.04;

  return titleOpN >= REQUIRE_TITLE_OP_N && Number.isFinite(minMargin) && minMargin <= MAX_MARGIN;
}

function lowValueCategoryRouteBlock(summary, candidatesPre) {
  const fams = getTriggerFamilies(summary);
  const cats = categoryCounts(candidatesPre);
  const allTokens = new Set();
  for (const c of safeArray(candidatesPre)) {
    for (const t of categoryPullReasonTokens(c)) allTokens.add(t);
  }
  const tokens = Array.from(allTokens);
  const closeTop2 = isObject(summary) && summary.close_top2_ambiguity === true;

  // rank/platform/queue/mode/role soft-top singleton parity
  const ownerLikeCats = ['rank','platform','queue','mode','role'];
  const hasOnlySoftTop = tokens.length === 1 && tokens[0] === 'soft_top_candidate_reviewable_category';
  const hasOwnerLike = ownerLikeCats.some(cat => (cats[cat] || 0) > 0);
  if (hasOwnerLike && hasOnlySoftTop && !closeTop2 && safeArray(candidatesPre).length < 2) {
    return 'block:soft_top_candidate_not_route_worthy';
  }

  // map low-value singleton parity
  if ((cats['map'] || 0) === 1 && !closeTop2) {
    const mapLow = new Set(['comment_only_top_candidate','soft_top_candidate_reviewable_category','candidate_review_signal']);
    if (tokens.length > 0 && tokens.every(t => mapLow.has(t))) return 'block:map_low_value_singleton';
  }

  // hero low-value singleton parity
  if ((cats['hero'] || 0) === 1 && !closeTop2) {
    const heroLow = new Set(['exact_canonical_not_primary_or_comment_only','top_candidate_flagged_for_review']);
    const heroHigh = ['fuzzy_top_without_primary_support','fuzzy_node_review_recommended','fuzzy_alias_rollout_fallback'];
    const onlyHeroLow = tokens.length > 0 && tokens.every(t => heroLow.has(t));
    const hasHeroHigh = heroHigh.some(t => tokens.includes(t));
    if (onlyHeroLow && !hasHeroHigh) return 'block:hero_low_value_singleton';
  }

  if (anyDetSafeCategoryBypass(candidatesPre) && !closeTop2) {
    const low = new Set(['comment_only_top_candidate','soft_top_candidate_reviewable_category','candidate_review_signal','exact_canonical_not_primary_or_comment_only','top_candidate_flagged_for_review']);
    if (tokens.length > 0 && tokens.every(t => low.has(t))) return 'block:det_safe_low_value_category_pull';
  }

  const hasMultiCoMention = fams.includes('multi_entity_co_mention');
  const hasRankPlatformQueue = (cats['rank'] || 0) > 0 || (cats['platform'] || 0) > 0 || (cats['queue'] || 0) > 0;
  if (hasMultiCoMention && closeTop2 && hasRankPlatformQueue) {
    return 'block:co_mentioned_exact_pair_not_route_worthy';
  }

  return null;
}

function nonRouteFlags(summary, reasonAnalysis, candidatesPre, routeWorthy, categoryRouteBlockReason) {
  const s = isObject(summary) ? summary : {};
  const flags = [];

  if (s.high_risk_present === true) flags.push('high_risk_present');
  if (s.shortlist_singleton === true) flags.push('shortlist_singleton');
  if (s.selected_singleton === true) flags.push('selected_singleton');
  if ((s.pre_shortlist_comment_only_n ?? 0) > 0) flags.push('comment_only_present');
  if (reasonAnalysis.only_global) flags.push('only_global_reasons');
  if (safeArray(candidatesPre).length > 0 && safeArray(getTriggerFamilies(s)).length === 0) flags.push('no_trigger_families');
  if (categoryRouteBlockReason) flags.push(categoryRouteBlockReason);
  if (routeWorthy !== true) flags.push('not_route_worthy');

  return flags;
}

function isMapCommentOnlySingleton(summary, candidatesPre) {
  const s = isObject(summary) ? summary : {};
  const singleton = (s.shortlist_singleton === true) || (safeArray(candidatesPre).length === 1);

  if (!singleton) return false;

  const only = safeArray(candidatesPre)[0] || {};
  const cat = toStr(only?.category).toLowerCase();
  if (cat !== 'map') return false;

  const es = isObject(only?.evidence_summary) ? only.evidence_summary : null;
  if (es) {
    const hasTO = es.has_title_op === true;
    const hasComment = es.has_comment === true;
    return (!hasTO && hasComment);
  }

  const ev = safeArray(only?.evidence);
  const hasTO2 = hasTitleOrOpEvidence(ev);
  const hasComment2 = ev.some(e => normSourceType(e?.source_type) === 'comment');
  return (!hasTO2 && hasComment2);
}

function inc(obj, key, by = 1) { obj[key] = (obj[key] || 0) + by; }
function pushBounded(arr, obj, cap) { if (arr.length < cap) arr.push(obj); }

// singleton allow reason
function computeSingletonAllowReason({ strongHits, closeTop2ComboOk }) {
  const strong = safeArray(strongHits);
  if (strong.length > 0) return `singleton_allow:strong_family:${toStr(strong[0])}`;
  if (closeTop2ComboOk === true) return 'singleton_allow:close_top2_combo';
  return null;
}

// v1.5 guards
function anyDetSafeBlocksReview(cands) {
  return safeArray(cands).some(c => c?.det_safe_blocks_review === true);
}

function anyRagOkTopicalityStrong(cands) {
  for (const c of safeArray(cands)) {
    const si = toStr(c?.storage_intent).toUpperCase();
    if (si !== 'RAG_OK') continue;
    const es = isObject(c?.evidence_summary) ? c.evidence_summary : null;
    const topo = (c?.det_topicality_strong === true) || (es?.topicality_strong === true);
    if (topo) return true;
  }
  return false;
}

function anyPackEscape(cands) {
  for (const c of safeArray(cands)) {
    const pm = isObject(c?.pack_meta) ? c.pack_meta : null;
    if (pm?.pack_risky_alias_escaped === true) return true;
  }
  return false;
}

const { evaluateInterpretiveRouteWidening } = require('./interpretiveRouteWidening');

/**
 * @param {object} j - score + slot + gating merged item (post-gate lmm_review_candidates_pre)
 * @returns {object} route authority + telemetry patch for merge
 */
function evaluateRoutePatch(j) {
  j = isObject(j) ? j : {};

  const flagged = j.needs_lmm_review_flagged === true;
  const candidatesPre = safeArray(j.lmm_review_candidates_pre);
  const preCount = candidatesPre.length;

  const summary = isObject(j.review_trigger_summary) ? j.review_trigger_summary : {};
  const preReasonsRaw =
    isObject(j.lmm_review_reason_codes_pre) ? j.lmm_review_reason_codes_pre :
    (isObject(j.lmm_review_reason_codes_pre?.counts) ? j.lmm_review_reason_codes_pre : {});

  const reasonAnalysis = analyzePostReasons(preReasonsRaw);
  const fams = getTriggerFamilies(summary);

  const fuzzyEquivalencePresent = hasFamily(summary, 'fuzzy_equivalence_present');
  const conceptIntentGuardedPresent = hasFamily(summary, 'concept_intent_guarded');
  const ownerScopeUnknownNeedsReviewPresent = hasFamily(summary, 'owner_scope_unknown_needs_review');
  const ownerCompetingHeroPresent = hasFamily(summary, 'owner_competing_hero_present');
  const tier2ContextGapPresent = hasFamily(summary, 'tier2_context_gap');
  const tier3ContextGapPresent = hasFamily(summary, 'tier3_context_gap');
  const ownerScopeWeakContextPresent = hasFamily(summary, 'owner_scope_weak_context');

  const strongHits = routeWorthyStrongFamilies(fams, candidatesPre);
  const hasStrong = strongHits.length > 0;

  const hasCloseTop2 = summary.close_top2_ambiguity === true;
  const closeTop2ComboOk = closeTop2ComboAllowsRouting(summary);

  const routeWorthy = hasStrong || closeTop2ComboOk;
  const categoryRouteBlockReason = lowValueCategoryRouteBlock(summary, candidatesPre);

  const singleton = preCount === 1;

  const singleton_allow_reason = singleton
    ? computeSingletonAllowReason({ strongHits, closeTop2ComboOk })
    : null;

  const singletonAllowed = singleton ? (singleton_allow_reason !== null) : true;

  const mapCommentOnlySingletonBlocked = singleton && isMapCommentOnlySingleton(summary, candidatesPre);

  // v1.5+ guard telemetry
  const route_guard_counts = isObject(j.route_guard_counts) ? j.route_guard_counts : {};
  const route_guard_samples = safeArray(j.route_guard_samples);
  const route_driver_summary = isObject(j.route_driver_summary) ? j.route_driver_summary : { pre_n: 0, post_n: 0, blocked_n: 0, actionable_n: 0 };
  const route_driver_samples = safeArray(j.route_driver_samples);

  const detSafePresent = anyDetSafeBlocksReview(candidatesPre);
  const ragOkTopoStrongPresent = anyRagOkTopicalityStrong(candidatesPre);
  const packEscapePresent = anyPackEscape(candidatesPre);

  if (detSafePresent) inc(route_guard_counts, 'guard:det_safe_blocks_review_present');
  if (ragOkTopoStrongPresent) inc(route_guard_counts, 'guard:rag_ok_topicality_strong_present');
  if (packEscapePresent) inc(route_guard_counts, 'guard:pack_escape_present');

  if (fuzzyEquivalencePresent) inc(route_guard_counts, 'guard:fuzzy_equivalence_present');
  if (conceptIntentGuardedPresent) inc(route_guard_counts, 'guard:concept_intent_guarded_present');
  if (ownerScopeUnknownNeedsReviewPresent) inc(route_guard_counts, 'guard:owner_scope_unknown_needs_review_present');
  if (ownerCompetingHeroPresent) inc(route_guard_counts, 'guard:owner_competing_hero_present');
  if (tier2ContextGapPresent) inc(route_guard_counts, 'guard:tier2_context_gap_present');
  if (tier3ContextGapPresent) inc(route_guard_counts, 'guard:tier3_context_gap_present');
  if (ownerScopeWeakContextPresent) inc(route_guard_counts, 'guard:owner_scope_weak_context_present');
  if (categoryRouteBlockReason) inc(route_guard_counts, `guard:${categoryRouteBlockReason}`);

  if (
    route_guard_samples.length < 12 &&
    (
      detSafePresent ||
      ragOkTopoStrongPresent ||
      packEscapePresent ||
      fuzzyEquivalencePresent ||
      conceptIntentGuardedPresent ||
      ownerScopeUnknownNeedsReviewPresent ||
      ownerCompetingHeroPresent ||
      tier2ContextGapPresent ||
      tier3ContextGapPresent ||
      ownerScopeWeakContextPresent
    )
  ) {
    const only = candidatesPre[0] || {};
    pushBounded(route_guard_samples, {
      post_id: toStr(j.post_id || j.case_id || ''),
      det_safe_present: detSafePresent,
      rag_ok_topicality_strong_present: ragOkTopoStrongPresent,
      pack_escape_present: packEscapePresent,
      fuzzy_equivalence_present: fuzzyEquivalencePresent,
      concept_intent_guarded_present: conceptIntentGuardedPresent,
      owner_scope_unknown_needs_review_present: ownerScopeUnknownNeedsReviewPresent,
      owner_competing_hero_present: ownerCompetingHeroPresent,
      tier2_context_gap_present: tier2ContextGapPresent,
      tier3_context_gap_present: tier3ContextGapPresent,
      owner_scope_weak_context_present: ownerScopeWeakContextPresent,
      category_route_block_reason: categoryRouteBlockReason,
      route_worthy: routeWorthy,
      strong_hits: strongHits.slice(0, 4),
      only_key: `${toStr(only.category)}||${toStr(only.canonical_slug)}||${toStr(only.dictionary_entity_type)}`,
      only_storage_intent: toStr(only.storage_intent),
    }, 12);
  }

  // Gate registry (ordered)
  const gates = [
    { id: 'prune:empty_shortlist', when: () => preCount === 0, block: true },

    // v1.5: det-safe means do not route
    { id: 'prune:det_safe_blocks_review_present', when: () => preCount > 0 && detSafePresent, block: true },

    // only_global is a prune only when NOT route-worthy
    { id: 'prune:only_global_reasons', when: () => preCount > 0 && reasonAnalysis.only_global && !routeWorthy, block: true },

    // singleton must be explicitly allowed
    { id: 'prune:singleton_not_route_worthy', when: () => singleton && !singletonAllowed, block: true },

    { id: 'prune:map_comment_only_singleton', when: () => mapCommentOnlySingletonBlocked, block: true },

    // v1.5: do not route if already deterministically RAG_OK topical unless strong ambiguity
    { id: 'prune:rag_ok_topicality_strong_not_route_worthy', when: () => preCount > 0 && ragOkTopoStrongPresent && !hasStrong, block: true },

    // v1.5: do not route pack escape unless route-worthy
    { id: 'prune:pack_escape_present_not_route_worthy', when: () => preCount > 0 && packEscapePresent && !routeWorthy, block: true },

    // parity: close_top2 alone not sufficient
    { id: 'prune:ambiguity_close_top2_not_route_worthy_alone', when: () => preCount > 0 && hasCloseTop2 && !routeWorthy, block: true },

    { id: categoryRouteBlockReason ? `prune:${categoryRouteBlockReason.replace(/^block:/,'')}` : 'prune:category_review_parity_not_applicable', when: () => preCount > 0 && !!categoryRouteBlockReason, block: true },

    { id: 'prune:no_route_worthy_trigger', when: () => preCount > 0 && !routeWorthy, block: true },
    { id: 'route:evaluated', when: () => true, block: false },
  ];

  let decision = { actionable: false, reason_code: 'prune:empty', blocked_by: null };
  for (const g of gates) {
    if (!g.when()) continue;
    decision = g.block
      ? { actionable: false, reason_code: g.id, blocked_by: g.id }
      : { actionable: true, reason_code: g.id, blocked_by: null };
    break;
  }

  let actionable = decision.actionable === true;
  let interpretive_widening_applied = false;
  let interpretive_widening_family = null;
  let finalCandidates = actionable ? candidatesPre : [];

  if (!actionable) {
    const widen = evaluateInterpretiveRouteWidening(j);
    if (widen) {
      interpretive_widening_applied = true;
      interpretive_widening_family = widen.family;
      actionable = true;
      decision = {
        actionable: true,
        reason_code: `route:interpretive_widening:${widen.family}`,
        blocked_by: null,
      };
      finalCandidates = widen.candidates;
    }
  }

  const route_block_reason_primary = actionable ? null : toStr(decision.reason_code).trim() || null;
  const route_block_reason_family = actionable ? null : gateReasonFamily(route_block_reason_primary);
  const blocked_by = actionable
    ? []
    : normalizeBlockedBy(decision.reason_code, route_block_reason_primary, route_block_reason_family, categoryRouteBlockReason);
  const routeDriverBundle = buildRouteDriverBundle(candidatesPre, finalCandidates, 5);
  const driverKeptVsBlocked = routeDriverKeptVsBlocked(candidatesPre, finalCandidates, 8);

  route_driver_summary.pre_n = preCount;
  route_driver_summary.post_n = finalCandidates.length;
  route_driver_summary.blocked_n = routeDriverBundle.blocked.length;
  route_driver_summary.actionable_n = routeDriverBundle.actionable.length;
  route_driver_summary.route_post_prune_survivor_n = preCount;
  route_driver_summary.route_driver_candidate_n = preCount;
  route_driver_summary.route_blocked_candidate_n = Math.max(0, preCount - finalCandidates.length);

  if (route_driver_samples.length < 12) {
    pushBounded(route_driver_samples, {
      post_id: toStr(j.post_id || j.case_id || ''),
      route_reason_code: toStr(decision.reason_code),
      actionable,
      interpretive_widening_applied: interpretive_widening_applied === true,
      interpretive_widening_family: interpretive_widening_family || null,
      route_worthy: routeWorthy,
      pre_keys: routeDriverBundle.pre_keys,
      post_keys: routeDriverBundle.post_keys,
      blocked_keys: routeDriverBundle.blocked_keys,
      actionable_keys: routeDriverBundle.actionable_keys,
    }, 12);
  }

  const postReasonTop = buildReasonKeyList(preReasonsRaw, 24);

  const gates_trace = gates.map(g => ({
    id: g.id,
    hit: g.when(),
    block: g.block === true,
  })).slice(0, 16);
  const guardHitSummary = summarizeGuardHits(gates_trace);

  // Singleton trace (kept from v1.4)
  const singleton_allow_reason_counts = isObject(j.singleton_allow_reason_counts) ? j.singleton_allow_reason_counts : {};
  const singleton_block_reason_counts = isObject(j.singleton_block_reason_counts) ? j.singleton_block_reason_counts : {};
  const singleton_trace_samples = safeArray(j.singleton_trace_samples);

  if (singleton && singleton_allow_reason) inc(singleton_allow_reason_counts, singleton_allow_reason);
  if (singleton && !singleton_allow_reason) inc(singleton_block_reason_counts, 'singleton_block:no_allow_reason');

  if (singleton_trace_samples.length < 12) {
    const only = candidatesPre[0] || {};
    pushBounded(singleton_trace_samples, {
      post_id: toStr(j.post_id || j.case_id || ''),
      allowed: singletonAllowed,
      singleton_allow_reason,
      route_worthy: routeWorthy,
      strong_hits: strongHits.slice(0, 4),
      close_top2_combo_ok: closeTop2ComboOk,
      map_comment_only_blocked: mapCommentOnlySingletonBlocked,
      only_category: toStr(only.category),
      only_has_title_op: isObject(only.evidence_summary) ? (only.evidence_summary.has_title_op === true) : null,
    }, 12);
  }

  const route_decision = {
    flagged,
    actionable,
    reason_code: decision.reason_code,
    blocked_by,
    route_drop_reason_primary: route_block_reason_primary,
    route_drop_reason_family: route_block_reason_family,

    shortlist_n_pre: preCount,
    shortlist_n_post: finalCandidates.length,
    route_post_prune_survivor_n: preCount,
    route_driver_candidate_n: preCount,
    route_blocked_candidate_n: Math.max(0, preCount - finalCandidates.length),

    trigger_families_all: fams,
    route_worthy_strong_families: strongHits,
    close_top2_ambiguity: hasCloseTop2,
    close_top2_combo_ok: closeTop2ComboOk,
    close_top2_min_margin: getCloseTop2MinMargin(summary),

    route_worthy: routeWorthy === true || interpretive_widening_applied === true,
    interpretive_widening_applied: interpretive_widening_applied === true,
    interpretive_widening_family: interpretive_widening_family || null,
    singleton_allow_reason,
    gates_trace,

    non_route_flags: nonRouteFlags(summary, reasonAnalysis, candidatesPre, routeWorthy, categoryRouteBlockReason),
    post_reason_top: postReasonTop,
    post_reason_counts_dbg: reasonAnalysis.counts || {},
    category_route_block_reason: categoryRouteBlockReason,
    route_driver_candidates_pre: routeDriverBundle.pre,
    route_driver_candidates_post: routeDriverBundle.post,
    blocked_driver_candidates: routeDriverBundle.blocked,
    actionable_driver_candidates: routeDriverBundle.actionable,
    route_driver_keys_pre: routeDriverBundle.pre_keys,
    route_driver_keys_post: routeDriverBundle.post_keys,
    route_driver_kept_vs_blocked_dbg: driverKeptVsBlocked,
    route_guard_hit_counts_dbg: guardHitSummary.counts,
    route_guard_hit_samples_dbg: guardHitSummary.samples,
    route_gates_trace_dbg: gates_trace,
    route_det_safe_block_present: detSafePresent,
    route_route_worthy_trigger_present: routeWorthy === true || interpretive_widening_applied === true,
    route_singleton_candidate_present: singleton,
    route_singleton_candidate_not_worthy: singleton && !singletonAllowed,
    route_rag_ok_topicality_strong_present: ragOkTopoStrongPresent,
    route_category_block_present: !!categoryRouteBlockReason,

    // guard / family echoes
    det_safe_present: detSafePresent,
    rag_ok_topicality_strong_present: ragOkTopoStrongPresent,
    pack_escape_present: packEscapePresent,
    fuzzy_equivalence_present: fuzzyEquivalencePresent,
    concept_intent_guarded_present: conceptIntentGuardedPresent,
    owner_scope_unknown_needs_review_present: ownerScopeUnknownNeedsReviewPresent,
    owner_competing_hero_present: ownerCompetingHeroPresent,
    tier2_context_gap_present: tier2ContextGapPresent,
    tier3_context_gap_present: tier3ContextGapPresent,
    owner_scope_weak_context_present: ownerScopeWeakContextPresent,
  };

  const patch = {
    needs_lmm_review: actionable,
    lmm_review_candidates: finalCandidates,
    lmm_review_candidates_count: finalCandidates.length,
    lmm_review_reason_codes_post: {
      top: postReasonTop,
      counts: reasonAnalysis.counts || {},
      prefix_counts: preReasonsRaw.prefix_counts || {},
    },
    route_decision,

    singleton_allow_reason_counts,
    singleton_block_reason_counts,
    singleton_trace_samples,

    route_guard_counts,
    route_guard_samples,
    route_driver_summary,
    route_driver_samples,
  };
  if (interpretive_widening_applied) {
    patch.lmm_review_candidates_pre = finalCandidates;
    patch.lmm_review_candidates_pre_count = finalCandidates.length;
  }
  return patch;
}

module.exports = {
  evaluateRoutePatch,
};
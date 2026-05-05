// scoreSuppressLane.js
//
// Deterministic authority stage for item-level posture and detection outcome (see
// docs/LANE_AND_STORAGE_POLICY.md): owns scoring, suppression, implementation lanes,
// row-level storage intent, and the explicit NO_DETECTION path when there were no
// candidates to score.
//
// Three layers (do not conflate; see docs/LANE_AND_STORAGE_POLICY.md §17):
//   • Row implementation band — det_lane / det_max_lane per candidate (SHADOW | SOFT | HIGH | HARD).
//     Score-stage strength after caps; not packaged consumer posture. Pairing with minLane/laneFor is
//     frozen score-semantic (same discipline as thresholds/gates), not a casual rename target.
//   • Row storage truth — storage_intent / storage_reasons plus storage_* audit/dbg on each row.
//   • Item posture truth — deterministic_storage_intent (mirrors to packaged posture) and
//     deterministic_detection_outcome === NO_DETECTION only when the normalized candidate set was empty.
//     deterministic_lane (HARD_ELIGIBLE | SOFT_ELIGIBLE | SHADOW) is nested diagnostic / invariant
//     vocabulary derived from selected rows; it is not the §3.1 consumer posture field (use posture).
//
// Consumes normalizeAndResolveCandidates output + policyBundle. Does not mutate entity_candidates_resolved.
// Emits det_selected_pre, det_suppressed_top_pre (n8n/raw parity).

// --- Upstream pipeline modules (this stage consumes their output) ---

const { computeStorageIntentSimple, annotateStorageExplanationBundle } = require('./score/storageIntent');
const { annotateLaneAuditBundle } = require('./score/laneAudit');
const { applyTier3PairSuppression, buildRichSamplePools, buildFullNoneTruthBundle } = require('./score/postProcess');
const {
  applyConservativeRagCentralityDemotions,
  applyHeroPrimaryCardinalityCap,
} = require('./score/ragCentralityDemotions');
const { detectRagCentralityPostShape, buildRagCentralityDebugSummary } = require('./score/ragCentrality');
const {
  annotateSubjecthoodBundle,
  buildPostSubjecthoodSummary,
  buildSubjecthoodAuthoritySummary,
} = require('./score/subjecthood');
const { applySubjectStrengthTierLaneMapping } = require('./score/subjectTierLaneMapping');

// --- Policy primitives + deterministic lane / storage invariants (extracted) ---

const {
  isObject,
  toStr,
  clamp,
  stableKey,
  normalizeLaneName,
  minLane,
  laneFor,
  POLICY_LANE_HARD_ELIGIBLE,
  POLICY_LANE_SOFT_ELIGIBLE,
  POLICY_LANE_SHADOW,
  resolveDeterministicPolicyLaneFromSelected,
  policyStorageIntentInvariantForLane,
  explicitRagCentralityDebugKeys,
} = require('./score/scoreSuppressLanePolicy');

// --- Deterministic item explanation text (extracted) ---

const { buildDeterministicItemExplanation } = require('./score/scoreSuppressLaneExplanation');

// --- Canonical index + storage telemetry helpers (extracted) ---

const {
  buildSelectedCanonicalIndex,
  recomputeSelectedStorageTelemetry,
  annotateSuppressedDropReason,
} = require('./score/scoreSuppressLaneTelemetry');

// --- Per-candidate scoring, gates, and policy-audit mirrors (extracted) ---

const {
  safeArray,
  riskRank,
  rawRiskRank,
  originsHasExact,
  isFuzzyOnly,
  evidenceCount,
  getMetaPolicy,
  packGateIsHardBlock,
  originsHasFuzzy,
  getEquivalence,
  equivalencePassCode,
  ownerContextStrength,
  isStrictOwnerScopeCategory,
  isBroadOwnerScopeCategory,
  ownerSameHeroUnlock,
  ownerHeroTitlePrimary,
  competingHeroTitlePrimary,
  signalCountForAliasDirective,
  getIntentEvidence,
  deriveMatchKind,
  isCorroborated,
  deriveTopicalityStrong,
  deriveCommentExactRelevance,
  normalizeReasonToken,
  conceptNegAnchorReason,
  isSafeBypassCategory,
  exactContextSafeCategoryReason,
  prefixOf,
  hasTitleOrOpEvidence,
  hasCommentEvidence,
  uniqueBoundedStrings,
  annotatePolicyAuditMirrors,
} = require('./score/scoreSuppressLaneCandidateHelpers');

// ---------------------------------------------------------------------------
// Stage-local utilities (used by main loop aggregations; kept here intentionally)
// ---------------------------------------------------------------------------

function inc(obj, key, by = 1) {
  obj[key] = (obj[key] || 0) + 1;
}

function pushBounded(arr, obj, cap) {
  if (arr.length < cap) arr.push(obj);
}

/**
 * Read-only: shallow-clone row and derive per-candidate features used before score, implementation band, and gates.
 * ("Lane" here means row implementation band via laneFor/minLane later — not item posture or packaged posture.)
 * Does not mutate outer stats or candidate lists.
 */
function deriveCandidateLoopFeatures(c0, policyBundle, answerSlotStrongSupport, contradictionPairs, caDirectives) {
  const c = isObject(c0) ? { ...c0 } : {};
  const skey = stableKey(c);

  const ev = safeArray(c.evidence);
  const evN = evidenceCount(ev);
  const es = isObject(c.evidence_summary) ? c.evidence_summary : null;
  const hasTitleOp = es?.has_title_op === true;
  const hasComment = es?.has_comment === true;
  const commentOnly = !hasTitleOp && hasComment;

  const policy = isObject(c.policy) ? c.policy : null;
  const pack = isObject(c.pack_meta) ? c.pack_meta : null;
  const ecs = es?.exact_context_signals || c.exact_context_signals || null;
  const eq = getEquivalence(c, es);
  const intent = getIntentEvidence(c, es);
  const ownerEvidence = c.owner_evidence ?? es?.owner_evidence ?? null;
  const protectedContext = c.protected_context ?? es?.protected_context ?? null;

  const { isCommonWord, isCollision, isOffDomainCollision, risk } = getMetaPolicy(c, policyBundle);

  const origins = safeArray(c.origins);
  const fuzzySim = isObject(c.fuzzy_meta) && Number.isFinite(c.fuzzy_meta.sim) ? c.fuzzy_meta.sim : null;
  const det_match_kind = deriveMatchKind(origins, c.alias_norms, fuzzySim);
  const det_fuzzy_near_exact = Number.isFinite(fuzzySim) && fuzzySim >= 0.9995;
  const aliasNormsN = safeArray(c.alias_norms).length;
  const det_alias_only_signal = aliasNormsN > 0 && !hasTitleOp && commentOnly;

  const corroborated = isCorroborated(es, answerSlotStrongSupport, contradictionPairs);
  const topicalityStrong = deriveTopicalityStrong(es, ev, hasTitleOp);
  const commentRel = deriveCommentExactRelevance(es, commentOnly);
  const fuzzyOnly = isFuzzyOnly(origins);
  const equivalenceKind = toStr(eq?.kind).toUpperCase() || null;
  const equivalencePass = equivalencePassCode(equivalenceKind);

  const strictOwnerScopeRequired = isStrictOwnerScopeCategory(c.category);
  const ownerScopeRequired =
    strictOwnerScopeRequired ||
    (isBroadOwnerScopeCategory(c.category) &&
      (toStr(policy?.tier).toUpperCase() === 'TIER3' || policy?.allow_high_tier_only === true));

  const cad = isObject(caDirectives[skey]) ? caDirectives[skey] : null;
  const requiresMinSignals = Number(cad?.requires_min_signals || 0);
  const directiveBlockRag = cad?.block_rag === true;

  return {
    c,
    skey,
    ev,
    evN,
    es,
    hasTitleOp,
    hasComment,
    commentOnly,
    policy,
    pack,
    ecs,
    eq,
    intent,
    ownerEvidence,
    protectedContext,
    isCommonWord,
    isCollision,
    isOffDomainCollision,
    risk,
    origins,
    fuzzySim,
    det_match_kind,
    det_fuzzy_near_exact,
    aliasNormsN,
    det_alias_only_signal,
    corroborated,
    topicalityStrong,
    commentRel,
    fuzzyOnly,
    equivalenceKind,
    equivalencePass,
    strictOwnerScopeRequired,
    ownerScopeRequired,
    cad,
    requiresMinSignals,
    directiveBlockRag,
  };
}

/**
 * Mutates preamble telemetry only (equivalence / intent / owner-scope / alias-directive), in fixed order per candidate.
 */
function recordCandidateLoopPreambleStats(input, equivalence_stats, intent_gate_stats, owner_scope_stats, alias_directive_stats) {
  const {
    origins,
    skey,
    fuzzyOnly,
    equivalencePass,
    equivalenceKind,
    eq,
    fuzzySim,
    intent,
    ownerEvidence,
    protectedContext,
    ownerScopeRequired,
    cad,
    requiresMinSignals,
    directiveBlockRag,
  } = input;

  if (originsHasFuzzy(origins)) {
    if (fuzzyOnly) equivalence_stats.fuzzy_only_candidates_n += 1;
    if (equivalencePass) inc(equivalence_stats.pass_counts, equivalencePass);
    if (equivalence_stats.samples.length < 10) equivalence_stats.samples.push({ key: skey, kind: equivalenceKind || null, reasons: safeArray(eq?.reasons).slice(0, 4), fuzzy_sim: fuzzySim, fuzzy_only: fuzzyOnly });
  }
  if (intent?.applicable === true) {
    intent_gate_stats.applicable_candidates_n += 1;
    inc(intent_gate_stats.by_anchor_group, normalizeReasonToken(intent.anchor_group || 'concept'));
    if (intent.pass_intent_anchor === true) intent_gate_stats.pass_anchor_n += 1;
    else intent_gate_stats.fail_anchor_n += 1;
    if (intent.pass_negative_anchor_gate === false) intent_gate_stats.neg_anchor_block_n += 1;
    if (intent_gate_stats.samples.length < 10) intent_gate_stats.samples.push({ key: skey, anchor_group: intent.anchor_group || null, pass_intent_anchor: intent.pass_intent_anchor === true, neg_anchor_hits: safeArray(intent.neg_anchor_hits).slice(0, 3), reasons: safeArray(intent.reasons).slice(0, 4) });
  }
  if (ownerScopeRequired) {
    owner_scope_stats.applicable_candidates_n += 1;
    inc(owner_scope_stats.status_counts, toStr(ownerEvidence?.owner_status || 'UNKNOWN').toUpperCase() || 'UNKNOWN');
    if (owner_scope_stats.samples.length < 10) owner_scope_stats.samples.push({ key: skey, owner_status: ownerEvidence?.owner_status || null, owner_same_source_unlock: ownerEvidence?.owner_same_source_unlock === true, owner_same_source_exact_canonical: ownerEvidence?.owner_same_source_exact_canonical === true, owner_second_context: ownerEvidence?.owner_second_context === true, owner_context_strength: ownerContextStrength(ownerEvidence, protectedContext), owner_reasons: safeArray(ownerEvidence?.owner_reasons).slice(0, 4) });
  }
  if (cad) {
    alias_directive_stats.candidates_with_directive_n += 1;
    if (requiresMinSignals > 0) alias_directive_stats.requires_min_signals_n += 1;
    if (directiveBlockRag) alias_directive_stats.block_rag_n += 1;
    if (alias_directive_stats.samples.length < 10) alias_directive_stats.samples.push({ key: skey, requires_min_signals: requiresMinSignals, block_rag: directiveBlockRag, directive_reasons: safeArray(cad?.directive_reasons).slice(0, 4) });
  }
}

function finalizeSuppressedCandidateRow(outCand, suppressedBy, storageIntentCounts, storage_block_reason_counts, suppressed) {
  outCand.det_suppressed_reason = suppressedBy;
  // Raw: suppressed branch does not modify det_score or det_lane; keep already-computed values
  const suppressedStorageReasons = ['storage:none_not_selected'];
  if (suppressedBy === 'suppress:equivalence_failed') suppressedStorageReasons.push('storage:block_equivalence_failed');
  if (suppressedBy === 'suppress:concept_missing_intent_anchor') suppressedStorageReasons.push('storage:block_missing_intent_anchor');
  if (toStr(suppressedBy).startsWith('suppress:concept_neg_anchor_hit:')) {
    const parts = toStr(suppressedBy).split(':');
    suppressedStorageReasons.push(`storage:block_concept_neg_anchor:${parts[2] || 'concept'}`);
  }
  if (suppressedBy === 'suppress:owner_scope_missing_owner') suppressedStorageReasons.push('storage:block_missing_owner_scope');
  if (suppressedBy === 'suppress:owner_scope_conflict_multi_owner') suppressedStorageReasons.push('storage:block_owner_scope_conflict');
  if (suppressedBy === 'suppress:owner_scope_weak_context') suppressedStorageReasons.push('storage:block_owner_scope_weak_context');
  if (suppressedBy === 'suppress:tier2_missing_context') suppressedStorageReasons.push('storage:block_tier2_missing_context');
  if (suppressedBy === 'suppress:tier3_missing_context') suppressedStorageReasons.push('storage:block_tier3_missing_context');

  outCand.storage_intent = 'NONE';
  outCand.storage_reasons = uniqueBoundedStrings(suppressedStorageReasons, 12);
  outCand.selection_reason_primary = '';
  outCand.suppression_reason_primary = toStr(outCand.det_suppressed_reason || '');
  annotateStorageExplanationBundle(outCand);
  annotateLaneAuditBundle(outCand);
  annotatePolicyAuditMirrors(outCand);
  storageIntentCounts.NONE++;
  for (const r of suppressedStorageReasons) {
    if (toStr(r).startsWith('storage:block_')) inc(storage_block_reason_counts, toStr(r));
  }
  suppressed.push(outCand);
}

/**
 * Pure: builds the scored candidate row shell (det_* core + evidence mirrors). Does not run gates or storage.
 * det_lane / det_max_lane are row implementation-band fields, not item posture (see file header three layers).
 * @param {object} p
 */
function buildScoredCandidateShell(p) {
  const {
    c,
    policy,
    es,
    ev,
    pack,
    eq,
    intent,
    ownerEvidence,
    protectedContext,
    ecs,
    cad,
    det_match_kind,
    det_alias_only_signal,
    det_fuzzy_near_exact,
    topicalityStrong,
    commentRel,
    isOffDomainCollision,
    requiresMinSignals,
    directiveBlockRag,
    score,
    lane,
    maxLane,
    equivalenceKind,
    ownerScopeRequired,
  } = p;
  const outCand = {
    category: toStr(c.category),
    canonical_slug: toStr(c.canonical_slug),
    dictionary_entity_type: toStr(c.dictionary_entity_type),
    hero_slug: c.hero_slug ?? null,
    origins: safeArray(c.origins),
    alias_texts: safeArray(c.alias_texts),
    alias_norms: safeArray(c.alias_norms),
    promotion_risk: c.promotion_risk ?? null,
    policy: policy ?? null,
    evidence_summary: es ?? null,
    evidence: ev,
    fuzzy_meta: isObject(c.fuzzy_meta) ? c.fuzzy_meta : null,
    pack_meta: pack ?? null,
    det_match_kind,
    det_alias_only_signal,
    det_fuzzy_near_exact,
    det_topicality_strong: topicalityStrong,
    det_comment_exact_relevance_bucket: commentRel,
    det_off_domain_collision: isOffDomainCollision === true,
    det_alias_directive_requires_min_signals: requiresMinSignals,
    det_alias_directive_block_rag: directiveBlockRag === true,
    det_alias_directive_reasons: safeArray(cad?.directive_reasons).slice(0, 6),
    det_score: score,
    det_lane: lane,
    det_max_lane: maxLane,
  };

  outCand.equivalence = eq || null;
  outCand.intent_evidence = intent || null;
  outCand.owner_evidence = ownerEvidence || null;
  outCand.protected_context = protectedContext || null;
  if (ecs) outCand.exact_context_signals = ecs;

  outCand.det_equivalence_kind = equivalenceKind;
  outCand.det_equivalence_reasons = safeArray(eq?.reasons).slice(0, 6);
  outCand.det_intent_anchor_group = intent?.anchor_group || null;
  outCand.det_intent_pass = intent?.pass_intent_anchor ?? null;
  outCand.det_intent_neg_anchor_hits_n = intent?.neg_anchor_hits_n ?? null;
  outCand.det_owner_scope_required = ownerScopeRequired === true;
  outCand.det_owner_status = ownerEvidence?.owner_status || null;
  outCand.det_owner_context_strength = ownerContextStrength(ownerEvidence, protectedContext);
  outCand.det_owner_title_op_support = ownerEvidence?.owner_title_op_support === true;
  outCand.det_owner_exact_title_op_support = ownerEvidence?.owner_exact_title_op_support === true;
  outCand.det_owner_reasons = safeArray(ownerEvidence?.owner_reasons).slice(0, 6);

  return outCand;
}

/**
 * @param {object} normalizeOutput - output of normalizeAndResolveCandidates
 * @param {object} policyBundle - loadPolicyBundle result
 * @returns {object} upstream + det_selected_pre + det_suppressed_top_pre (matches n8n/raw authority)
 */
function scoreSuppressLane(normalizeOutput, policyBundle) {
  // --- Prologue: validate normalize output and unpack post-level fields ---

  const j = normalizeOutput || {};
  if (!isObject(j.detect) || !toStr(j.post_id)) {
    throw new Error('scoreSuppressLane: expected normalizeAndResolveCandidates output with post_id and detect.');
  }

  const candidates = safeArray(j.entity_candidates_resolved);
  const nrm = isObject(j.normalization_resolution_meta) ? j.normalization_resolution_meta : {};
  const owContextPresent = nrm.ow_context_present === true;

  // --- Normalization metadata: answer-slot corroboration, tier3 bindings, canonical-alias caps ---

  const answerSlot = isObject(nrm.answer_slot) ? nrm.answer_slot : {};
  const answerSlotStrongSupport = answerSlot.answer_slot_strong_support === true;
  const contradictionPairs = Number(answerSlot.answer_slot_contradiction_count || 0) || 0;

  const tier3 = isObject(nrm.tier3) ? nrm.tier3 : {};
  const tier3SuppressSet = new Set(safeArray(tier3.suppress_keys).map(toStr));
  const tier3BoostSet = new Set(safeArray(tier3.boost_keys).map(toStr));
  const TIER3_BOOST_DELTA = 0.1;

  const ca = isObject(nrm.canonical_alias) ? nrm.canonical_alias : {};
  const caSuppressSet = new Set(safeArray(ca.suppress_keys).map(toStr));
  const caLaneCaps = isObject(ca.lane_caps) ? ca.lane_caps : {};
  const caDirectives = isObject(ca.directives) ? ca.directives : {};

  // --- Scoring thresholds and list caps (keep aligned with raw/n8n parity harnesses) ---

  const SELECT_SCORE_MIN = 0.55;
  const FUZZY_SIM_MIN_DEFAULT = 0.86;
  const ALLOW_HIGH_TIER_ONLY_SCORE_MIN = 0.7;
  const TOP_SUPPRESS_N = 18;

  // --- Loop accumulators (counts, bounded samples, gate stats) ---

  const selected = [];
  const suppressed = [];
  const laneCounts = { HARD: 0, HIGH: 0, SOFT: 0, SHADOW: 0 };
  const storageIntentCounts = { RAG_OK: 0, CONTEXT_ONLY: 0, NONE: 0 };
  const selectedReasonCounts = {};
  const suppressedReasonCounts = {};

  const tier3_binding_applied_counts = { suppressed_n: 0, boosted_n: 0 };
  const tier3_binding_applied_samples = [];
  let canonical_alias_lane_cap_applied_n = 0;
  const canonical_alias_lane_cap_applied_samples = [];
  let fuzzy_near_exact_n = 0;
  const fuzzy_near_exact_samples = [];
  let pack_lane_cap_applied_n = 0;
  const pack_lane_cap_applied_samples = [];
  let pack_gate_blocked_n = 0;
  const pack_gate_blocked_samples = [];
  let pack_risky_alias_escaped_n = 0;
  const pack_risky_alias_escaped_samples = [];
  let pack_escape_allow_soft_n = 0;
  const pack_escape_allow_soft_samples = [];
  let topicality_strong_selected_n = 0;
  let topicality_not_strong_selected_n = 0;
  let off_domain_collision_suppressed_n = 0;
  const off_domain_collision_samples = [];
  const storage_block_reason_counts = {};
  const storage_samples = { RAG_OK: [], CONTEXT_ONLY: [], NONE: [] };
  const topicality_samples = { strong: [], not_strong: [] };
  const policy_suppression_counts = {};
  const policy_suppression_samples = [];
  const policy_allow_counts = {};
  const policy_allow_samples = [];
  const tier_gate_selected_counts = {};
  const tier_gate_suppressed_counts = {};
  const tier_gate_samples = [];
  const equivalence_stats = { fuzzy_only_candidates_n: 0, pass_counts: {}, suppressed_failed_n: 0, samples: [] };
  const intent_gate_stats = { applicable_candidates_n: 0, pass_anchor_n: 0, fail_anchor_n: 0, neg_anchor_block_n: 0, by_anchor_group: {}, samples: [] };
  const owner_scope_stats = { applicable_candidates_n: 0, status_counts: {}, suppressed_missing_owner_n: 0, suppressed_conflict_n: 0, samples: [] };
  const alias_directive_stats = { candidates_with_directive_n: 0, requires_min_signals_n: 0, suppressed_missing_signals_n: 0, block_rag_n: 0, samples: [] };
  let det_safe_resolved_n = 0;
  const det_safe_resolved_by_category = {};
  const det_safe_resolved_samples = [];
  let exact_context_safe_selected_n = 0;
  const exact_context_safe_reason_counts = {};
  const exact_context_safe_samples = [];

  const threadPolicy = isObject(j.detect?.thread_policy) ? j.detect.thread_policy : {};
  const tpBroadGeneral = threadPolicy.broad_general === true;
  const tpQuestionAnswerable = threadPolicy.question_answerable === true;
  const tpNewsLike = threadPolicy.news_like === true;

  // Sub-min score band for exact-hero CONTEXT_ONLY rescues (score stage only; storage caps unchanged).
  const SUB_MIN_BROAD_GENERAL_HERO_SCORE_FLOOR = 0.43;
  const SUB_MIN_DOMINANT_HERO_SCORE_FLOOR = 0.5;

  let heroNormN = 0;
  let medOrHighHeroNormN = 0;
  for (const c0 of candidates) {
    if (toStr(c0.category).toLowerCase() !== 'hero') continue;
    heroNormN += 1;
    const { commentRel: crHero } = deriveCandidateLoopFeatures(
      c0,
      policyBundle,
      answerSlotStrongSupport,
      contradictionPairs,
      caDirectives,
    );
    const cr = toStr(crHero).toUpperCase();
    if (cr === 'MED' || cr === 'HIGH') medOrHighHeroNormN += 1;
  }

  /**
   * Narrow score-min bypass: broad_general, non-answerable discussion threads where the obvious hero is
   * exact-canonical, comment-led (no title/op hit), corroborated across comments, HIGH comment relevance,
   * but base score sits just below SELECT_SCORE_MIN (typically missing +0.35 title/op bump). Caps CONTEXT_ONLY
   * via storageIntent (comment_only + !topicality_strong); does not relax RAG_OK gates.
   */
  function passesBroadGeneralCorroboratedHeroCommentHighScoreFloor(p) {
    if (!tpBroadGeneral || tpQuestionAnswerable || tpNewsLike) return false;
    if (toStr(p.c.category).toLowerCase() !== 'hero') return false;
    if (p.commentOnly !== true) return false;
    if (toStr(p.commentRel).toUpperCase() !== 'HIGH') return false;
    if (p.topicalityStrong === true) return false;
    if (p.corroborated !== true) return false;
    if (p.hasExact !== true) return false;
    if (toStr(p.det_match_kind).toUpperCase() !== 'EXACT_CANONICAL') return false;
    // riskRank maps null/unknown promotion_risk to tier 2 (see scoreSuppressLaneCandidateHelpers); only exclude HIGH/RISKY.
    if (p.rr >= 3) return false;
    if (p.isCollision || p.isCommonWord || p.isOffDomainCollision) return false;
    const useExtendedSubMinFloor = heroNormN === 1 && candidates.length === 1;
    const scoreFloor = useExtendedSubMinFloor ? SUB_MIN_BROAD_GENERAL_HERO_SCORE_FLOOR : 0.45;
    if (!Number.isFinite(p.score) || p.score < scoreFloor || p.score >= SELECT_SCORE_MIN) return false;
    return true;
  }

  /**
   * Companion sub-min bypass: exactly one MED-or-HIGH hero among at most two normalized hero rows (the other
   * hero, if any, is comment-grounded but not MED+ — clears two-hero noise without requiring
   * thread_policy.question_answerable, which can be false while direct-subject shape fire). Excludes news-like
   * threads. Uses a higher score floor than the broad_general HIGH-only path so sub-0.50 MED singles stay out.
   * Same CONTEXT_ONLY storage caps via computeStorageIntentSimple.
   */
  function passesDominantHeroMedHighSubMinScoreFloor(p) {
    if (tpNewsLike) return false;
    if (heroNormN > 2 || medOrHighHeroNormN !== 1) return false;
    if (toStr(p.c.category).toLowerCase() !== 'hero') return false;
    if (p.commentOnly !== true) return false;
    const rel = toStr(p.commentRel).toUpperCase();
    if (rel !== 'MED' && rel !== 'HIGH') return false;
    if (p.topicalityStrong === true) return false;
    if (p.corroborated !== true) return false;
    if (p.hasExact !== true) return false;
    if (toStr(p.det_match_kind).toUpperCase() !== 'EXACT_CANONICAL') return false;
    if (p.rr >= 3) return false;
    if (p.isCollision || p.isCommonWord || p.isOffDomainCollision) return false;
    if (!Number.isFinite(p.score) || p.score < SUB_MIN_DOMINANT_HERO_SCORE_FLOOR || p.score >= SELECT_SCORE_MIN) {
      return false;
    }
    return true;
  }

  // --- Tier-gate audit helper (closure over tier_gate_* accumulators) ---

  function noteTierGate(side, code, sk, sampleExtra) {
    if (side === 'selected') inc(tier_gate_selected_counts, code);
    else inc(tier_gate_suppressed_counts, code);
    if (tier_gate_samples.length < 10) tier_gate_samples.push({ key: sk || '', gate: code, ...(sampleExtra || {}) });
  }

  function finalizeSelectedCandidateRow(outCand, fctx) {
    const {
      c,
      skey,
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
      det_match_kind,
      score,
      rr,
      exactSafeTag,
      ecs,
      evN,
    } = fctx;

    outCand.det_selected_reason = 'select:deterministic_pass';
    const itemJsonForStorage = {
      ...j,
      entity_candidates_resolved: candidates,
      candidates_norm: candidates,
    };
    const storage = computeStorageIntentSimple({
      selected: true,
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
      ownerCtxStrength: ownerContextStrength(ownerEvidence, protectedContext),
      category: c.category,
      detMatchKind: det_match_kind,
      candidate: outCand,
      itemJson: itemJsonForStorage,
      score,
    });
    outCand.storage_intent = storage.intent;
    outCand.storage_reasons = uniqueBoundedStrings(storage.reasons, 12);
    outCand.selection_reason_primary = toStr(outCand.det_selected_reason || 'select:deterministic_pass');
    outCand.suppression_reason_primary = '';
    annotateStorageExplanationBundle(outCand);
    storageIntentCounts[storage.intent] = (storageIntentCounts[storage.intent] || 0) + 1;
    for (const r of safeArray(storage.reasons)) {
      if (toStr(r).startsWith('storage:block_')) inc(storage_block_reason_counts, toStr(r));
    }
    pushBounded(storage_samples[storage.intent] || storage_samples.CONTEXT_ONLY, {
      key: skey,
      storage_intent: storage.intent,
      storage_reasons: safeArray(storage.reasons).slice(0, 7),
      lane,
      has_title_op: hasTitleOp,
      comment_only: commentOnly,
      topicality_strong: topicalityStrong,
    }, 10);

    // Row-level safe-resolve tags (audit bypass); distinct from post-loop deterministic_lane / storage intent.
    const catRaw = outCand.category;
    const isBypassCat = isSafeBypassCategory(catRaw);
    const riskIsHigh = rr === 3;
    const ownerSameHero = ownerEvidence?.same_hero_context_unlock === true;
    const ownerTitlePrimary = ownerEvidence?.owner_hero_title_primary === true;
    const competingTitlePrimary = ownerEvidence?.competing_hero_title_primary === true;
    const protectedPass = protectedContext?.pass_protected_context === true || protectedContext?.protected_context === true || protectedContext?.protected_primary === true;
    const heroScopedCommentSafe =
      (toStr(catRaw).toLowerCase() === 'ability' || toStr(catRaw).toLowerCase() === 'perk') &&
      hasExact &&
      ownerSameHero &&
      ownerTitlePrimary &&
      !competingTitlePrimary &&
      (protectedPass || hasTitleOp || ownerEvidence?.owner_title_op_support === true);
    const genericExactContextSafe = !!exactSafeTag && hasExact && !hasTitleOp && !isCollision && !isCommonWord && !isOffDomainCollision && !riskIsHigh && !fuzzyOnly;
    const isSafe =
      (isBypassCat && hasExact && hasTitleOp && !isCollision && !isCommonWord && !isOffDomainCollision && !riskIsHigh) ||
      heroScopedCommentSafe ||
      genericExactContextSafe;
    if (isSafe) {
      outCand.det_safe_resolved = true;
      outCand.det_safe_blocks_review = true;
      outCand.det_safe_tags = heroScopedCommentSafe
        ? ['safe_bypass:hero_scoped_exact_comment_safe']
        : (genericExactContextSafe ? [exactSafeTag] : [`safe_bypass:${toStr(catRaw).toLowerCase()}_exact_titleop`]);
      det_safe_resolved_n += 1;
      const k = toStr(catRaw).toLowerCase();
      det_safe_resolved_by_category[k] = (det_safe_resolved_by_category[k] || 0) + 1;
      if (genericExactContextSafe) {
        exact_context_safe_selected_n += 1;
        inc(exact_context_safe_reason_counts, exactSafeTag);
        pushBounded(exact_context_safe_samples, {
          key: skey,
          category: catRaw,
          canonical_slug: outCand.canonical_slug,
          score: outCand.det_score,
          tag: exactSafeTag,
          comment_only: commentOnly,
          collision_band: ecs?.collision_band || null,
          context_reasons: safeArray(ecs?.reasons).slice(0, 4),
        }, 12);
      }
      if (det_safe_resolved_samples.length < 10) {
        det_safe_resolved_samples.push({
          category: catRaw,
          key: skey,
          score: outCand.det_score,
          tag: outCand.det_safe_tags[0],
          owner_same_hero_context_unlock: ownerSameHero,
          owner_hero_title_primary: ownerTitlePrimary,
          competing_hero_title_primary: competingTitlePrimary,
          exact_context_safe: genericExactContextSafe,
        });
      }
    }

    annotateLaneAuditBundle(outCand);
    annotatePolicyAuditMirrors(outCand);
    if (topicalityStrong) {
      topicality_strong_selected_n += 1;
      pushBounded(topicality_samples.strong, { key: skey, lane, has_title_op: hasTitleOp, ev_n: evN }, 10);
    } else {
      topicality_not_strong_selected_n += 1;
      pushBounded(topicality_samples.not_strong, { key: skey, lane, has_title_op: hasTitleOp, ev_n: evN }, 10);
    }
    selected.push(outCand);
    const reason = outCand.det_selected_reason || 'select:deterministic_pass';
    selectedReasonCounts[reason] = (selectedReasonCounts[reason] || 0) + 1;
  }

  // -------------------------------------------------------------------------
  // Candidate loop (one shallow-cloned row per iteration): read evidence → base
  // score → lane cap → suppression gates → selected vs suppressed partition and
  // row-level storage_intent / storage_reasons on each outCand
  // -------------------------------------------------------------------------

  for (const c0 of candidates) {
    const {
      c,
      skey,
      ev,
      evN,
      es,
      hasTitleOp,
      hasComment,
      commentOnly,
      policy,
      pack,
      ecs,
      eq,
      intent,
      ownerEvidence,
      protectedContext,
      isCommonWord,
      isCollision,
      isOffDomainCollision,
      risk,
      origins,
      fuzzySim,
      det_match_kind,
      det_fuzzy_near_exact,
      aliasNormsN,
      det_alias_only_signal,
      corroborated,
      topicalityStrong,
      commentRel,
      fuzzyOnly,
      equivalenceKind,
      equivalencePass,
      strictOwnerScopeRequired,
      ownerScopeRequired,
      cad,
      requiresMinSignals,
      directiveBlockRag,
    } = deriveCandidateLoopFeatures(c0, policyBundle, answerSlotStrongSupport, contradictionPairs, caDirectives);

    recordCandidateLoopPreambleStats(
      {
        origins,
        skey,
        fuzzyOnly,
        equivalencePass,
        equivalenceKind,
        eq,
        fuzzySim,
        intent,
        ownerEvidence,
        protectedContext,
        ownerScopeRequired,
        cad,
        requiresMinSignals,
        directiveBlockRag,
      },
      equivalence_stats,
      intent_gate_stats,
      owner_scope_stats,
      alias_directive_stats,
    );

    const hasExact = originsHasExact(origins);

    // ---- Base score ----
    let score = 0.35;
    if (hasTitleOp) score += 0.35;
    if (hasComment) score += 0.1;
    score += clamp((evN - 1) * 0.05, 0, 0.15);

    const rr = riskRank(risk);
    if (rr === 3) score -= 0.12;
    else if (rr === 2) score -= 0.06;
    if (isCommonWord) score -= 0.12;
    if (isCollision) score -= 0.1;
    if (isOffDomainCollision) score -= 0.2;
    if (policy?.short_alias === true && !hasTitleOp) score -= 0.08;
    if (policy?.allow_high_tier_only === true) score -= 0.04;

    if (tier3BoostSet.has(skey)) {
      score += TIER3_BOOST_DELTA;
      tier3_binding_applied_counts.boosted_n += 1;
      pushBounded(tier3_binding_applied_samples, { key: skey, action: 'boost', delta: TIER3_BOOST_DELTA }, 12);
    }
    score = clamp(score, 0, 1);

    if (det_fuzzy_near_exact) {
      fuzzy_near_exact_n += 1;
      pushBounded(fuzzy_near_exact_samples, { key: skey, sim: fuzzySim, match_kind: det_match_kind }, 12);
    }

    const exactSafeTag = exactContextSafeCategoryReason(c.category, c.canonical_slug, ecs, score, commentOnly);

    // ---- Lane cap (row implementation band ceiling only) ----
    // LANE_AND_STORAGE_POLICY.md §9: default ceiling is HARD so internal `HARD` is reachable when
    // score >= 0.85 (laneFor). minLane + laneFor are frozen score-semantic helpers: any change to
    // lattice or score cutoffs alters who lands in SHADOW/HARD/etc., not naming-only cleanup.
    // minLane steps cap down for risk/collision/common-word/off-domain, pack, canonical-alias, and owner-weak contexts.
    let maxLane = 'HARD';
    if (rr === 3 || isCommonWord || isCollision || isOffDomainCollision) {
      maxLane = minLane(maxLane, 'HIGH');
    }
    if (pack?.pack_risky_alias_escaped === true) {
      pack_risky_alias_escaped_n += 1;
      const before = maxLane;
      maxLane = minLane(maxLane, 'HIGH');
      pushBounded(pack_risky_alias_escaped_samples, { key: skey, before_max_lane: before, max_lane_after: maxLane, escape_rule: pack.pack_risky_alias_escape_rule || null }, 10);
    }
    const packCap = normalizeLaneName(pack?.max_lane);
    if (packCap) {
      const beforeCap = maxLane;
      maxLane = minLane(maxLane, packCap);
      if (beforeCap !== maxLane) {
        pack_lane_cap_applied_n += 1;
        pushBounded(pack_lane_cap_applied_samples, { key: skey, before: beforeCap, pack_cap: packCap, after: maxLane }, 12);
      }
    }
    const caCap = normalizeLaneName(caLaneCaps[skey]);
    if (caCap) {
      const before = maxLane;
      maxLane = minLane(maxLane, caCap);
      if (before !== maxLane) {
        canonical_alias_lane_cap_applied_n += 1;
        pushBounded(canonical_alias_lane_cap_applied_samples, { key: skey, before, ca_cap: caCap, after: maxLane }, 12);
      }
    }

    if (isStrictOwnerScopeCategory(c.category)) {
      const ownerCtx = ownerContextStrength(ownerEvidence, protectedContext);
      if (ownerCtx === 'WEAK') {
        const before = maxLane;
        maxLane = minLane(maxLane, 'SOFT');
        if (before !== maxLane) pushBounded(canonical_alias_lane_cap_applied_samples, { key: skey, before, ca_cap: 'OWNER_SCOPE_WEAK_CONTEXT', after: maxLane }, 12);
      }
    }

    // Row implementation band for this iteration (becomes det_lane on the emitted row).
    let lane = laneFor(score, maxLane);
    // laneCounts parity: raw node uses rawRiskRank (default 2); we use riskRank (default 0). Recompute lane for counts only.
    const rawRr = rawRiskRank(risk);
    const rawPenalty = rawRr === 3 ? 0.12 : rawRr === 2 ? 0.06 : 0;
    const ourPenalty = rr === 3 ? 0.12 : rr === 2 ? 0.06 : 0;
    const scoreForLaneCounts = score + ourPenalty - rawPenalty;
    const laneForCounts = laneFor(clamp(scoreForLaneCounts, 0, 1), maxLane);
    laneCounts[laneForCounts] = (laneCounts[laneForCounts] || 0) + 1;

    // ---- Suppression gates ----
    let suppressedBy = null;

    if (pack?.pack_gate && packGateIsHardBlock(pack.pack_gate)) {
      suppressedBy = 'suppress:pack_gate_blocked';
      pack_gate_blocked_n += 1;
      pushBounded(pack_gate_blocked_samples, { key: skey, pack_gate: pack.pack_gate }, 12);
    }
    if (!suppressedBy && isOffDomainCollision) {
      suppressedBy = 'suppress:collision_off_domain_denylist';
      off_domain_collision_suppressed_n += 1;
      pushBounded(off_domain_collision_samples, { key: skey, alias_norm: toStr(safeArray(c.alias_norms)[0] || ''), entity_type: toStr(c.dictionary_entity_type) }, 12);
      noteTierGate('suppressed', 'tier_gate:collision_off_domain:fail', skey);
    }

    if (!suppressedBy && fuzzyOnly) {
      if (!equivalencePass) {
        suppressedBy = 'suppress:equivalence_failed';
        equivalence_stats.suppressed_failed_n += 1;
        inc(policy_suppression_counts, suppressedBy);
        pushBounded(policy_suppression_samples, { key: skey, reason: suppressedBy, fuzzy_sim: fuzzySim, equivalence_kind: equivalenceKind, equivalence_reasons: safeArray(eq?.reasons).slice(0, 4) }, 12);
        noteTierGate('suppressed', 'tier_gate:equivalence:fail', skey);
      } else {
        noteTierGate('selected', `tier_gate:equivalence:pass_${normalizeReasonToken(equivalenceKind)}`, skey);
      }
    }

    if (!suppressedBy && intent?.applicable === true) {
      if (intent.pass_negative_anchor_gate === false) {
        suppressedBy = conceptNegAnchorReason(intent);
        inc(policy_suppression_counts, suppressedBy);
        pushBounded(policy_suppression_samples, { key: skey, reason: suppressedBy, anchor_group: intent.anchor_group || null, neg_anchor_hits: safeArray(intent.neg_anchor_hits).slice(0, 4) }, 12);
        noteTierGate('suppressed', `tier_gate:concept_neg_anchor:fail_${normalizeReasonToken(intent.anchor_group || 'concept')}`, skey);
      } else if (intent.pass_intent_anchor === false) {
        suppressedBy = 'suppress:concept_missing_intent_anchor';
        inc(policy_suppression_counts, suppressedBy);
        pushBounded(policy_suppression_samples, { key: skey, reason: suppressedBy, anchor_group: intent.anchor_group || null, requires_ow_context: intent.requires_ow_context === true, ow_context_present: intent.ow_context_present === true, anchor_hits_n: intent?.anchor_hits_n ?? null }, 12);
        noteTierGate('suppressed', `tier_gate:concept_intent:fail_${normalizeReasonToken(intent.anchor_group || 'concept')}`, skey);
      } else {
        noteTierGate('selected', `tier_gate:concept_intent:pass_${normalizeReasonToken(intent.anchor_group || 'concept')}`, skey);
      }
    }

    if (!suppressedBy && ownerScopeRequired) {
      const ownerStatus = toStr(ownerEvidence?.owner_status).toUpperCase();
      const ownerCtx = ownerContextStrength(ownerEvidence, protectedContext);
      const ownerLevel = toStr(ownerEvidence?.owner_required_level || (toStr(policy?.tier).toUpperCase() === 'TIER3' || policy?.allow_high_tier_only === true ? 'TIER3' : 'TIER2')).toUpperCase();
      const ownerProtected = protectedContext?.pass_protected_context === true || protectedContext?.protected_context === true || protectedContext?.protected_primary === true;
      const exactOwnerSupport = ownerEvidence?.owner_exact_title_op_support === true || ownerEvidence?.owner_same_source_exact_canonical === true;
      const ownerTitleOpSupport = ownerEvidence?.owner_title_op_support === true;
      const ownerCompeting = ownerEvidence?.owner_competing_hero_context === true;
      const sameHeroUnlock = ownerSameHeroUnlock(ownerEvidence);
      const ownerTitlePrimary = ownerHeroTitlePrimary(ownerEvidence);
      const competingTitlePrimary = competingHeroTitlePrimary(ownerEvidence);
      const readyTier2 = ownerEvidence?.owner_context_ready_tier2 === true || exactOwnerSupport || ownerProtected || sameHeroUnlock;
      const readyTier3 = ownerEvidence?.owner_context_ready_tier3 === true || exactOwnerSupport || (ownerProtected && ownerEvidence?.owner_second_context === true) || (sameHeroUnlock && ownerTitlePrimary && !competingTitlePrimary);
      if (ownerStatus === 'CONFLICT') {
        suppressedBy = 'suppress:owner_scope_conflict_multi_owner';
        owner_scope_stats.suppressed_conflict_n += 1;
        inc(policy_suppression_counts, suppressedBy);
        pushBounded(policy_suppression_samples, { key: skey, reason: suppressedBy, owner_status: ownerStatus, owner_hero_slugs: safeArray(ownerEvidence?.owner_hero_slugs).slice(0, 4) }, 12);
        noteTierGate('suppressed', 'tier_gate:owner_scope:fail_conflict', skey);
      } else if (ownerStatus !== 'KNOWN' && !ownerProtected && !ownerTitleOpSupport) {
        suppressedBy = 'suppress:owner_scope_missing_owner';
        owner_scope_stats.suppressed_missing_owner_n += 1;
        inc(policy_suppression_counts, suppressedBy);
        pushBounded(policy_suppression_samples, { key: skey, reason: suppressedBy, owner_status: ownerStatus || 'UNKNOWN', owner_same_source_unlock: ownerEvidence?.owner_same_source_unlock === true, owner_same_source_exact_canonical: ownerEvidence?.owner_same_source_exact_canonical === true }, 12);
        noteTierGate('suppressed', 'tier_gate:owner_scope:fail_missing_owner', skey);
      } else if (ownerLevel === 'TIER3' && !readyTier3 && !ownerCompeting) {
        suppressedBy = 'suppress:tier3_missing_context';
        inc(policy_suppression_counts, suppressedBy);
        pushBounded(policy_suppression_samples, { key: skey, reason: suppressedBy, owner_status: ownerStatus, owner_context_strength: ownerCtx, owner_title_op_support: ownerTitleOpSupport }, 12);
        noteTierGate('suppressed', 'tier_gate:owner_scope:fail_tier3_missing_context', skey);
      } else if (ownerLevel === 'TIER2' && !readyTier2 && !ownerCompeting) {
        suppressedBy = 'suppress:tier2_missing_context';
        inc(policy_suppression_counts, suppressedBy);
        pushBounded(policy_suppression_samples, { key: skey, reason: suppressedBy, owner_status: ownerStatus, owner_context_strength: ownerCtx, owner_title_op_support: ownerTitleOpSupport }, 12);
        noteTierGate('suppressed', 'tier_gate:owner_scope:fail_tier2_missing_context', skey);
      } else if (ownerCtx === 'WEAK' && !ownerProtected && !exactOwnerSupport && (!hasTitleOp || ownerLevel === 'TIER3')) {
        suppressedBy = 'suppress:owner_scope_weak_context';
        inc(policy_suppression_counts, suppressedBy);
        pushBounded(policy_suppression_samples, { key: skey, reason: suppressedBy, owner_status: ownerStatus, owner_context_strength: ownerCtx, owner_title_op_support: ownerTitleOpSupport }, 12);
        noteTierGate('suppressed', 'tier_gate:owner_scope:fail_weak_context', skey);
      } else {
        noteTierGate('selected', ownerLevel === 'TIER3' ? 'tier_gate:owner_scope:pass_tier3' : (ownerCtx === 'WEAK' ? 'tier_gate:owner_scope:pass_known_weak' : 'tier_gate:owner_scope:pass_known'), skey);
      }
    }

    if (!suppressedBy && caSuppressSet.has(skey)) {
      suppressedBy = 'suppress:alias_only_weak_prefer_canonical';
    }
    if (!suppressedBy && tier3SuppressSet.has(skey)) {
      suppressedBy = 'suppress:tier3_correction_binding_suppressed';
      tier3_binding_applied_counts.suppressed_n += 1;
      pushBounded(tier3_binding_applied_samples, { key: skey, action: 'suppress' }, 12);
    }
    if (!suppressedBy && policy?.requires_ow_context === true && !owContextPresent) {
      suppressedBy = 'suppress:requires_ow_context_missing';
      inc(policy_suppression_counts, suppressedBy);
      pushBounded(policy_suppression_samples, { key: skey, reason: suppressedBy, tier: policy?.tier || null, has_title_op: hasTitleOp }, 12);
      noteTierGate('suppressed', 'tier_gate:ow_context:fail', skey);
    } else if (policy?.requires_ow_context === true && owContextPresent) {
      noteTierGate('selected', 'tier_gate:ow_context:pass', skey);
    }
    if (!suppressedBy && commentOnly && policy?.comment_only_requires_corroboration === true) {
      if (!corroborated) {
        suppressedBy = 'suppress:comment_only_no_corroboration';
        inc(policy_suppression_counts, suppressedBy);
        pushBounded(policy_suppression_samples, { key: skey, reason: suppressedBy, tier: policy?.tier || null, independent_evidence_n: es?.independent_evidence_n ?? null, best_comment_rank: es?.best_comment_rank ?? null }, 12);
        noteTierGate('suppressed', 'tier_gate:comment_only_corroboration:fail', skey, {
          independent_evidence_n: es?.independent_evidence_n ?? null,
          best_comment_rank: es?.best_comment_rank ?? null,
        });
      } else {
        inc(policy_allow_counts, 'select:comment_only_corroborated');
        pushBounded(policy_allow_samples, { key: skey, reason: 'select:comment_only_corroborated', tier: policy?.tier || null, independent_evidence_n: es?.independent_evidence_n ?? null, best_comment_rank: es?.best_comment_rank ?? null }, 10);
        noteTierGate('selected', 'tier_gate:comment_only_corroboration:pass', skey);
      }
    }
    if (!suppressedBy && commentOnly && !policy) {
      suppressedBy = 'suppress:comment_only_requires_corroboration';
      inc(policy_suppression_counts, suppressedBy);
      pushBounded(policy_suppression_samples, { key: skey, reason: suppressedBy, tier: null }, 12);
      noteTierGate('suppressed', 'tier_gate:policy_missing:comment_only_block', skey);
    }

    if (!suppressedBy && commentOnly && hasExact) {
      if (commentRel === 'LOW') {
        const cat = toStr(c.category).toLowerCase();
        const isHeroOrMap = cat === 'hero' || cat === 'map';
        const escaped = pack?.pack_risky_alias_escaped === true;
        if (escaped && isHeroOrMap) {
          const beforeMaxLane = maxLane;
          maxLane = minLane(maxLane, 'SOFT');
          if (beforeMaxLane !== maxLane) {
            pack_escape_allow_soft_n += 1;
            pushBounded(pack_escape_allow_soft_samples, { key: skey, before_max_lane: beforeMaxLane, after_max_lane: maxLane, reason: 'pack_escape:allow_soft_comment_only_hero_map' }, 12);
          }
          lane = laneFor(score, maxLane);
          noteTierGate('selected', 'tier_gate:comment_exact_relevance:low_allow_soft_pack_escape', skey);
        } else if (exactSafeTag) {
          inc(policy_allow_counts, 'select:exact_context_safe_low_relevance_escape');
          pushBounded(policy_allow_samples, { key: skey, reason: 'select:exact_context_safe_low_relevance_escape', exact_context_safe_tag: exactSafeTag, bucket: commentRel, category: c.category || null }, 10);
          noteTierGate('selected', 'tier_gate:comment_exact_relevance:low_but_exact_context_safe', skey);
        } else {
          suppressedBy = 'suppress:comment_exact_low_relevance';
          inc(policy_suppression_counts, suppressedBy);
          pushBounded(policy_suppression_samples, { key: skey, reason: suppressedBy, bucket: commentRel, best_comment_rank: es?.best_comment_rank ?? null, independent_evidence_n: es?.independent_evidence_n ?? null }, 12);
          noteTierGate('suppressed', 'tier_gate:comment_exact_relevance:fail_low', skey);
        }
      } else if (commentRel === 'MED' || commentRel === 'HIGH') {
        noteTierGate('selected', `tier_gate:comment_exact_relevance:pass_${toStr(commentRel).toLowerCase()}`, skey);
      }
    }

    if (!suppressedBy && policy?.allow_high_tier_only === true) {
      const passesScore = score >= ALLOW_HIGH_TIER_ONLY_SCORE_MIN;
      const passes = passesScore || corroborated;
      if (!passes) {
        suppressedBy = 'suppress:allow_high_tier_only_no_corroboration';
        inc(policy_suppression_counts, suppressedBy);
        pushBounded(policy_suppression_samples, { key: skey, reason: suppressedBy, score, min: ALLOW_HIGH_TIER_ONLY_SCORE_MIN, tier: policy?.tier || null, independent_evidence_n: es?.independent_evidence_n ?? null }, 12);
        noteTierGate('suppressed', 'tier_gate:allow_high_tier_only:fail', skey);
      } else if (!passesScore && corroborated) {
        inc(policy_allow_counts, 'select:allow_high_tier_only_corroborated');
        pushBounded(policy_allow_samples, { key: skey, reason: 'select:allow_high_tier_only_corroborated', tier: policy?.tier || null, score, independent_evidence_n: es?.independent_evidence_n ?? null }, 10);
        noteTierGate('selected', 'tier_gate:allow_high_tier_only:pass_corroborated', skey);
      } else if (passesScore) {
        noteTierGate('selected', 'tier_gate:allow_high_tier_only:pass_score', skey);
      }
    }

    if (!suppressedBy && policy?.short_alias === true && !hasTitleOp) {
      const bestRank = Number.isFinite(es?.best_comment_rank) ? es.best_comment_rank : null;
      const allowShortAlias = corroborated && Number.isFinite(bestRank) && bestRank <= 3;
      if (!allowShortAlias) {
        suppressedBy = 'suppress:short_alias_no_corroboration';
        inc(policy_suppression_counts, suppressedBy);
        pushBounded(policy_suppression_samples, { key: skey, reason: suppressedBy, tier: policy?.tier || null, best_comment_rank: es?.best_comment_rank ?? null, independent_evidence_n: es?.independent_evidence_n ?? null }, 12);
        noteTierGate('suppressed', 'tier_gate:short_alias:fail', skey);
      } else {
        inc(policy_allow_counts, 'select:short_alias_corroborated');
        pushBounded(policy_allow_samples, { key: skey, reason: 'select:short_alias_corroborated', tier: policy?.tier || null, best_comment_rank: bestRank, independent_evidence_n: es?.independent_evidence_n ?? null }, 10);
        noteTierGate('selected', 'tier_gate:short_alias:pass', skey);
      }
    }

    const heroTypoCarveOutEmit = c0?.fuzzy_meta?.hero_typo_carve_out_emit === true;
    if (!suppressedBy && Number.isFinite(fuzzySim) && fuzzySim < FUZZY_SIM_MIN_DEFAULT && !heroTypoCarveOutEmit) {
      suppressedBy = 'suppress:fuzzy_below_min_similarity';
      inc(policy_suppression_counts, suppressedBy);
      pushBounded(policy_suppression_samples, { key: skey, reason: suppressedBy, fuzzy_sim: fuzzySim, min: FUZZY_SIM_MIN_DEFAULT }, 12);
      noteTierGate('suppressed', 'tier_gate:fuzzy_sim:fail', skey);
    } else if (Number.isFinite(fuzzySim)) {
      noteTierGate('selected', 'tier_gate:fuzzy_sim:pass_or_not_applicable', skey);
    }

    if (!suppressedBy && policy?.prefer_canonical_over_alias === true) {
      if (aliasNormsN > 0 && !hasTitleOp && !corroborated) {
        suppressedBy = 'suppress:prefer_canonical_over_alias_no_title_op';
        inc(policy_suppression_counts, suppressedBy);
        pushBounded(policy_suppression_samples, { key: skey, reason: suppressedBy, alias_norms_n: aliasNormsN, tier: policy?.tier || null, independent_evidence_n: es?.independent_evidence_n ?? null, best_comment_rank: es?.best_comment_rank ?? null }, 12);
        noteTierGate('suppressed', 'tier_gate:prefer_canonical_over_alias:fail', skey);
      } else if (aliasNormsN > 0 && !hasTitleOp && corroborated) {
        inc(policy_allow_counts, 'select:prefer_canonical_over_alias_corroborated');
        pushBounded(policy_allow_samples, { key: skey, reason: 'select:prefer_canonical_over_alias_corroborated', alias_norms_n: aliasNormsN, tier: policy?.tier || null }, 10);
        noteTierGate('selected', 'tier_gate:prefer_canonical_over_alias:pass_corroborated', skey);
      }
    }

    if (!suppressedBy && requiresMinSignals > 0) {
      const gotSignals = signalCountForAliasDirective({ hasTitleOp, corroborated, commentOnly, answerSlotStrongSupport });
      if (gotSignals < requiresMinSignals) {
        suppressedBy = 'suppress:tier_directive_missing_signals';
        alias_directive_stats.suppressed_missing_signals_n += 1;
        inc(policy_suppression_counts, suppressedBy);
        pushBounded(policy_suppression_samples, { key: skey, reason: suppressedBy, requires_min_signals: requiresMinSignals, got_signals: gotSignals, has_title_op: hasTitleOp }, 12);
        noteTierGate('suppressed', `tier_gate:alias_directive_signals:fail_req_${requiresMinSignals}_got_${gotSignals}`, skey);
      } else {
        noteTierGate('selected', `tier_gate:alias_directive_signals:pass_req_${requiresMinSignals}_got_${gotSignals}`, skey);
      }
    }

    if (!suppressedBy && score < SELECT_SCORE_MIN) {
      if (exactSafeTag) {
        noteTierGate('selected', 'tier_gate:score_below_min_but_exact_context_safe', skey);
      } else if (
        passesBroadGeneralCorroboratedHeroCommentHighScoreFloor({
          c,
          commentOnly,
          commentRel,
          topicalityStrong,
          corroborated,
          hasExact,
          det_match_kind,
          rr,
          isCollision,
          isCommonWord,
          isOffDomainCollision,
          score,
        })
      ) {
        noteTierGate('selected', 'tier_gate:score_below_min_broad_general_hero_comment_high_corroborated', skey);
      } else if (
        passesDominantHeroMedHighSubMinScoreFloor({
          c,
          commentOnly,
          commentRel,
          topicalityStrong,
          corroborated,
          hasExact,
          det_match_kind,
          rr,
          isCollision,
          isCommonWord,
          isOffDomainCollision,
          score,
        })
      ) {
        noteTierGate('selected', 'tier_gate:score_below_min_dominant_hero_med_high_corroborated', skey);
      } else {
        suppressedBy = 'suppress:score_below_min';
      }
    }

    if (!suppressedBy && (isCollision || isCommonWord) && !hasTitleOp) {
      suppressedBy = 'suppress:ambiguous_alias_without_title_op';
    }

    // SHADOW implementation band => suppressed partition when no other reason; suppress:shadow_lane is a
    // suppression/partition token (implementation-band reasoning), not top-level item posture (RAG_OK/…/RAW_ONLY).
    const goToSuppressed = suppressedBy || lane === 'SHADOW';
    if (goToSuppressed && !suppressedBy) suppressedBy = 'suppress:shadow_lane';

    // n8n uses raw score and lane for both selected and suppressed; no post-hoc demotion.

    // ---- Build output candidate ----
    const outCand = buildScoredCandidateShell({
      c,
      policy,
      es,
      ev,
      pack,
      eq,
      intent,
      ownerEvidence,
      protectedContext,
      ecs,
      cad,
      det_match_kind,
      det_alias_only_signal,
      det_fuzzy_near_exact,
      topicalityStrong,
      commentRel,
      isOffDomainCollision,
      requiresMinSignals,
      directiveBlockRag,
      score,
      lane,
      maxLane,
      equivalenceKind,
      ownerScopeRequired,
    });

    if (goToSuppressed) {
      finalizeSuppressedCandidateRow(outCand, suppressedBy, storageIntentCounts, storage_block_reason_counts, suppressed);
    } else {
      finalizeSelectedCandidateRow(outCand, {
        c,
        skey,
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
        det_match_kind,
        score,
        rr,
        exactSafeTag,
        ecs,
        evN,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Post-loop authority (mutates selected / suppressed ordering and fields;
  // phases run in this order by design)
  // -------------------------------------------------------------------------

  // Post-loop phase 1 — Build selected canonical index; annotate suppressed rows with drop context.
  const selectedCanonicalIndex = buildSelectedCanonicalIndex(selected);
  for (const s of suppressed) annotateSuppressedDropReason(s, selectedCanonicalIndex);

  // Post-loop phase 2 — Sort selected by det_score (stable tie-break via stableKey).
  selected.sort((a, b) => {
    const ds = (b.det_score ?? 0) - (a.det_score ?? 0);
    if (ds !== 0) return ds;
    const ak = stableKey(a);
    const bk = stableKey(b);
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });

  // Post-loop phase 3 — Tier-3 pair suppression (may move rows between partitions).
  const tier3Result = applyTier3PairSuppression({
    selected,
    suppressed,
    contradictionPairs,
    stableKey,
    pushBounded,
    hasTitleOrOpEvidence,
    buildSelectedCanonicalIndex,
    annotateSuppressedDropReason,
  });
  const tier3_pair_suppressed_n = tier3Result.tier3_pair_suppressed_n;
  const tier3_pair_suppressed_samples = tier3Result.tier3_pair_suppressed_samples || [];

  // Post-loop phase 4 — Sort suppressed; slice TOP_SUPPRESS_N for det_suppressed_top_pre.
  suppressed.sort((a, b) => {
    const ds = (b.det_score ?? 0) - (a.det_score ?? 0);
    if (ds !== 0) return ds;
    const ak = stableKey(a);
    const bk = stableKey(b);
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });

  const det_suppressed_top_pre = suppressed.slice(0, TOP_SUPPRESS_N);

  // Post-loop phase 5 — Conservative RAG centrality demotions (full item + selected set).
  const ragDemotionsResult = applyConservativeRagCentralityDemotions(j, selected);
  const rag_centrality_post_shape_dbg = ragDemotionsResult.post_shape;
  const rag_centrality_demotions_n = ragDemotionsResult.demotions_n;
  const rag_centrality_demotions_samples = ragDemotionsResult.demotions_samples;
  let rag_centrality_debug_summary = ragDemotionsResult.debug_summary;

  // Post-loop phase 6 — Subjecthood bundles on every row (selected and suppressed).
  for (const c of selected) annotateSubjecthoodBundle(c, j, selected);
  for (const c of suppressed) annotateSubjecthoodBundle(c, j, selected);

  // Post-loop phase 7 — Subject-strength tier → implementation lane mapping (selected only).
  const subjectStrengthTierRemapResult = applySubjectStrengthTierLaneMapping(selected, j, {
    annotatePolicyAuditMirrors,
  });

  // Post-loop phase 8 — When subject-tier mapping implies title-head RAG, align RAG centrality
  // debug summary with the final selected set (patch only if demotions left dbg_has_entity_title_head false).
  // When subject-tier mapping promotes to RAG_OK, dbg_has_entity_title_head and related fields
  // must reflect final selected. Only patch when original had false (demotions saw 0 RAG_OK).
  const infoPost = detectRagCentralityPostShape(j, selected);
  const hasEntityTitleHeadPost = Number(infoPost?.protected_title_primary_winner_n || 0) > 0;
  const originalHadEntityTitleHead = rag_centrality_debug_summary?.dbg_has_entity_title_head === true;
  if (
    hasEntityTitleHeadPost &&
    !originalHadEntityTitleHead &&
    isObject(rag_centrality_debug_summary)
  ) {
    const heroCapResult = applyHeroPrimaryCardinalityCap(j, selected, infoPost, []);
    const infoMerged = heroCapResult?.info ?? infoPost;
    const summaryPost = buildRagCentralityDebugSummary(j, infoMerged, []);
    rag_centrality_debug_summary.dbg_has_entity_title_head = true;
    rag_centrality_debug_summary.dbg_rag_candidate_n = summaryPost?.dbg_rag_candidate_n ?? 0;
    rag_centrality_debug_summary.dbg_title_primary_trigger_sources =
      safeArray(summaryPost?.dbg_title_primary_trigger_sources).slice(0, 12);
    rag_centrality_debug_summary.dbg_strong_dominant_winner =
      summaryPost?.dbg_strong_dominant_winner === true;
    rag_centrality_debug_summary.dbg_protected_selected_n =
      summaryPost?.dbg_protected_selected_n ?? 0;
    rag_centrality_debug_summary.dbg_protected_selected_title_subject_n =
      summaryPost?.dbg_protected_selected_title_subject_n ?? 0;
    rag_centrality_debug_summary.dbg_protected_selected_title_subject_lock_n =
      summaryPost?.dbg_protected_selected_title_subject_lock_n ?? 0;
    rag_centrality_debug_summary.dbg_protected_selected_direct_subject_n =
      summaryPost?.dbg_protected_selected_direct_subject_n ?? 0;
    rag_centrality_debug_summary.hero_primary_cardinality_dbg =
      summaryPost?.hero_primary_cardinality_dbg ?? null;
    rag_centrality_debug_summary.hero_primary_keep_n_dbg =
      summaryPost?.hero_primary_keep_n_dbg ?? 0;
    rag_centrality_debug_summary.hero_primary_cap_reason_dbg =
      summaryPost?.hero_primary_cap_reason_dbg ?? null;
    rag_centrality_debug_summary.multi_hero_resolver_needed_dbg =
      summaryPost?.multi_hero_resolver_needed_dbg === true;
    rag_centrality_debug_summary.hero_primary_candidates_dbg =
      safeArray(summaryPost?.hero_primary_candidates_dbg).slice(0, 8);
  }

  // Post-loop phase 9 — Recompute storage_intent_counts / storage_samples / blockers from selected
  // after subject-tier mapping (matches raw recount semantics).
  const recomputedSelectedStorage = recomputeSelectedStorageTelemetry(selected);
  storageIntentCounts.RAG_OK = recomputedSelectedStorage.counts.RAG_OK;
  storageIntentCounts.CONTEXT_ONLY = recomputedSelectedStorage.counts.CONTEXT_ONLY;
  storageIntentCounts.NONE = recomputedSelectedStorage.counts.NONE;
  for (const k of Object.keys(storage_block_reason_counts)) delete storage_block_reason_counts[k];
  Object.assign(storage_block_reason_counts, recomputedSelectedStorage.blockers);
  storage_samples.RAG_OK.length = 0;
  storage_samples.CONTEXT_ONLY.length = 0;
  storage_samples.NONE.length = 0;
  storage_samples.RAG_OK.push(...recomputedSelectedStorage.samples.RAG_OK);
  storage_samples.CONTEXT_ONLY.push(...recomputedSelectedStorage.samples.CONTEXT_ONLY);
  storage_samples.NONE.push(...recomputedSelectedStorage.samples.NONE);

  // Post-loop phase 10 — Subjecthood rollups and deterministic sample pools (parity-facing).
  const post_subjecthood_summary = buildPostSubjecthoodSummary(selected);
  const subjecthood_authority_summary_dbg = buildSubjecthoodAuthoritySummary(selected);

  const deterministicSamplePools = buildRichSamplePools(selected, suppressed, TOP_SUPPRESS_N, annotatePolicyAuditMirrors);
  const fullNoneTruthBundle = buildFullNoneTruthBundle(selected, suppressed);

  // Post-loop phase 11 — Aggregate reason prefixes and storage-audit families (selected + top suppressed).
  const reason_prefix_selected_counts = {};
  const reason_prefix_suppressed_counts = {};
  const storage_decision_family_counts = {};
  const storage_blocker_family_counts = {};
  const storage_promotion_path_counts = {};
  for (const s of selected) {
    inc(reason_prefix_selected_counts, prefixOf(s.det_selected_reason || 'select:deterministic_pass'));
    const decisionFam = toStr(s.storage_decision_family);
    const blockerFam = toStr(s.storage_blocker_family);
    if (decisionFam) inc(storage_decision_family_counts, decisionFam);
    if (blockerFam) inc(storage_blocker_family_counts, blockerFam);
    for (const p of safeArray(s.storage_promotion_path_dbg).map(toStr).filter(Boolean))
      inc(storage_promotion_path_counts, p);
  }
  for (const s of det_suppressed_top_pre) {
    inc(suppressedReasonCounts, toStr(s.det_suppressed_reason || 'suppress:unknown'));
    inc(reason_prefix_suppressed_counts, prefixOf(s.det_suppressed_reason || 'suppress:unknown'));
    const decisionFam = toStr(s.storage_decision_family);
    const blockerFam = toStr(s.storage_blocker_family);
    if (decisionFam) inc(storage_decision_family_counts, decisionFam);
    if (blockerFam) inc(storage_blocker_family_counts, blockerFam);
    for (const p of safeArray(s.storage_promotion_path_dbg).map(toStr).filter(Boolean))
      inc(storage_promotion_path_counts, p);
  }

  // -------------------------------------------------------------------------
  // Aggregate build: det_counts_pre (numeric snapshot) and score_suppress_lane_meta
  // (nested debug + sample payloads for harnesses)
  // -------------------------------------------------------------------------

  const det_counts_pre = {
    candidates_norm_n: candidates.length,
    det_selected_pre_n: selected.length,
    det_suppressed_pre_n: suppressed.length,
    det_suppressed_top_pre_n: det_suppressed_top_pre.length,
    tier3_pair_suppressed_n,
    det_safe_resolved_n,
    exact_context_safe_selected_n,
    policy_suppression_total_n: Object.values(policy_suppression_counts).reduce((a, b) => a + (b || 0), 0),
    policy_allow_total_n: Object.values(policy_allow_counts).reduce((a, b) => a + (b || 0), 0),
    storage_intent_counts: storageIntentCounts,
    pack_lane_cap_applied_n,
    pack_strength_cap_applied_n: pack_lane_cap_applied_n,
    pack_gate_blocked_n,
    pack_risky_alias_escaped_n,
    pack_escape_allow_soft_n,
    fuzzy_near_exact_n,
    tier3_binding_applied_counts,
    canonical_alias_lane_cap_applied_n,
    canonical_alias_strength_cap_applied_n: canonical_alias_lane_cap_applied_n,
    topicality_strong_selected_n,
    topicality_not_strong_selected_n,
    off_domain_collision_suppressed_n,
    alias_directive_candidates_with_directive_n: alias_directive_stats.candidates_with_directive_n,
    alias_directive_requires_min_signals_n: alias_directive_stats.requires_min_signals_n,
    alias_directive_suppressed_missing_signals_n: alias_directive_stats.suppressed_missing_signals_n,
    alias_directive_block_rag_n: alias_directive_stats.block_rag_n,
    equivalence_fuzzy_only_candidates_n: equivalence_stats.fuzzy_only_candidates_n,
    equivalence_suppressed_failed_n: equivalence_stats.suppressed_failed_n,
    intent_applicable_candidates_n: intent_gate_stats.applicable_candidates_n,
    intent_fail_anchor_n: intent_gate_stats.fail_anchor_n,
    intent_neg_anchor_block_n: intent_gate_stats.neg_anchor_block_n,
    owner_scope_applicable_candidates_n: owner_scope_stats.applicable_candidates_n,
    owner_scope_suppressed_missing_owner_n: owner_scope_stats.suppressed_missing_owner_n,
    owner_scope_suppressed_conflict_n: owner_scope_stats.suppressed_conflict_n,
  };

  const score_suppress_lane_meta = {
    counts: { ...det_counts_pre, storage_intent_counts: storageIntentCounts },
    det_counts_pre,
    selected_reason_counts: selectedReasonCounts,
    suppressed_reason_counts: suppressedReasonCounts,
    implementation_band_counts: laneCounts,
    det_selected_pre_samples: deterministicSamplePools.det_selected_pre_samples,
    det_suppressed_top_pre_samples: deterministicSamplePools.det_suppressed_top_pre_samples,
    storage_block_reason_counts,
    storage_samples,
    topicality_samples,
    rag_centrality_post_shape_dbg,
    rag_centrality_demotions_n,
    rag_centrality_demotions_samples,
    rag_centrality_debug_summary,
    subject_strength_tier_lane_remap_changed: subjectStrengthTierRemapResult.changed === true,
    subject_tier_lane_mapping_live: subjectStrengthTierRemapResult.live === true,
    post_subjecthood_summary,
    subjecthood_authority_summary_dbg,
    ...fullNoneTruthBundle,
  };

  // -------------------------------------------------------------------------
  // Item-level deterministic truth (posture authority): deterministic_storage_intent → packaged posture;
  // deterministic_lane is diagnostic/invariant class (HARD_ELIGIBLE / …), not consumer posture.
  // Invariant violation + human-readable explanation: see LANE_AND_STORAGE_POLICY.md §17 three layers.
  // -------------------------------------------------------------------------

  const postIdForInvariant = j.post_id ?? j.id ?? null;
  let deterministic_policy_invariant_violation = null;
  let deterministic_lane = null;
  let deterministic_storage_intent = null;

  if (selected.length > 0) {
    const laneResolution = resolveDeterministicPolicyLaneFromSelected(selected, postIdForInvariant);
    if (!laneResolution.violation && laneResolution.policyLane != null) {
      deterministic_lane = laneResolution.policyLane;
      deterministic_storage_intent = policyStorageIntentInvariantForLane(deterministic_lane);
      // LANE_AND_STORAGE_POLICY.md — item posture must match strongest storage actually present on
      // selected rows (final storage_intent_counts). det_lane alone can still read HARD after
      // row-level storage was downgraded to all CONTEXT_ONLY; do not claim HARD_ELIGIBLE/RAG_OK then.
      if (
        deterministic_lane === POLICY_LANE_HARD_ELIGIBLE &&
        Number(storageIntentCounts.RAG_OK || 0) === 0
      ) {
        deterministic_lane = POLICY_LANE_SOFT_ELIGIBLE;
        deterministic_storage_intent = policyStorageIntentInvariantForLane(POLICY_LANE_SOFT_ELIGIBLE);
      }
      // Final selected-row storage truth can sit above implementation band after post-loop (subject-tier
      // RAG_OK, protected HIGH-lane paths): det_lane is unchanged but storage_intent recount can show
      // RAG_OK. Symmetric to the downgrade above — item posture must follow that recount, not band alone.
      if (Number(storageIntentCounts.RAG_OK || 0) > 0) {
        deterministic_lane = POLICY_LANE_HARD_ELIGIBLE;
        deterministic_storage_intent = policyStorageIntentInvariantForLane(POLICY_LANE_HARD_ELIGIBLE);
      }
    } else if (laneResolution.violation) {
      deterministic_policy_invariant_violation = laneResolution.violation;
    }
  } else if (suppressed.length > 0) {
    deterministic_lane = POLICY_LANE_SHADOW;
    deterministic_storage_intent = policyStorageIntentInvariantForLane(POLICY_LANE_SHADOW);
  }

  if (
    candidates.length > 0 &&
    selected.length === 0 &&
    suppressed.length === 0 &&
    deterministic_policy_invariant_violation == null
  ) {
    deterministic_policy_invariant_violation = {
      code: 'DETERMINISTIC_CANDIDATES_NOT_PARTITIONED',
      message:
        'candidates_norm_n > 0 but no rows were placed in selected or suppressed — scoring loop invariant broken.',
      post_id: postIdForInvariant != null ? toStr(postIdForInvariant) : null,
    };
  }

  const deterministic_item_explanation = buildDeterministicItemExplanation({
    post_id: postIdForInvariant,
    candidates_norm_n: candidates.length,
    det_selected_pre_n: selected.length,
    det_suppressed_pre_n: suppressed.length,
    deterministic_lane,
    deterministic_storage_intent,
    deterministic_policy_invariant_violation,
    selected_reason_counts: selectedReasonCounts,
    suppressed_reason_counts: suppressedReasonCounts,
  });

  // NO_DETECTION only when no candidates entered this stage — not "all rows suppressed" (candidate-present RAW_ONLY may still apply).
  const deterministic_detection_outcome = candidates.length === 0 ? 'NO_DETECTION' : null;

  // Return shape: strip resolved candidate streams from the normalize payload, then spread the rest
  // and append det_* / deterministic_* / telemetry keys (n8n + score-raw-parity contract).
  const { entity_candidates_resolved: _ecr, normalization_resolution_meta: _nrm, ...passThrough } = j;
  return {
    ...passThrough,
    deterministic_detection_outcome,
    deterministic_lane,
    deterministic_storage_intent,
    deterministic_policy_invariant_violation,
    deterministic_item_explanation,
    det_selected_pre: selected,
    det_suppressed_top_pre,
    det_counts_pre,
    canonical_alias_lane_cap_applied_n,
    canonical_alias_lane_cap_applied_samples,
    canonical_alias_strength_cap_applied_n: canonical_alias_lane_cap_applied_n,
    canonical_alias_strength_cap_applied_samples: canonical_alias_lane_cap_applied_samples,
    canonical_alias_resolution_counts: {},
    canonical_alias_resolution_samples: [],
    det_selected_pre_reason_counts: selectedReasonCounts,
    det_suppressed_top_pre_reason_counts: suppressedReasonCounts,
    reason_prefix_selected_counts,
    reason_prefix_suppressed_counts,
    storage_decision_family_counts,
    storage_blocker_family_counts,
    storage_promotion_path_counts,
    tier_gate_selected_counts,
    tier_gate_suppressed_counts,
    tier_gate_samples,
    // merge_score_counts.implementation_band_counts: histogram of row implementation band (HARD/HIGH/SOFT/SHADOW);
    // (Former key lane_counts; duplicate implementation_strength_counts was removed earlier.)
    merge_score_counts: {
      implementation_band_counts: laneCounts,
    },
    tier3_pair_suppressed_n,
    tier3_pair_suppressed_samples,
    tier3_binding_applied_counts,
    tier3_binding_applied_samples,
    det_selected_pre_samples: deterministicSamplePools.det_selected_pre_samples,
    det_suppressed_top_pre_samples: deterministicSamplePools.det_suppressed_top_pre_samples,
    rag_ok_samples: deterministicSamplePools.rag_ok_samples,
    context_only_samples: deterministicSamplePools.context_only_samples,
    shadow_or_none_samples: deterministicSamplePools.shadow_or_none_samples,
    storage_selected_samples: deterministicSamplePools.storage_selected_samples,
    storage_context_only_samples: deterministicSamplePools.storage_context_only_samples,
    storage_none_samples: deterministicSamplePools.storage_none_samples,
    det_safe_resolved_n,
    det_safe_resolved_by_category,
    det_safe_resolved_samples,
    exact_context_safe_selected_n,
    exact_context_safe_reason_counts,
    exact_context_safe_samples,
    policy_suppression_counts,
    policy_suppression_samples,
    policy_allow_counts,
    policy_allow_samples,
    pack_lane_cap_applied_n,
    pack_lane_cap_applied_samples,
    pack_strength_cap_applied_n: pack_lane_cap_applied_n,
    pack_strength_cap_applied_samples: pack_lane_cap_applied_samples,
    pack_gate_blocked_n,
    pack_gate_blocked_samples,
    pack_risky_alias_escaped_n,
    pack_risky_alias_escaped_samples,
    pack_escape_allow_soft_n,
    pack_escape_allow_soft_samples,
    storage_intent_counts: storageIntentCounts,
    storage_block_reason_counts,
    storage_samples,
    topicality_samples,
    equivalence_stats,
    alias_directive_stats,
    intent_gate_stats,
    owner_scope_stats,
    fuzzy_near_exact_n,
    fuzzy_near_exact_samples,
    off_domain_collision_samples,
    rag_centrality_post_shape_dbg,
    rag_centrality_demotions_n,
    rag_centrality_demotions_samples,
    rag_centrality_debug_summary,
    ...(explicitRagCentralityDebugKeys(rag_centrality_debug_summary)),
    subject_strength_tier_lane_remap_changed: subjectStrengthTierRemapResult.changed === true,
    subject_tier_lane_mapping_live: subjectStrengthTierRemapResult.live === true,
    post_subjecthood_summary,
    ...(isObject(post_subjecthood_summary) ? post_subjecthood_summary : {}),
    subjecthood_authority_summary_dbg,
    ...fullNoneTruthBundle,
  };
}

module.exports = {
  scoreSuppressLane,
};

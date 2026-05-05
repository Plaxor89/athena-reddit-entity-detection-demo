// scoreSuppressLaneCandidateHelpers.js — per-candidate scoring, gates, and row annotation used in the main loop.
// Extracted from scoreSuppressLane.js (structure only; behavior frozen).

const { isObject, toStr } = require('./scoreSuppressLanePolicy');

function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

function riskRank(risk) {
  const r = toStr(risk).toUpperCase();
  if (r === 'HIGH' || r === 'RISKY') return 3;
  if (r === 'MEDIUM' || r === 'MED') return 2;
  if (r === 'LOW') return 1;
  return 2;
}

/** Raw node default: return 2 for unknown risk (used only for laneCounts parity). */
function rawRiskRank(risk) {
  const r = toStr(risk).toUpperCase();
  if (r === 'LOW') return 1;
  if (r === 'MEDIUM' || r === 'MED') return 2;
  if (r === 'HIGH' || r === 'RISKY') return 3;
  return 2;
}

function originsHasExact(origins) {
  return safeArray(origins).map(toStr).includes('exact');
}

function isFuzzyOnly(origins) {
  const s = new Set(safeArray(origins).map(toStr));
  return s.has('fuzzy') && !s.has('exact');
}

function evidenceCount(ev) {
  return safeArray(ev).length;
}

function normToken(s) {
  return toStr(s)
    .toLowerCase()
    .normalize('NFKC')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getMetaPolicy(candidate, policyBundle) {
  const pm = isObject(policyBundle?.policyMeta) ? policyBundle.policyMeta : {};
  const aliasNorms = safeArray(candidate.alias_norms);
  const primaryAliasNorm = toStr(aliasNorms[0] || '');
  const primaryNorm = normToken(primaryAliasNorm);

  const commonWordArr = safeArray(pm.common_word_alias_norms);
  const commonWordSet = new Set(commonWordArr.map((x) => normToken(x)).filter(Boolean));
  const isCommonWord = primaryNorm && commonWordSet.has(primaryNorm);

  let isCollision = false;
  const collisions = isObject(pm.alias_collision_registry) ? pm.alias_collision_registry : {};
  const et = toStr(candidate.dictionary_entity_type);
  if (et && isObject(collisions[et]) && primaryNorm && collisions[et][primaryNorm]) isCollision = true;
  if (!isCollision && primaryNorm && collisions[primaryNorm]) isCollision = true;

  const offDomainArr = safeArray(pm.off_domain_collision_alias_norms);
  const offDomainSet = new Set(offDomainArr.map((x) => normToken(x)).filter(Boolean));
  const fallbackOffDomain = new Set([
    'master chief', 'masterchief', 'halo', 'spartan', 'skyrim', 'dragonborn',
    'call of duty', 'cod', 'valorant', 'apex', 'fortnite',
  ]);
  const isOffDomainCollision = primaryNorm
    ? offDomainSet.has(primaryNorm) || fallbackOffDomain.has(primaryNorm)
    : false;

  const risk = toStr(candidate.promotion_risk || '').toUpperCase() || null;
  return { isCommonWord, isCollision, isOffDomainCollision, risk };
}

function packGateIsHardBlock(gate) {
  const g = toStr(gate).trim().toLowerCase();
  if (!g) return false;
  return g.includes('deny') || g.includes('block') || g.includes('reject');
}

function originsHasFuzzy(origins) {
  return safeArray(origins).map(toStr).includes('fuzzy');
}

function getEquivalence(c, es) {
  if (c?.equivalence && typeof c.equivalence === 'object' && !Array.isArray(c.equivalence)) return c.equivalence;
  if (es?.equivalence && typeof es.equivalence === 'object' && !Array.isArray(es.equivalence)) return es.equivalence;
  return null;
}

function equivalencePassCode(kindRaw) {
  const k = toStr(kindRaw).toUpperCase();
  if (k === 'NORM_EQ') return 'equivalence:pass_norm_eq';
  if (k === 'EDITDIST_EQ') return 'equivalence:pass_editdist_eq';
  if (k === 'DISAMBIGUATOR_EQ') return 'equivalence:pass_disambiguator_eq';
  return null;
}

function ownerContextStrength(ownerEvidence, protectedContext) {
  const raw = toStr(ownerEvidence?.owner_context_strength).toUpperCase();
  if (raw === 'STRONG' || raw === 'MEDIUM' || raw === 'WEAK' || raw === 'CONFLICT') return raw;
  if (
    protectedContext?.protected_exact_context === true ||
    protectedContext?.protected_context === true ||
    protectedContext?.pass_protected_context === true ||
    ownerEvidence?.owner_exact_title_op_support === true
  ) return 'STRONG';
  if (
    ownerEvidence?.owner_same_source_unlock === true ||
    ownerEvidence?.owner_second_context === true ||
    ownerEvidence?.owner_title_op_support === true ||
    protectedContext?.protected_title_op_context === true
  ) return 'MEDIUM';
  return 'WEAK';
}

function isStrictOwnerScopeCategory(catRaw) {
  const c = toStr(catRaw).toLowerCase();
  return c === 'ability' || c === 'perk';
}

function isBroadOwnerScopeCategory(catRaw) {
  const c = toStr(catRaw).toLowerCase();
  return c === 'ability' || c === 'perk' || c === 'role' || c === 'mode' || c === 'queue' || c === 'rank' || c === 'platform';
}

function ownerSameHeroUnlock(ownerEvidence) {
  return ownerEvidence?.same_hero_context_unlock === true;
}

function ownerHeroTitlePrimary(ownerEvidence) {
  return ownerEvidence?.owner_hero_title_primary === true;
}

function competingHeroTitlePrimary(ownerEvidence) {
  return ownerEvidence?.competing_hero_title_primary === true;
}

function signalCountForAliasDirective({ hasTitleOp, corroborated, commentOnly, answerSlotStrongSupport }) {
  let n = 0;
  if (hasTitleOp) n += 1;
  if (corroborated) n += 1;
  if (commentOnly && answerSlotStrongSupport === true) n += 1;
  return n;
}

function getIntentEvidence(c, es) {
  const raw = (c?.intent_evidence && typeof c.intent_evidence === 'object') ? c.intent_evidence : (es?.intent_evidence && typeof es.intent_evidence === 'object' ? es.intent_evidence : null);
  if (!raw) return null;
  const anchorHits = safeArray(raw.intent_anchor_hits);
  const negHits = safeArray(raw.neg_anchor_hits);
  const requiresContext = raw.applicable === true || raw.requires_context === true || raw.requires_intent_anchor === true || anchorHits.length > 0 || negHits.length > 0 || !!toStr(raw.anchor_group);
  const passIntent = typeof raw.pass_intent_anchor === 'boolean' ? raw.pass_intent_anchor : (raw.intent_anchor_present === true || anchorHits.length > 0 ? true : (requiresContext ? false : null));
  const passNeg = typeof raw.pass_negative_anchor_gate === 'boolean' ? raw.pass_negative_anchor_gate : (raw.neg_anchor_present === true || negHits.length > 0 ? false : true);
  return {
    ...raw,
    applicable: requiresContext,
    requires_context: raw.requires_context === true || raw.requires_intent_anchor === true || requiresContext,
    requires_intent_anchor: raw.requires_intent_anchor === true || raw.requires_context === true || requiresContext,
    intent_anchor_hits: anchorHits,
    anchor_hits_n: Number.isFinite(raw.anchor_hits_n) ? raw.anchor_hits_n : anchorHits.length,
    intent_anchor_present: raw.intent_anchor_present === true || anchorHits.length > 0,
    neg_anchor_hits: negHits,
    neg_anchor_hits_n: Number.isFinite(raw.neg_anchor_hits_n) ? raw.neg_anchor_hits_n : negHits.length,
    neg_anchor_present: raw.neg_anchor_present === true || negHits.length > 0,
    pass_intent_anchor: passIntent,
    pass_negative_anchor_gate: passNeg,
  };
}

function deriveMatchKind(origins, aliasNorms, fuzzySim) {
  const hasExact = originsHasExact(origins);
  const hasFuzzy = originsHasFuzzy(origins);
  const hasAlias = safeArray(aliasNorms).length > 0;
  if (hasExact && !hasAlias) return 'EXACT_CANONICAL';
  if (hasExact && hasAlias) return 'EXACT_ALIAS';
  if (!hasExact && hasFuzzy && !hasAlias) return 'FUZZY_CANONICAL';
  if (!hasExact && hasFuzzy && hasAlias) return 'FUZZY_ALIAS';
  if (!hasExact && Number.isFinite(fuzzySim) && fuzzySim >= 0.9995) return 'FUZZY_CANONICAL';
  return 'UNKNOWN';
}

function isCorroborated(es, answerSlotStrongSupport, contradictionPairs) {
  const independentN = Number(es?.independent_evidence_n || 0);
  const bestRank = Number.isFinite(es?.best_comment_rank) ? es.best_comment_rank : null;
  if (independentN >= 2) return true;
  const multiplier = answerSlotStrongSupport === true || Number(contradictionPairs || 0) > 0;
  if (multiplier && Number.isFinite(bestRank) && bestRank <= 3) return true;
  return false;
}

function deriveTopicalityStrong(es, evList, hasTitleOp) {
  if (es && typeof es.topicality_strong === 'boolean') return es.topicality_strong;
  const evN = safeArray(evList).length;
  if (!hasTitleOp) return false;
  const independentN = Number(es?.independent_evidence_n || 0);
  return evN >= 2 || independentN >= 2;
}

function deriveCommentExactRelevance(es, commentOnly) {
  const b = toStr(es?.comment_exact_relevance_bucket || '').toUpperCase();
  if (b === 'HIGH' || b === 'MED' || b === 'LOW') return b;
  if (!commentOnly) return null;
  const bestRank = Number.isFinite(es?.best_comment_rank) ? es.best_comment_rank : null;
  const independentN = Number(es?.independent_evidence_n || 0);
  if (Number.isFinite(bestRank) && bestRank <= 2) return 'MED';
  if (independentN >= 2) return 'MED';
  return 'LOW';
}

function normalizeReasonToken(s) {
  return toStr(s)
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 48);
}

function conceptNegAnchorReason(intent) {
  const group = normalizeReasonToken(intent?.anchor_group || 'concept');
  const hit = normalizeReasonToken(safeArray(intent?.neg_anchor_hits)[0] || 'neg_anchor');
  return `suppress:concept_neg_anchor_hit:${group}:${hit}`;
}

function isSafeBypassCategory(catRaw) {
  const c = toStr(catRaw).toLowerCase();
  return c === 'rank' || c === 'queue' || c === 'platform' || c === 'mode' || c === 'role';
}

function exactContextSafeCategoryReason(catRaw, slugRaw, ecs, score, commentOnly) {
  const cat = toStr(catRaw).toLowerCase();
  const slug = toStr(slugRaw).toLowerCase();
  const light = ecs?.light_context === true;
  const strong = ecs?.strong_context === true;
  const safeCandidate = ecs?.safe_candidate === true;
  const safeCommentCandidate = ecs?.safe_comment_candidate === true;
  if (!safeCandidate) return null;

  if (cat === 'rank') {
    if (['master', 'champion', 'gm'].includes(slug) && strong && score >= (commentOnly ? 0.76 : 0.72)) return commentOnly ? 'safe_bypass:rank_comment_exact_topicality_safe' : 'safe_bypass:rank_exact_context_safe';
    if (slug === 'grandmaster' && light && score >= (commentOnly ? 0.72 : 0.68)) return commentOnly ? 'safe_bypass:rank_comment_exact_topicality_safe' : 'safe_bypass:rank_grandmaster_light_context_safe';
    if (light && score >= (commentOnly ? 0.68 : 0.64)) return commentOnly ? 'safe_bypass:rank_comment_exact_topicality_safe' : 'safe_bypass:rank_exact_context_safe';
  }
  if (cat === 'platform') {
    if (slug === 'switch') {
      if (strong && score >= (commentOnly ? 0.84 : 0.78)) return commentOnly ? 'safe_bypass:platform_switch_comment_exact_topicality_safe' : 'safe_bypass:platform_switch_strict_context_safe';
    } else if (strong && score >= (commentOnly ? 0.70 : 0.66)) {
      return commentOnly ? 'safe_bypass:platform_comment_exact_topicality_safe' : 'safe_bypass:platform_exact_context_safe';
    }
  }
  if (cat === 'queue' && light && score >= (commentOnly ? 0.68 : 0.64)) {
    return commentOnly ? 'safe_bypass:queue_comment_exact_topicality_safe' : 'safe_bypass:queue_exact_context_safe';
  }
  if ((cat === 'mode' || cat === 'role') && safeCommentCandidate && strong && score >= 0.66) {
    return `safe_bypass:${cat}_comment_exact_context_safe`;
  }
  if ((cat === 'mode' || cat === 'role') && safeCandidate && light && score >= 0.62) {
    return `safe_bypass:${cat}_exact_context_safe`;
  }
  return null;
}

function prefixOf(reason) {
  const s = toStr(reason);
  const i = s.indexOf(':');
  return i > 0 ? s.slice(0, i) : 'other';
}

function hasTitleOrOpEvidence(evList) {
  for (const ev of safeArray(evList)) {
    const st = toStr(ev.source_type).trim().toLowerCase();
    if (st === 'title' || st === 'op') return true;
  }
  return false;
}

function hasCommentEvidence(evList) {
  for (const ev of safeArray(evList)) {
    if (toStr(ev.source_type).trim().toLowerCase() === 'comment') return true;
  }
  return false;
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

function boolOrNull(v) {
  return typeof v === 'boolean' ? v : null;
}

function hasSignalPrefix(arr, prefix) {
  const p = toStr(prefix).trim();
  if (!p) return false;
  return safeArray(arr).some((v) => toStr(v).trim().startsWith(p));
}

function deriveOwnerScopePrimary(target) {
  const ownerEvidence = target?.owner_evidence && typeof target.owner_evidence === 'object' ? target.owner_evidence : null;
  const protectedContext = target?.protected_context && typeof target.protected_context === 'object' ? target.protected_context : null;
  const ownerStatus = toStr(target?.det_owner_status || ownerEvidence?.owner_status).trim().toUpperCase();
  const ownerStrength = toStr(target?.det_owner_context_strength || ownerContextStrength(ownerEvidence, protectedContext)).trim().toUpperCase();
  const ownerSupported =
    ownerEvidence?.owner_exact_title_op_support === true ||
    ownerEvidence?.owner_title_op_support === true ||
    ownerEvidence?.same_hero_context_unlock === true ||
    ownerEvidence?.owner_same_source_unlock === true ||
    ownerEvidence?.owner_second_context === true ||
    protectedContext?.pass_protected_context === true ||
    protectedContext?.protected_context === true ||
    protectedContext?.protected_primary === true;
  const applicable = target?.det_owner_scope_required === true || ownerEvidence !== null || isBroadOwnerScopeCategory(target?.category);
  if (!applicable) return null;
  return ownerStatus === 'KNOWN' && (ownerSupported || ownerStrength === 'STRONG' || ownerStrength === 'MEDIUM');
}

function annotatePolicyAuditMirrors(target) {
  if (!target || typeof target !== 'object') return;
  const intent = target?.intent_evidence && typeof target.intent_evidence === 'object' ? target.intent_evidence : null;
  const ecs = target?.exact_context_signals && typeof target.exact_context_signals === 'object' ? target.exact_context_signals : null;
  const safeTags = safeArray(target?.det_safe_tags).map(toStr).filter(Boolean);
  const blockSignals = safeArray(target?.storage_block_signals_dbg).map(toStr).filter(Boolean);
  const suppressionPrimary = toStr(target?.suppression_reason_primary || target?.det_suppressed_reason || '').trim();
  const laneBlockerPrimary = toStr(target?.storage_blocker_primary ?? '').trim();
  const hasIntentApplicability =
    intent && (
      intent.applicable === true ||
      intent.requires_context === true ||
      intent.requires_intent_anchor === true ||
      safeArray(intent.intent_anchor_hits).length > 0 ||
      safeArray(intent.neg_anchor_hits).length > 0 ||
      !!toStr(intent.anchor_group).trim()
    );
  target.concept_intent_anchor_present = boolOrNull(hasIntentApplicability ? (intent?.intent_anchor_present === true || safeArray(intent?.intent_anchor_hits).length > 0) : null);
  target.negative_anchor_hit = boolOrNull(hasIntentApplicability ? (Number(target?.det_intent_neg_anchor_hits_n ?? intent?.neg_anchor_hits_n ?? 0) > 0 || safeArray(intent?.neg_anchor_hits).length > 0) : null);
  target.exact_context_safe_bypass = boolOrNull(ecs ? (ecs?.safe_candidate === true || ecs?.safe_comment_candidate === true || safeTags.some((tag) => toStr(tag).startsWith('safe_bypass:'))) : (safeTags.some((tag) => toStr(tag).startsWith('safe_bypass:')) ? true : null));
  target.comment_exact_topicality_safe = boolOrNull(ecs ? (ecs?.safe_comment_candidate === true || safeTags.some((tag) => toStr(tag).includes('comment_exact')) || safeTags.some((tag) => toStr(tag).includes('_comment_exact_')) || safeTags.some((tag) => toStr(tag).endsWith(':hero_scoped_exact_comment_safe'))) : (safeTags.some((tag) => toStr(tag).includes('comment_exact')) || safeTags.some((tag) => toStr(tag).endsWith(':hero_scoped_exact_comment_safe')) ? true : null));
  target.owner_scope_primary = boolOrNull(deriveOwnerScopePrimary(target));
  const hasNegAnchorBlock =
    hasSignalPrefix(blockSignals, 'block:negative_anchor') ||
    suppressionPrimary.startsWith('suppress:concept_neg_anchor_hit:') ||
    laneBlockerPrimary.startsWith('storage:block_concept_neg_anchor:');
  const hasMissingOwnerScopeBlock =
    hasSignalPrefix(blockSignals, 'block:missing_owner_scope') ||
    suppressionPrimary === 'suppress:owner_scope_missing_owner' ||
    laneBlockerPrimary === 'storage:block_missing_owner_scope';
  target.lane_has_negative_anchor_block = hasNegAnchorBlock;
  target.lane_has_missing_owner_scope_block = hasMissingOwnerScopeBlock;
  target.storage_has_negative_anchor_block = hasNegAnchorBlock;
  target.storage_has_missing_owner_scope_block = hasMissingOwnerScopeBlock;
}

module.exports = {
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
};

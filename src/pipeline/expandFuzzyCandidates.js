// expandFuzzyCandidates.js
//
// Fuzzy candidate generation + shadow telemetry for posts already processed by
// packCandidates. Consumes pack output + policyBundle; does not re-scan raw
// upstream text beyond detect.sources for span raw snippets.
//
// Parity target: n8n "Fuzzy Candidate Expansion" behavior (v11.9 policy overlay).
//
// Scope guardrails:
// - Extend pack state with fuzzy candidates + telemetry; preserve pack fields verbatim.
// - Plausibility/context gates emit vs shadow only (no lane/oracle/normalization authority).
// - Risky alias rows: shadow OK; production fuzzy emit blocked when emit_disabled.

function toStr(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function unique(arr) {
  return [...new Set(arr)];
}

function isPackStageItem(j) {
  return (
    isObject(j) &&
    typeof j.post_id !== 'undefined' &&
    isObject(j.detect) &&
    Array.isArray(j.entity_candidates_exact) &&
    isObject(j.fuzzy_plan)
  );
}

function stripEntityMeta(meta) {
  if (!isObject(meta)) return null;
  const out = { ...meta };
  if (Object.prototype.hasOwnProperty.call(out, 'entity_meta')) delete out.entity_meta;
  return out;
}

/** Same documentation strings as pack snapshot when meta.notes absent (fixture parity). */
const DEFAULT_DICTIONARY_META_NOTES = [
  'Combined DB dictionaries + static detection dictionaries',
  'DB+META rows pulled from node: Merge SQL data',
  'META rows are used for deterministic context only (no text matching)',
  'rank_brackets are derived taxonomy and are not direct text-matched (RANK_BRACKET rows excluded from rows)',
  'policy_meta includes anchor_groups + negative_anchors + bracket membership',
  'v3.3 adds policy overlay for risky ABILITY/PERK aliases + alias collision registry',
  'v3.4 carries answer_slot_patterns from static dictionaries for downstream answer-tier scoring',
];

function buildFuzzyDictionaryMetaSnapshot(policyBundle) {
  const base = stripEntityMeta(policyBundle?.meta);
  if (!base) return null;
  return {
    ...base,
    answer_slot_patterns_loaded: Boolean(policyBundle?.policyMeta?.answer_slot_patterns),
    notes: Array.isArray(base.notes) ? base.notes : DEFAULT_DICTIONARY_META_NOTES,
  };
}

function normalizeTier(tier) {
  const t = toStr(tier).trim().toUpperCase().replace(/\s+/g, '_').replace(/-/g, '_');
  if (!t) return '';
  if (t === 'TIER1') return 'TIER_1';
  if (t === 'TIER2') return 'TIER_2';
  if (t === 'TIER3') return 'TIER_3';
  return t;
}

function mapEntityTypeToCategory(entityType) {
  const t = toStr(entityType).toUpperCase();
  if (t === 'HERO') return 'hero';
  if (t === 'MAP') return 'map';
  if (t === 'RANK') return 'rank';
  if (t === 'PLATFORM') return 'platform';
  if (t === 'QUEUE') return 'queue';
  if (t === 'MODE') return 'mode';
  if (t === 'ROLE') return 'role';
  if (t === 'ABILITY') return 'ability';
  if (t === 'PERK') return 'perk';
  return 'other';
}

function categoryToEntityTypes(cat) {
  const c = toStr(cat).toLowerCase();
  if (c === 'hero') return ['HERO'];
  if (c === 'map') return ['MAP'];
  if (c === 'rank') return ['RANK'];
  if (c === 'platform') return ['PLATFORM'];
  if (c === 'queue') return ['QUEUE'];
  if (c === 'mode') return ['MODE'];
  if (c === 'role') return ['ROLE'];
  if (c === 'ability') return ['ABILITY'];
  if (c === 'perk') return ['PERK'];
  return [];
}

function sourceWeightFor(sourceType) {
  if (sourceType === 'title') return 1.0;
  if (sourceType === 'op') return 0.9;
  if (sourceType === 'comment') return 0.55;
  return 0.4;
}

function normalizeSpanText(raw) {
  const s = toStr(raw).toLowerCase();
  return s.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildSnippet(raw, maxLen = 220) {
  const s = toStr(raw).replace(/\s+/g, ' ').trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}

function stableId(parts) {
  return parts.map((p) => toStr(p)).join('|');
}

function toInt(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function upper(v) {
  return toStr(v).trim().toUpperCase();
}

function buildPolicyRiskContext(policyBundle) {
  const pm = isObject(policyBundle?.policy_meta)
    ? policyBundle.policy_meta
    : isObject(policyBundle?.policyMeta)
      ? policyBundle.policyMeta
      : {};
  const cw = safeArray(pm.common_word_alias_norms);
  return {
    common_word_alias_norms: new Set(cw.map((x) => toStr(x).toLowerCase()).filter(Boolean)),
  };
}

function getRowRiskOverlay(row, policyRiskCtx) {
  const isCanonical = row?.is_canonical === true;
  const tierUpper = normalizeTier(row?.tier);
  const promotionRisk = upper(row?.promotion_risk || '');
  const shortAlias = row?.short_alias === true;
  const collisionCount = toInt(row?.alias_collision_count, 0);

  const aliasNorm = toStr(row?.alias_text_norm).toLowerCase();
  const commonWordExplicit = row?.alias_common_word_risk === true;
  const commonWordInferred = !!(policyRiskCtx?.common_word_alias_norms && policyRiskCtx.common_word_alias_norms.has(aliasNorm));
  const commonWordRisk = commonWordExplicit || commonWordInferred;

  const reasons = [];
  if (!isCanonical) {
    if (promotionRisk === 'HIGH') reasons.push('promotion_risk_high');
    if (shortAlias) reasons.push('short_alias');
    if (collisionCount > 1) reasons.push('alias_collision');
    if (commonWordRisk) reasons.push('common_word_alias');
    if (
      (toStr(row?.entity_type).toUpperCase() === 'ABILITY' || toStr(row?.entity_type).toUpperCase() === 'PERK') &&
      tierUpper === 'TIER_3'
    ) {
      reasons.push('ability_perk_tier3_alias');
    }
  }

  const emitDisabled = !isCanonical && reasons.length > 0;
  return {
    emit_disabled: emitDisabled,
    reasons: unique(reasons).slice(0, 6),
    promotion_risk: promotionRisk || null,
    short_alias: shortAlias,
    alias_collision_count: collisionCount,
    alias_common_word_risk: commonWordRisk,
  };
}

const OVERSHOOT_MODE = false;
const OVERSHOOT_ALLOW_SOURCES = new Set(['title', 'op', 'body']);
const OVERSHOOT_MIN_SIMILARITY_FLOOR = 0.7;
const OVERSHOOT_THRESHOLD_DELTA = 0.3;
const OVERSHOOT_MIN_SIMILARITY_FLOOR_FALLBACK = 0.6;
const OVERSHOOT_MAX_CANDIDATES_PER_POST_CATEGORY = 6;
const OVERSHOOT_DISABLE_SUPPRESSION_MAPS = true;

function levenshtein(a, b) {
  const s = toStr(a);
  const t = toStr(b);
  const n = s.length;
  const m = t.length;
  if (n === 0) return m;
  if (m === 0) return n;
  const dp = new Array(m + 1);
  for (let j = 0; j <= m; j++) dp[j] = j;
  for (let i = 1; i <= n; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= m; j++) {
      const temp = dp[j];
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = temp;
    }
  }
  return dp[m];
}

function normalizedSimilarity(a, b) {
  const s = toStr(a);
  const t = toStr(b);
  if (!s || !t) return 0;
  const maxLen = Math.max(s.length, t.length);
  if (maxLen === 0) return 1;
  const dist = levenshtein(s, t);
  return 1 - dist / maxLen;
}

function tokenSimilarity(token, aliasNorm) {
  const t = toStr(token).trim();
  const a = toStr(aliasNorm).trim();
  if (!t || !a) return 0;
  if (t === a) return 1;
  const tCollapsed = t.replace(/\s+/g, '');
  const aCollapsed = a.replace(/\s+/g, '');
  if (tCollapsed && tCollapsed === aCollapsed) return 0.995;
  const sim1 = normalizedSimilarity(t, a);
  const hasWhitespace = /\s/.test(t) || /\s/.test(a);
  if (!hasWhitespace) return sim1;
  const sim2 = normalizedSimilarity(tCollapsed, aCollapsed);
  return Math.max(sim1, sim2);
}

function maxPossibleSimByLen(aLen, bLen) {
  const maxLen = Math.max(aLen, bLen);
  if (maxLen <= 0) return 0;
  const absDiff = Math.abs(aLen - bLen);
  return 1 - absDiff / maxLen;
}

function alnumNorm(s) {
  return toStr(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function bigramSet(s) {
  const t = alnumNorm(s);
  const out = new Set();
  if (t.length < 2) return out;
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

function canonicalPrimaryVariantReasonAllowed(category, categoryReason) {
  const cat = toStr(category).toLowerCase();
  const why = toStr(categoryReason);
  if (why.startsWith('primary_delimiter_variant_')) return true;
  if (cat === 'ability' && why === 'ability_owner_hero_primary_support') return true;
  return false;
}

function canAttemptCanonicalPrimaryVariantDirect({ category, source, isCanonical, heroSlug, categoryReason }) {
  const cat = toStr(category).toLowerCase();
  const src = toStr(source).toLowerCase();
  if (!(src === 'title' || src === 'op')) return false;
  if (!isCanonical) return false;
  if (!(cat === 'hero' || cat === 'map' || cat === 'ability')) return false;
  if (cat === 'ability' && !toStr(heroSlug)) return false;
  return canonicalPrimaryVariantReasonAllowed(cat, categoryReason);
}

function getCanonicalPrimaryVariantDirectHit({
  category,
  source,
  isCanonical,
  heroSlug,
  categoryReason,
  aliasNorm,
  canonicalSlug,
  ngrams,
  spanTextNorm,
}) {
  const cat = toStr(category).toLowerCase();
  const src = toStr(source).toLowerCase();
  if (!(src === 'title' || src === 'op')) return null;
  if (!isCanonical) return null;
  if (!(cat === 'hero' || cat === 'map' || cat === 'ability')) return null;
  if (cat === 'ability' && !toStr(heroSlug)) return null;
  if (!canonicalPrimaryVariantReasonAllowed(cat, categoryReason)) return null;

  const aliasAl = alnumNorm(aliasNorm);
  const slugAl = alnumNorm(toStr(canonicalSlug).replace(/[-_]+/g, ' '));
  const targets = [aliasAl, slugAl].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
  if (!targets.length) return null;

  const grams = [toStr(spanTextNorm), ...safeArray(ngrams).map(toStr)];
  let best = null;

  for (const gramRaw of grams) {
    const gram = toStr(gramRaw).trim();
    if (!gram) continue;
    const gal = alnumNorm(gram);
    if (!gal || gal.length < 5) continue;

    for (const target of targets) {
      if (!target || Math.min(gal.length, target.length) < 5) continue;

      if (gal === target) {
        return {
          gram,
          similarity: 0.97,
          direct: true,
          profile: {
            relax: true,
            mode: 'NORM_EQ',
            source: 'canonical_primary_variant_direct',
            threshold_save: false,
            tie_save: false,
            details: {
              source: 'canonical_primary_variant_direct',
              alnum_equal: true,
              near_miss: false,
              target: target === aliasAl ? 'alias' : 'canonical_slug',
            },
          },
        };
      }

      const lenMin = Math.min(gal.length, target.length);
      const lenDiff = Math.abs(gal.length - target.length);
      const alnumSim = normalizedSimilarity(gal, target);
      const dist = levenshtein(gal, target);
      const sameEdges = gal[0] === target[0] && gal[gal.length - 1] === target[target.length - 1];
      const substringNear = (gal.includes(target) || target.includes(gal)) && lenDiff <= 2 && lenMin >= 6;
      const safeNear =
        sameEdges &&
        lenMin >= 7 &&
        ((dist <= 1 && alnumSim >= 0.9) || (lenMin >= 10 && dist <= 2 && alnumSim >= 0.92) || substringNear);
      if (!safeNear) continue;

      const cand = {
        gram,
        similarity: Math.max(alnumSim, 0.9),
        direct: true,
        profile: {
          relax: true,
          mode: 'EDITDIST_EQ',
          source: 'canonical_primary_variant_direct_near_miss',
          threshold_save: false,
          tie_save: false,
          details: {
            source: 'canonical_primary_variant_direct_near_miss',
            alnum_equal: false,
            alnum_similarity: Number(alnumSim.toFixed(4)),
            edit_distance: dist,
            substring_near: substringNear,
            near_miss: true,
            target: target === aliasAl ? 'alias' : 'canonical_slug',
          },
        },
      };
      if (!best || cand.similarity > best.similarity) best = cand;
    }
  }
  return best;
}

function getCanonicalPrimaryVariantRelaxProfile({
  category,
  source,
  isCanonical,
  heroSlug,
  categoryReason,
  matchedGram,
  aliasNorm,
  similarity,
  exactPresent,
  exactPresentReason,
  thresholdBase,
  tieMarginBase,
  secondCanonical,
  margin,
  directProfile,
}) {
  const cat = toStr(category).toLowerCase();
  const src = toStr(source).toLowerCase();
  if (!(src === 'title' || src === 'op')) return null;
  if (!isCanonical) return null;
  if (exactPresent === true && toStr(exactPresentReason) !== 'exact_same_source') return null;
  if (!(cat === 'hero' || cat === 'map' || cat === 'ability')) return null;
  if (cat === 'ability' && !toStr(heroSlug)) return null;
  if (!canonicalPrimaryVariantReasonAllowed(cat, categoryReason)) return null;

  if (directProfile && directProfile.relax === true) {
    return {
      ...directProfile,
      threshold_save: similarity < Number(thresholdBase || 0),
      tie_save: false,
      details: {
        ...(isObject(directProfile.details) ? directProfile.details : {}),
        threshold_saved: similarity < Number(thresholdBase || 0),
      },
    };
  }

  const mg = alnumNorm(matchedGram);
  const an = alnumNorm(aliasNorm);
  if (!mg || !an) return null;
  if (Math.min(mg.length, an.length) < 5) return null;

  const hasCloseSecond = !!(secondCanonical && margin < Math.max(Number(tieMarginBase || 0), 0.03));
  if (hasCloseSecond) return null;

  if (mg === an && similarity >= 0.94) {
    return {
      relax: true,
      mode: 'NORM_EQ',
      source: 'canonical_primary_variant_relax',
      threshold_save: similarity < Number(thresholdBase || 0),
      tie_save: false,
      details: { source: 'canonical_primary_variant_relax', alnum_equal: true, near_miss: false },
    };
  }

  const alnumSim = normalizedSimilarity(mg, an);
  const substringNear =
    (mg.includes(an) || an.includes(mg)) && Math.abs(mg.length - an.length) <= 2 && Math.min(mg.length, an.length) >= 6;
  const nearMissAllowed =
    similarity >= Math.max(0.88, Number(thresholdBase || 0) - 0.05) && (alnumSim >= 0.9 || substringNear);
  if (!nearMissAllowed) return null;

  return {
    relax: true,
    mode: 'EDITDIST_EQ',
    source: 'canonical_primary_variant_near_miss',
    threshold_save: similarity < Number(thresholdBase || 0),
    tie_save: false,
    details: {
      source: 'canonical_primary_variant_near_miss',
      alnum_equal: false,
      alnum_similarity: Number(alnumSim.toFixed(4)),
      substring_near: substringNear,
      near_miss: true,
    },
  };
}

function hasBigramOverlap(setA, setB) {
  if (!setA || !setB) return false;
  const aSmall = setA.size <= setB.size ? setA : setB;
  const bLarge = setA.size <= setB.size ? setB : setA;
  for (const x of aSmall) {
    if (bLarge.has(x)) return true;
  }
  return false;
}

function passesPrefilter(gramInfo, aliasInfo, opts) {
  if (!gramInfo || !aliasInfo) return true;
  const g = gramInfo.alnum;
  const a = aliasInfo.alnum;
  if (!g || !a) return true;
  if (g.length < 5 || a.length < 5) return true;
  const isCanonical = opts && opts.isCanonical === true;
  const src = opts && typeof opts.source === 'string' ? opts.source : '';
  const isPrimarySurface = src === 'title' || src === 'op' || src === 'body';
  if (OVERSHOOT_MODE && isCanonical && isPrimarySurface) return true;
  const relaxPrefix = isCanonical && isPrimarySurface;
  if (!relaxPrefix && g[0] !== a[0]) return false;
  if (Math.min(g.length, a.length) >= 7) {
    if (!(isCanonical && isPrimarySurface) && g.slice(0, 2) !== a.slice(0, 2)) return false;
  }
  if (!hasBigramOverlap(gramInfo.bigrams, aliasInfo.bigrams)) return false;
  return true;
}

const COMMON_WORDS = new Set([
  'back', 'lack', 'pack', 'sack', 'jack', 'rack', 'tack', 'black', 'stack',
  'make', 'take', 'like', 'look', 'lock', 'kick', 'pick', 'sick',
  'good', 'bad', 'best', 'better', 'great', 'worst',
  'time', 'times', 'game', 'games', 'play', 'playing', 'played', 'player', 'players',
  'team', 'teams', 'match', 'matches', 'rank', 'ranked', 'queue', 'queued', 'queuing',
  'shot', 'shots', 'fire', 'fired', 'damage', 'heal', 'heals', 'healing', 'buff', 'nerf',
  'move', 'moves', 'moved', 'moving', 'push', 'pull', 'hold', 'held', 'swap', 'switch',
]);

const HERO_SHORT_ALLOWLIST = new Set([
  'ana', 'mei', 'dva', 'ashe', 'echo', 'juno', 'zen', 'brig', 'lucio', 'moira', 'orisa', 'sigma', 'kiriko', 'sojourn', 'tracer',
  'rein', 'ram', 'doom', 'genji', 'hanzo', 'junk', 'bap', 'torb', 'sym', 'sombra', 'pharah', 'mercy', 'widow', 'cass', 'mccree',
]);

function isSingleTokenLowerAlpha(s) {
  const t = toStr(s).trim();
  if (!t) return false;
  if (/\s/.test(t)) return false;
  return /^[a-z]+$/.test(t);
}

function containsAnyToken(textNorm, tokenSet) {
  const t = toStr(textNorm);
  if (!t) return false;
  for (const tok of tokenSet) {
    const re = new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(t)) return true;
  }
  return false;
}

const QUEUE_ANCHORS = new Set([
  'role', 'roles', 'role queue', 'rolequeue',
  'open queue', 'openqueue',
  'tank', 'tanks', 'dps', 'support', 'flex',
  'competitive', 'comp', 'ranked',
]);

const RANK_ANCHORS = new Set([
  'rank', 'ranked', 'sr', 'elo', 'mmr', 'climb', 'climbing', 'hardstuck', 'placement', 'placements',
  'competitive', 'comp',
]);

const PLATFORM_ANCHORS = new Set([
  'pc', 'console', 'ps4', 'ps5', 'psn', 'playstation', 'xbox', 'switch', 'nintendo', 'controller', 'bnet', 'battle', 'battlenet',
]);

function getIntentConceptContextFlags(detectIntent) {
  const intent = isObject(detectIntent) ? detectIntent : {};
  return {
    rank: Boolean(intent.rank_context_requested_primary || intent.rank_context_requested || intent.has_rank_context),
    platform: Boolean(intent.platform_context_requested_primary || intent.platform_context_requested || intent.has_platform_context),
    queue: Boolean(intent.queue_context_requested_primary || intent.queue_context_requested || intent.has_queue_context),
  };
}

function plausibilityCheck({
  category,
  matchedGram,
  spanTextNorm,
  source,
  canonicalSlug,
  policySignals,
  intentFlags,
  exactPresent,
}) {
  const cat = toStr(category).toLowerCase();
  const gram = toStr(matchedGram).trim();
  const gramNorm = normalizeSpanText(gram);
  const gramLen = gramNorm.length;
  const reasons = [];
  const src = toStr(source).toLowerCase();
  const isPrimarySurface = src === 'title' || src === 'op';

  const conceptAnchorsPresent = isObject(policySignals?.concept_anchor_terms_present)
    ? policySignals.concept_anchor_terms_present
    : {};
  const negativeHits = isObject(policySignals?.negative_anchor_hits) ? policySignals.negative_anchor_hits : {};

  const bypassMissingAnchorByIntent =
    (cat === 'rank' && intentFlags && intentFlags.rank === true) ||
    (cat === 'platform' && intentFlags && intentFlags.platform === true) ||
    (cat === 'queue' && intentFlags && intentFlags.queue === true);

  const bypassMissingAnchorByPack =
    (cat === 'rank' && conceptAnchorsPresent.rank === true) ||
    (cat === 'platform' && conceptAnchorsPresent.platform === true) ||
    (cat === 'queue' && conceptAnchorsPresent.queue === true);

  const bypassMissingAnchorByExactPresent = exactPresent === true;

  if (isSingleTokenLowerAlpha(gramNorm) && gramLen <= 4) {
    const isHero = cat === 'hero';
    const isCommon = COMMON_WORDS.has(gramNorm);
    const isHeroAllowed = isHero && (HERO_SHORT_ALLOWLIST.has(gramNorm) || gramLen >= 3) && !isCommon;
    if (!isHeroAllowed) reasons.push('short_single_token');
    if (isCommon) reasons.push('common_word');
  }

  if (cat === 'ability') {
    if (isSingleTokenLowerAlpha(gramNorm) && gramLen <= 4) reasons.push('ability_short_token');
    if (COMMON_WORDS.has(gramNorm)) reasons.push('ability_common_word');
  }

  if (cat === 'queue') {
    const packQueueAnchor = bypassMissingAnchorByPack;
    if (
      src !== 'anchor' &&
      !bypassMissingAnchorByIntent &&
      !packQueueAnchor &&
      !bypassMissingAnchorByExactPresent &&
      !containsAnyToken(spanTextNorm, QUEUE_ANCHORS)
    ) {
      reasons.push('missing_queue_anchor');
    }
    if (
      containsAnyToken(gramNorm, new Set(['queue', 'queued', 'queuing'])) &&
      !containsAnyToken(spanTextNorm, new Set(['role', 'tank', 'dps', 'support', 'open']))
    ) {
      reasons.push('generic_queue_term_no_role_signal');
    }
  }

  if (cat === 'rank') {
    const packRankAnchor = bypassMissingAnchorByPack;
    if (
      src !== 'anchor' &&
      !bypassMissingAnchorByIntent &&
      !packRankAnchor &&
      !bypassMissingAnchorByExactPresent &&
      !containsAnyToken(spanTextNorm, RANK_ANCHORS)
    ) {
      reasons.push('missing_rank_anchor');
    }
    const neg = safeArray(negativeHits.rank);
    if ((src === 'title' || src === 'op') && neg.length > 0) {
      const strongRankIntent = containsAnyToken(spanTextNorm, RANK_ANCHORS) || bypassMissingAnchorByIntent;
      if (!strongRankIntent) reasons.push('rank_negative_anchor_primary');
    }
  }

  if (cat === 'platform') {
    const packPlatformAnchor = bypassMissingAnchorByPack;
    if (
      src !== 'anchor' &&
      !bypassMissingAnchorByIntent &&
      !packPlatformAnchor &&
      !bypassMissingAnchorByExactPresent &&
      !containsAnyToken(spanTextNorm, PLATFORM_ANCHORS)
    ) {
      reasons.push('missing_platform_anchor');
    }
    const sw = safeArray(negativeHits.platform_switch);
    const isSwitch = toStr(canonicalSlug).toLowerCase() === 'switch' || gramNorm === 'switch';
    if ((src === 'title' || src === 'op') && sw.length > 0 && isSwitch) {
      if (!containsAnyToken(spanTextNorm, new Set(['nintendo']))) reasons.push('switch_verb_collision_primary');
    }
  }

  if (src === 'comment') reasons.push('comment_source_shadow_only');

  const plausible =
    reasons.length === 0 ||
    (!isPrimarySurface && reasons.length === 1 && reasons[0] === 'comment_source_shadow_only');

  return {
    plausible,
    reasons: unique(reasons).slice(0, 8),
    bypass: {
      bypassMissingAnchorByIntent,
      bypassMissingAnchorByPack,
      bypassMissingAnchorByExactPresent,
    },
  };
}

const SHADOW_ENABLED = true;
const SHADOW_TOPK_PER_CATEGORY = 3;

/**
 * Pack `hero_fuzzy_carve_out` already gates typos (incl. length-5 transpositions: sim 0.6).
 * Expand bypass requires the same matched gram as pack + a sanity floor only.
 */
const HERO_TYPO_CARVE_OUT_MIN_SIMILARITY = 0.55;

const PRIMARY_ALIAS_RELAX_PILOT = {
  enabled: false,
  categories: new Set(['hero', 'ability']),
  sources: new Set(['title', 'op']),
  allow_tiers: new Set(['TIER_1', 'STATIC_ALIAS', 'TIER_2']),
  min_alias_len: 6,
  threshold_relax: { TIER_1: 0.01, STATIC_ALIAS: 0.01, TIER_2: 0.005 },
  tie_margin_relax: { TIER_1: 0.005, STATIC_ALIAS: 0.005, TIER_2: 0.003 },
};

function getPrimaryAliasRelaxPilotProfile({ category, sourceType, isCanonical, tierUpper, aliasNorm, categoryContextPresent }) {
  const cat = toStr(category).toLowerCase();
  const src = toStr(sourceType).toLowerCase();
  const tier = normalizeTier(tierUpper);
  const aliasLen = toStr(aliasNorm).length;
  if (!PRIMARY_ALIAS_RELAX_PILOT.enabled) return null;
  if (isCanonical) return null;
  if (!categoryContextPresent) return null;
  if (!PRIMARY_ALIAS_RELAX_PILOT.categories.has(cat)) return null;
  if (!PRIMARY_ALIAS_RELAX_PILOT.sources.has(src)) return null;
  if (!PRIMARY_ALIAS_RELAX_PILOT.allow_tiers.has(tier)) return null;
  if (aliasLen < PRIMARY_ALIAS_RELAX_PILOT.min_alias_len) return null;
  const thrRelax = Number(PRIMARY_ALIAS_RELAX_PILOT.threshold_relax[tier] || 0);
  const tieRelax = Number(PRIMARY_ALIAS_RELAX_PILOT.tie_margin_relax[tier] || 0);
  if (thrRelax <= 0 && tieRelax <= 0) return null;
  return { mode: 'primary_alias_relax_pilot', threshold_relax: thrRelax, tie_margin_relax: tieRelax, alias_len: aliasLen, tier };
}

function getThresholdFor(category, aliasNorm, sourceType, opts = {}) {
  const a = toStr(aliasNorm);
  const len = a.length;
  const cat = toStr(category).toLowerCase();
  const source = toStr(sourceType).toLowerCase();
  const isAlias = opts.isCanonical === false;
  const tierUpper = normalizeTier(opts.tierUpper);
  let threshold;
  if (len <= 2) threshold = 0.995;
  else if (len === 3) threshold = 0.975;
  else if (len === 4) threshold = 0.945;
  else if (len <= 6) threshold = 0.915;
  else threshold = 0.885;
  if (cat === 'rank') threshold = Math.max(threshold, 0.93);
  if (cat === 'platform') threshold = Math.max(threshold, 0.94);
  if (cat === 'queue') threshold = Math.max(threshold, 0.93);
  if (cat === 'ability') threshold = Math.max(threshold, 0.9);
  if (source === 'comment') threshold += 0.015;
  if (len >= 8) threshold -= 0.005;
  if (len >= 12) threshold -= 0.005;
  if (isAlias) {
    threshold += 0.01;
    if (tierUpper === 'TIER_2') threshold += 0.01;
    if (tierUpper === 'TIER_3') threshold += 0.02;
    if (len >= 10) threshold -= 0.005;
  }
  if (opts.relaxProfile && Number(opts.relaxProfile.threshold_relax || 0) > 0) {
    threshold -= Number(opts.relaxProfile.threshold_relax);
  }
  threshold = Math.max(0.84, threshold);
  return Math.min(0.995, Number(threshold.toFixed(4)));
}

function getTieMarginFor(aliasNorm, sourceType, opts = {}) {
  const len = toStr(aliasNorm).length;
  const isAlias = opts.isCanonical === false;
  const tierUpper = normalizeTier(opts.tierUpper);
  let margin;
  if (len <= 3) margin = 0.06;
  else if (len <= 5) margin = 0.045;
  else margin = 0.03;
  if (toStr(sourceType).toLowerCase() === 'comment') margin += 0.01;
  if (isAlias) margin += 0.005;
  if (isAlias && tierUpper === 'TIER_2') margin += 0.005;
  if (isAlias && tierUpper === 'TIER_3') margin += 0.01;
  if (opts.relaxProfile && Number(opts.relaxProfile.tie_margin_relax || 0) > 0) {
    margin -= Number(opts.relaxProfile.tie_margin_relax);
  }
  margin = Math.max(0.015, margin);
  return Number(margin.toFixed(4));
}

function isLikelyGenericGram(gram) {
  const g = toStr(gram).trim();
  if (!g) return true;
  const blocked = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'you', 'are',
    'was', 'were', 'have', 'has', 'had', 'not', 'but', 'all', 'any', 'can',
    'what', 'when', 'where', 'why', 'how', 'who', 'its', 'it', 'on', 'in', 'at',
    'to', 'of', 'or', 'if', 'is', 'be', 'as', 'an', 'a',
    'good', 'bad', 'best', 'better', 'great', 'worst', 'strong', 'stronger',
    'meta', 'ranked', 'quick', 'play', 'queue', 'open', 'role',
  ]);
  if (blocked.has(g)) return true;
  if (/^\d+$/.test(g)) return true;
  if (g.length <= 1) return true;
  return false;
}

function generateSpanCandidatesForAliasTokenLength(textNorm, aliasTokenLen, sourceType, maxTokens = null) {
  const src = toStr(sourceType).toLowerCase();
  const effectiveMaxTokens =
    Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0 ? Number(maxTokens) : src === 'comment' ? 80 : 48;
  const tokens = toStr(textNorm).split(/\s+/).filter(Boolean).slice(0, effectiveMaxTokens);
  const out = [];
  const lengthsBase =
    src === 'comment' ? [aliasTokenLen, aliasTokenLen - 1] : [aliasTokenLen, aliasTokenLen - 1, aliasTokenLen + 1];
  const lengths = unique(lengthsBase.filter((n) => n >= 1 && n <= 4));
  for (let i = 0; i < tokens.length; i++) {
    for (const n of lengths) {
      if (i + n > tokens.length) continue;
      const gram = tokens.slice(i, i + n).join(' ');
      if (isLikelyGenericGram(gram)) continue;
      out.push(gram);
    }
  }
  return unique(out);
}

const FUZZY_CANONICAL_FALLBACK_CATEGORIES = new Set(['hero', 'map', 'rank', 'platform', 'queue', 'ability', 'mode', 'role']);
const DISABLE_TIER3_ALIAS_FUZZY = false;
const ALIAS_FUZZY_ALLOWED_CATEGORIES = new Set(['hero', 'ability', 'rank', 'platform', 'queue']);
const ALIAS_FUZZY_TIER3_ALLOWED_CATEGORIES = new Set(['hero', 'ability']);
const MIN_ALIAS_LEN_TIER1 = 4;
const MIN_ALIAS_LEN_TIER2 = 4;
const MIN_ALIAS_LEN_TIER3 = 4;

function aliasFuzzyRolloutEligibilityMode({ category, isCanonical, tierUpper, aliasNorm, explicitFuzzyAllowed }) {
  if (isCanonical) return { eligible: false, mode: 'not_alias' };
  if (!ALIAS_FUZZY_ALLOWED_CATEGORIES.has(category)) return { eligible: false, mode: 'category_blocked' };
  const tier = normalizeTier(tierUpper);
  const len = toStr(aliasNorm).length;
  if (tier === 'TIER_1' || tier === 'STATIC_ALIAS') {
    if (len < MIN_ALIAS_LEN_TIER1) return { eligible: false, mode: 'tier1_len_blocked' };
    return { eligible: true, mode: explicitFuzzyAllowed ? 'alias_explicit_fuzzy_allowed' : 'alias_rollout_fallback_tier1' };
  }
  if (tier === 'TIER_2') {
    if (len < MIN_ALIAS_LEN_TIER2) return { eligible: false, mode: 'tier2_len_blocked' };
    return { eligible: true, mode: explicitFuzzyAllowed ? 'alias_explicit_fuzzy_allowed' : 'alias_rollout_fallback_tier2' };
  }
  if (tier === 'TIER_3') {
    if (!ALIAS_FUZZY_TIER3_ALLOWED_CATEGORIES.has(category)) return { eligible: false, mode: 'tier3_category_blocked' };
    if (len < MIN_ALIAS_LEN_TIER3) return { eligible: false, mode: 'tier3_len_blocked' };
    return { eligible: true, mode: explicitFuzzyAllowed ? 'alias_explicit_fuzzy_allowed' : 'alias_rollout_fallback_tier3' };
  }
  return { eligible: false, mode: 'tier_blocked' };
}

function buildFuzzyDictionaryIndex(rows, policyRiskCtxGlobal) {
  const byCategory = {};
  const meta = {
    total_rows_seen: 0,
    eligible_rows_total: 0,
    skipped_not_fuzzy_allowed: 0,
    skipped_tier3_alias_policy: 0,
    skipped_alias_rollout_policy: 0,
    risky_alias_rows_total: 0,
    risky_alias_rows_emit_disabled_total: 0,
    risky_alias_rows_by_category: {},
    eligible_by_category: {},
    eligibility_sources: { explicit_fuzzy_allowed: 0, canonical_fallback: 0, alias_rollout_fallback: 0 },
    eligible_alias_tiers: { canonical: 0, tier1: 0, tier2: 0, tier3: 0, other: 0 },
    alias_rollout_policy: {
      enabled: true,
      categories: Array.from(ALIAS_FUZZY_ALLOWED_CATEGORIES),
      tier3_categories: Array.from(ALIAS_FUZZY_TIER3_ALLOWED_CATEGORIES),
      min_len_tier1: MIN_ALIAS_LEN_TIER1,
      min_len_tier2: MIN_ALIAS_LEN_TIER2,
      min_len_tier3: MIN_ALIAS_LEN_TIER3,
    },
  };

  for (const r of safeArray(rows)) {
    meta.total_rows_seen += 1;
    const entityType = toStr(r.entity_type).toUpperCase();
    if (!entityType || entityType === 'RANK_BRACKET') continue;
    const category = mapEntityTypeToCategory(entityType);
    if (!category || category === 'other') continue;
    const aliasNorm = toStr(r.alias_text_norm).trim();
    if (!aliasNorm) continue;
    const isCanonical = r.is_canonical === true;
    const tierUpper = normalizeTier(r.tier);
    if (!isCanonical && DISABLE_TIER3_ALIAS_FUZZY && tierUpper === 'TIER_3') {
      meta.skipped_tier3_alias_policy += 1;
      continue;
    }
    const explicitFuzzyAllowed = r.fuzzy_allowed === true;
    const canonicalFallbackAllowed = isCanonical && FUZZY_CANONICAL_FALLBACK_CATEGORIES.has(category);
    const aliasRollout = aliasFuzzyRolloutEligibilityMode({
      category,
      isCanonical,
      tierUpper,
      aliasNorm,
      explicitFuzzyAllowed,
    });
    const canonicalExplicitAllowed = isCanonical && explicitFuzzyAllowed;
    const eligible = canonicalFallbackAllowed || canonicalExplicitAllowed || aliasRollout.eligible;
    if (!eligible) {
      if (!isCanonical) meta.skipped_alias_rollout_policy += 1;
      else meta.skipped_not_fuzzy_allowed += 1;
      continue;
    }
    let eligibilitySource = 'explicit_fuzzy_allowed';
    if (canonicalFallbackAllowed && !explicitFuzzyAllowed) {
      eligibilitySource = 'canonical_fallback';
    } else if (!isCanonical && aliasRollout.eligible) {
      if (aliasRollout.mode === 'alias_explicit_fuzzy_allowed') eligibilitySource = 'explicit_fuzzy_allowed_alias_rollout';
      else if (aliasRollout.mode === 'alias_rollout_fallback_tier1') eligibilitySource = 'alias_rollout_fallback_tier1';
      else if (aliasRollout.mode === 'alias_rollout_fallback_tier2') eligibilitySource = 'alias_rollout_fallback_tier2';
      else if (aliasRollout.mode === 'alias_rollout_fallback_tier3') eligibilitySource = 'alias_rollout_fallback_tier3';
    }
    if (!byCategory[category]) byCategory[category] = [];
    const risk = getRowRiskOverlay(r, policyRiskCtxGlobal);
    if (risk && risk.emit_disabled) {
      meta.risky_alias_rows_total += 1;
      meta.risky_alias_rows_emit_disabled_total += 1;
      meta.risky_alias_rows_by_category[category] = (meta.risky_alias_rows_by_category[category] || 0) + 1;
    }
    const aliasNormCached = aliasNorm;
    const aliasAlnumCached = alnumNorm(aliasNormCached);
    byCategory[category].push({
      ...r,
      _fuzzy_eligibility_source: eligibilitySource,
      _fuzzy_emit_disabled: !!(risk && risk.emit_disabled),
      _fuzzy_policy_risk: risk,
      _entity_type_upper: entityType,
      _tier_upper: tierUpper,
      _alias_norm_cached: aliasNormCached,
      _alias_len_cached: aliasNormCached.length,
      _alias_token_len_cached: aliasNormCached.split(' ').filter(Boolean).length,
      _alias_alnum_cached: aliasAlnumCached,
      _alias_bigrams_cached: aliasAlnumCached.length >= 5 ? bigramSet(aliasNormCached) : new Set(),
      _canonical_slug_cached: toStr(r.entity_slug),
      _hero_slug_cached: toStr(r.hero_slug || ''),
    });
    meta.eligible_rows_total += 1;
    meta.eligible_by_category[category] = (meta.eligible_by_category[category] || 0) + 1;
    if (isCanonical) meta.eligible_alias_tiers.canonical += 1;
    else if (tierUpper === 'TIER_1' || tierUpper === 'STATIC_ALIAS') meta.eligible_alias_tiers.tier1 += 1;
    else if (tierUpper === 'TIER_2') meta.eligible_alias_tiers.tier2 += 1;
    else if (tierUpper === 'TIER_3') meta.eligible_alias_tiers.tier3 += 1;
    else meta.eligible_alias_tiers.other += 1;
  }
  for (const cat of Object.keys(byCategory)) {
    byCategory[cat].sort((a, b) => toStr(b.alias_text_norm).length - toStr(a.alias_text_norm).length);
  }
  return { byCategory, meta };
}

function buildExactSuppressionMaps(exactCandidates) {
  const byCategoryCanonical = new Set();
  const byCategorySourceCanonical = new Set();
  for (const c of safeArray(exactCandidates)) {
    const cat = toStr(c.category).toLowerCase();
    const canonical = toStr(c.canonical_slug || c.canonical_id);
    const source = toStr(c.source);
    const sourceId = toStr(c.source_id);
    if (!cat || !canonical) continue;
    byCategoryCanonical.add(`${cat}|${canonical}`);
    byCategorySourceCanonical.add(`${cat}|${canonical}|${source}|${sourceId}`);
  }
  return { byCategoryCanonical, byCategorySourceCanonical };
}

function fuzzyScoreBase({ sourceType, similarity, aliasLen, dictionaryTier, category, eligibilitySource }) {
  let score = sourceWeightFor(sourceType);
  score += 0.05;
  score += Math.max(0, similarity - 0.8) * 2.2;
  const tier = normalizeTier(dictionaryTier);
  if (tier === 'CANONICAL') score += 0.1;
  else if (tier === 'TIER_1' || tier === 'STATIC_ALIAS') score += 0.06;
  else if (tier === 'TIER_2') score += 0.03;
  else if (tier === 'TIER_3') score -= 0.03;
  if (toStr(eligibilitySource) === 'canonical_fallback') score -= 0.01;
  if (toStr(eligibilitySource).startsWith('alias_rollout_fallback')) score -= 0.01;
  if (aliasLen <= 3) score -= 0.12;
  else if (aliasLen === 4) score -= 0.06;
  if (category === 'rank') score -= 0.04;
  if (category === 'platform') score -= 0.035;
  if (category === 'queue') score -= 0.025;
  if (sourceType === 'comment') score -= 0.02;
  score = Math.max(0, Math.min(2, score));
  return Number(score.toFixed(3));
}

function fuzzyQualityBucket(similarity, threshold, tieMarginActual, tieMarginRequired) {
  const sim = Number(similarity || 0);
  const thr = Number(threshold || 1);
  const marA = Number(tieMarginActual || 0);
  const marR = Number(tieMarginRequired || 1);
  const simDelta = sim - thr;
  const marginDelta = marA - marR;
  if (simDelta >= 0.035 && marginDelta >= 0.025) return 'HIGH';
  if (simDelta >= 0.015 && marginDelta >= 0.01) return 'MEDIUM';
  return 'LOW';
}

function fuzzyReviewRecommended({ category, source, isCanonical, tierUpper, qualityBucket, hasPrimarySupportEquivalent }) {
  const cat = toStr(category).toLowerCase();
  const src = toStr(source).toLowerCase();
  const tier = normalizeTier(tierUpper);
  if (tier === 'TIER_3') return true;
  if ((src === 'title' || src === 'op') && isCanonical && qualityBucket === 'HIGH') return false;
  if (src === 'comment') return true;
  if (tier === 'TIER_2') return true;
  if ((cat === 'hero' || cat === 'map' || cat === 'ability') && !hasPrimarySupportEquivalent) return true;
  if (qualityBucket === 'LOW') return true;
  return false;
}

function fuzzyReviewReasonCodes({
  category,
  source,
  isCanonical,
  tierUpper,
  qualityBucket,
  hasPrimarySupportEquivalent,
  hasCloseSecondChoice,
  plausibility,
}) {
  const reasons = [];
  const cat = toStr(category).toLowerCase();
  const src = toStr(source).toLowerCase();
  const tier = normalizeTier(tierUpper);
  if (src === 'comment') reasons.push('comment_source');
  if (tier === 'TIER_2') reasons.push('tier2_alias');
  if (tier === 'TIER_3') reasons.push('tier3_alias_review_only');
  if ((cat === 'hero' || cat === 'map' || cat === 'ability') && !hasPrimarySupportEquivalent) {
    reasons.push('hero_map_no_primary_equivalent');
    if (cat === 'ability') reasons.push('ability_no_primary_equivalent');
  }
  if (qualityBucket === 'LOW') reasons.push('low_quality_fuzzy');
  if (hasCloseSecondChoice) reasons.push('close_second_choice');
  if (plausibility && !plausibility.plausible) {
    reasons.push('implausible_match_shadow_only');
    for (const r of safeArray(plausibility.reasons)) reasons.push(`implausible:${r}`);
  }
  return unique(reasons).slice(0, 10);
}

/**
 * Per-post fuzzy expansion: dictionary scan, shadow telemetry, optional emits.
 * Wired from buildFuzzyCandidatesForItem; not a copy of n8n structure.
 */
function buildFuzzyCandidatesForItem({ itemJson, dictByCategory, policyRiskCtx }) {
  const postId = toStr(itemJson.post_id).trim();
  const detect = isObject(itemJson.detect) ? itemJson.detect : {};
  const detectIntent = isObject(detect.intent) ? detect.intent : {};
  const intentFlags = getIntentConceptContextFlags(detectIntent);
  const exactCandidates = safeArray(itemJson.entity_candidates_exact);
  const fuzzyPlan = isObject(itemJson.fuzzy_plan) ? itemJson.fuzzy_plan : {};
  const heroTypoCarvePlan = isObject(fuzzyPlan.hero_fuzzy_carve_out) ? fuzzyPlan.hero_fuzzy_carve_out : null;
  const heroTypoCarveSlug = heroTypoCarvePlan && toStr(heroTypoCarvePlan.canonical_slug)
    ? toStr(heroTypoCarvePlan.canonical_slug).toLowerCase()
    : '';

  const allowedCategories = safeArray(fuzzyPlan.allowed_categories).map((x) => toStr(x).toLowerCase());
  const shadowAllowedCategories = safeArray(fuzzyPlan.shadow_allowed_categories).map((x) => toStr(x).toLowerCase());
  const shadowCandidateSpansByCategory = isObject(fuzzyPlan.shadow_candidate_spans) ? fuzzyPlan.shadow_candidate_spans : {};
  const scanCategories = unique([...allowedCategories, ...shadowAllowedCategories]).filter(Boolean);

  const candidateSpansByCategory = isObject(fuzzyPlan.candidate_spans) ? fuzzyPlan.candidate_spans : {};
  const categoryReasons = isObject(fuzzyPlan.category_reasons) ? fuzzyPlan.category_reasons : {};
  const packPolicySignals = isObject(fuzzyPlan.policy_signals) ? fuzzyPlan.policy_signals : {};
  const policySignals = {
    concept_anchor_terms_present: isObject(packPolicySignals.concept_anchor_terms_present)
      ? packPolicySignals.concept_anchor_terms_present
      : {},
    negative_anchor_hits: isObject(packPolicySignals.negative_anchor_hits) ? packPolicySignals.negative_anchor_hits : {},
  };

  const suppress = buildExactSuppressionMaps(exactCandidates);
  const sourceRawCache = new Map();
  function getSourceRawCached(source, sourceId) {
    const key = `${toStr(source)}|${toStr(sourceId || '')}`;
    if (sourceRawCache.has(key)) return sourceRawCache.get(key);
    const raw = getSpanRaw(source, sourceId);
    sourceRawCache.set(key, raw);
    return raw;
  }

  function exactPresentInfo({ category, canonical_slug, source, source_id }) {
    const cat = toStr(category).toLowerCase();
    const canonical = toStr(canonical_slug);
    const src = toStr(source);
    const sid = toStr(source_id || '');
    if (!cat || !canonical) return { exact_present: false, exact_present_reason: null };
    const byCatKey = `${cat}|${canonical}`;
    const byCatSrcKey = `${cat}|${canonical}|${src}|${sid}`;
    if (src === 'title' || src === 'op') {
      if (suppress.byCategorySourceCanonical.has(byCatSrcKey)) {
        return { exact_present: true, exact_present_reason: 'exact_same_source' };
      }
    }
    if (suppress.byCategoryCanonical.has(byCatKey)) {
      return { exact_present: true, exact_present_reason: 'exact_same_category' };
    }
    return { exact_present: false, exact_present_reason: null };
  }

  const seenFuzzy = new Set();
  const fuzzyCandidates = [];
  const emittedCountByPostCat = {};
  const shadowHitsByCategory = {};
  const shadowCountsByCategory = {};

  const fuzzyMeta = {
    policy_version: 'fuzzy_v11_9_policy_risk_overlay_collision_commonword_emit_disable',
    policy_contract_version: 'fuzzy_contract_v3',
    overshoot_mode: OVERSHOOT_MODE,
    hero_typo_carve_out: heroTypoCarveSlug
      ? {
          canonical_slug: toStr(heroTypoCarvePlan.canonical_slug),
          near_match_token: heroTypoCarvePlan.near_match_token ?? null,
          near_match_target: heroTypoCarvePlan.near_match_target ?? null,
        }
      : null,
    allowed_categories_input: allowedCategories,
    shadow_allowed_categories_input: shadowAllowedCategories,
    categories_scanned: [],
    shadow_only_categories_scanned: [],
    category_stats: {},
    suppressed_by_exact_count: 0,
    ambiguous_rejected_count: 0,
    below_threshold_count: 0,
    short_alias_rejected_count: 0,
    alias_source_gated_count: 0,
    alias_context_gated_count: 0,
    generic_gram_rejected_count: 0,
    risky_alias_emit_disabled_count: 0,
    row_examined_total: 0,
    gram_checked_total: 0,
    similarity_calls_total: 0,
    prefilter_rejected_count: 0,
    hero_typo_carve_out_threshold_bypass_count: 0,
    generated_count: 0,
    generated_review_recommended_count: 0,
    plausibility_rejected_shadow_only_count: 0,
    shadow_hit_recorded_count: 0,
    shadow_span_observed_count: 0,
    shadow_best_hit_below_threshold_count: 0,
    shadow_best_hit_implausible_count: 0,
    shadow_second_best_recorded_count: 0,
    shadow_no_match_span_count: 0,
    shadow_fallback_span_count: 0,
    shadow_topk_per_category: SHADOW_TOPK_PER_CATEGORY,
    shadow_enabled: SHADOW_ENABLED,
    policy_signals_seen: {
      concept_anchor_terms_present: policySignals.concept_anchor_terms_present,
      negative_anchor_hits: policySignals.negative_anchor_hits,
      intent_flags: intentFlags,
    },
    policy_risk_ctx_seen: {
      common_word_alias_norms_count: policyRiskCtx?.common_word_alias_norms ? policyRiskCtx.common_word_alias_norms.size : 0,
    },
    plausibility_anchor_terms_bypass_count: 0,
    plausibility_negative_anchor_reject_count: 0,
    plausibility_intent_bypass_count: 0,
    plausibility_exact_present_bypass_count: 0,
    primary_alias_relax_pilot: {
      enabled: PRIMARY_ALIAS_RELAX_PILOT.enabled,
      candidate_checks: 0,
      applied_count: 0,
      generated_with_pilot_count: 0,
      threshold_relax_saves_count: 0,
      tie_margin_relax_saves_count: 0,
      categories: Array.from(PRIMARY_ALIAS_RELAX_PILOT.categories),
      sources: Array.from(PRIMARY_ALIAS_RELAX_PILOT.sources),
      min_alias_len: PRIMARY_ALIAS_RELAX_PILOT.min_alias_len,
    },
    canonical_primary_variant_relax: {
      candidate_checks: 0,
      applied_count: 0,
      generated_count: 0,
      norm_eq_count: 0,
      editdist_eq_count: 0,
      threshold_save_count: 0,
      tie_save_count: 0,
      exact_same_source_bypass_count: 0,
      exact_same_source_generated_count: 0,
      exact_same_source_blocked_count: 0,
    },
    blocker_counts: { 'exact:exact_same_source': 0 },
  };

  function canEmitMoreForCategory(cat) {
    const c = toStr(cat).toLowerCase();
    const cur = Number(emittedCountByPostCat[c] || 0);
    const limit = OVERSHOOT_MODE ? OVERSHOOT_MAX_CANDIDATES_PER_POST_CATEGORY : 3;
    return cur < limit;
  }

  function noteEmitForCategory(cat) {
    const c = toStr(cat).toLowerCase();
    emittedCountByPostCat[c] = Number(emittedCountByPostCat[c] || 0) + 1;
  }

  function recordShadowHit(cat, hit) {
    if (!SHADOW_ENABLED) return;
    const c = toStr(cat).toLowerCase();
    if (!shadowHitsByCategory[c]) shadowHitsByCategory[c] = [];
    shadowHitsByCategory[c].push(hit);
    shadowCountsByCategory[c] = (shadowCountsByCategory[c] || 0) + 1;
    fuzzyMeta.shadow_hit_recorded_count += 1;
    shadowHitsByCategory[c].sort((a, b) => (b.similarity - a.similarity) || (b.score_base - a.score_base));
    if (shadowHitsByCategory[c].length > SHADOW_TOPK_PER_CATEGORY) {
      shadowHitsByCategory[c] = shadowHitsByCategory[c].slice(0, SHADOW_TOPK_PER_CATEGORY);
    }
  }

  function getSpanRaw(source, sourceId) {
    const src = isObject(detect.sources) ? detect.sources : {};
    if (source === 'title') return toStr(src?.title?.raw);
    if (source === 'op') return toStr(src?.op?.raw);
    if (source === 'comment') {
      const comments = safeArray(src.comments);
      const hit = comments.find((c) => toStr(c.id) === toStr(sourceId));
      return toStr(hit?.raw);
    }
    return '';
  }

  function getDeterministicCategoryContextDiagnostics(cat) {
    const c = toStr(cat).toLowerCase();
    const reasons = [];
    const hasExactCanonical = exactCandidates.some(
      (ec) =>
        toStr(ec.category).toLowerCase() === c &&
        (toStr(ec.match_type).toLowerCase() === 'exact_canonical' ||
          (toStr(ec.match_type).toLowerCase() === 'exact' && ec.is_canonical === true))
    );
    if (hasExactCanonical) reasons.push('exact_canonical_same_category');
    const intent = isObject(detect.intent) ? detect.intent : {};
    const primaryCats = safeArray(intent.target_categories_primary).map((x) => toStr(x).toLowerCase());
    if (primaryCats.includes(c)) reasons.push('primary_intent_category');
    if (c === 'rank' && intent.has_rank_context) reasons.push('rank_context_flag');
    if (c === 'platform' && intent.has_platform_context) reasons.push('platform_context_flag');
    if (c === 'queue' && intent.has_queue_context) reasons.push('queue_context_flag');
    if (c === 'map' && intent.has_map_context) reasons.push('map_context_flag');
    if (c === 'mode' && intent.has_mode_context) reasons.push('mode_context_flag');
    if (c === 'role' && intent.has_role_context) reasons.push('role_context_flag');
    if (c === 'ability' && (intent.has_ability_context || intent.has_hero_context)) {
      if (intent.has_ability_context) reasons.push('ability_context_flag');
      if (intent.has_hero_context) reasons.push('hero_context_flag');
    }
    return { present: reasons.length > 0, reasons: unique(reasons).slice(0, 8) };
  }

  /* ——— scan categories ——— */
  for (const cat of scanCategories) {
    let dictRows = safeArray(dictByCategory[cat]);
    if (toStr(cat).toLowerCase() === 'hero' && heroTypoCarveSlug) {
      dictRows = dictRows.filter(
        (r) => r.is_canonical === true && toStr(r.entity_slug).toLowerCase() === heroTypoCarveSlug,
      );
    }
    const emitCandidates = allowedCategories.includes(cat);
    const isShadowOnlyCategory = !emitCandidates && shadowAllowedCategories.includes(cat);
    if (isShadowOnlyCategory) fuzzyMeta.shadow_only_categories_scanned.push(cat);

    let spans = emitCandidates ? safeArray(candidateSpansByCategory[cat]) : safeArray(shadowCandidateSpansByCategory[cat]);

    if (!spans.length && isShadowOnlyCategory) {
      const titleRaw = getSpanRaw('title', '');
      const opRaw = getSpanRaw('op', '');
      const titleNorm = normalizeSpanText(titleRaw);
      const opNorm = normalizeSpanText(opRaw);
      if (titleNorm) {
        spans.push({ source: 'title', source_id: '', text_norm: titleNorm, reason: 'shadow_fallback_title' });
        fuzzyMeta.shadow_fallback_span_count += 1;
      }
      if (opNorm) {
        spans.push({ source: 'op', source_id: '', text_norm: opNorm, reason: 'shadow_fallback_op' });
        fuzzyMeta.shadow_fallback_span_count += 1;
      }
    }

    if (!spans.length && emitCandidates) {
      const allowFallbackCats = new Set(['hero', 'map', 'ability', 'mode', 'role']);
      if (allowFallbackCats.has(cat)) {
        const titleRaw = getSpanRaw('title', '');
        const opRaw = getSpanRaw('op', '');
        const titleNorm = normalizeSpanText(titleRaw);
        const opNorm = normalizeSpanText(opRaw);
        if (titleNorm) spans.push({ source: 'title', source_id: '', text_norm: titleNorm, reason: 'fallback_pack_allowed_full_title' });
        if (opNorm) spans.push({ source: 'op', source_id: '', text_norm: opNorm, reason: 'fallback_pack_allowed_full_op' });
      }
    }

    fuzzyMeta.categories_scanned.push(cat);
    fuzzyMeta.category_stats[cat] = {
      dict_rows_considered: dictRows.length,
      span_count: spans.length,
      generated: 0,
      generated_review_recommended: 0,
      suppressed_by_exact: 0,
      ambiguous_rejected: 0,
      below_threshold: 0,
      short_alias_rejected: 0,
      alias_source_gated: 0,
      alias_context_gated: 0,
      prefilter_rejected: 0,
      plausibility_rejected_shadow_only: 0,
      shadow_recorded: 0,
      shadow_span_observed: 0,
      shadow_best_hit_below_threshold: 0,
      shadow_best_hit_implausible: 0,
      shadow_second_best_recorded: 0,
      shadow_no_match_span: 0,
      shadow_fallback_span: 0,
      row_examined: 0,
      gram_checked: 0,
      similarity_calls: 0,
    };

    if (!dictRows.length || !spans.length) continue;

    const allowedTypes = new Set(categoryToEntityTypes(cat));
    const categoryContextDiag = getDeterministicCategoryContextDiagnostics(cat);
    const categoryContextPresent = categoryContextDiag.present;
    const categoryReason = toStr(categoryReasons[cat] || '');
    const categoryCanAttemptCanonicalPrimaryVariant = canonicalPrimaryVariantReasonAllowed(cat, categoryReason);

    for (const span of spans) {
      const source = toStr(span.source);
      if (source === 'anchor') continue;
      const sourceId = toStr(span.source_id || '');
      const spanTextNorm = toStr(span.text_norm).trim();
      const spanReason = toStr(span.reason || '');
      const isFallbackSpan = spanReason === 'fallback_pack_allowed_full_title' || spanReason === 'fallback_pack_allowed_full_op';
      if (!spanTextNorm) continue;

      const sourceRaw = getSourceRawCached(source, sourceId);
      const ngramCache = new Map();
      const gramInfoCache = new Map();

      let topHit = null;
      let secondHit = null;

      for (const row of dictRows) {
        const entityType = row._entity_type_upper || toStr(row.entity_type).toUpperCase();
        if (!allowedTypes.has(entityType)) continue;

        const canonicalSlug = row._canonical_slug_cached || toStr(row.entity_slug);
        const aliasNormText = row._alias_norm_cached || toStr(row.alias_text_norm).trim();
        if (!canonicalSlug || !aliasNormText) continue;

        fuzzyMeta.row_examined_total += 1;
        fuzzyMeta.category_stats[cat].row_examined += 1;

        const byCatKey = `${cat}|${canonicalSlug}`;
        const byCatSrcKey = `${cat}|${canonicalSlug}|${source}|${sourceId}`;
        const isCanonical = row.is_canonical === true;

        let sameSourceExactSuppressed = false;
        let sameSourceExactSuppressionBypassed = false;

        if (source === 'title' || source === 'op') {
          if (suppress.byCategorySourceCanonical.has(byCatSrcKey)) {
            sameSourceExactSuppressed = true;
            fuzzyMeta.suppressed_by_exact_count += 1;
            fuzzyMeta.category_stats[cat].suppressed_by_exact += 1;
            fuzzyMeta.blocker_counts['exact:exact_same_source'] += 1;
          }
        } else if (suppress.byCategoryCanonical.has(byCatKey)) {
          fuzzyMeta.suppressed_by_exact_count += 1;
          fuzzyMeta.category_stats[cat].suppressed_by_exact += 1;
          if (!isShadowOnlyCategory && !(OVERSHOOT_MODE && OVERSHOOT_DISABLE_SUPPRESSION_MAPS)) continue;
        }

        if (isFallbackSpan && !isCanonical) {
          fuzzyMeta.alias_source_gated_count += 1;
          fuzzyMeta.category_stats[cat].alias_source_gated += 1;
          continue;
        }

        const tierUpper = row._tier_upper || normalizeTier(row.tier);

        if (!isCanonical) {
          if ((cat === 'hero' || cat === 'map' || cat === 'ability') && source === 'comment') {
            fuzzyMeta.alias_source_gated_count += 1;
            fuzzyMeta.category_stats[cat].alias_source_gated += 1;
            continue;
          }
          if ((tierUpper === 'TIER_2' || tierUpper === 'TIER_3') && !['title', 'op'].includes(source)) {
            fuzzyMeta.alias_source_gated_count += 1;
            fuzzyMeta.category_stats[cat].alias_source_gated += 1;
            continue;
          }
        }

        const aliasLen = row._alias_len_cached || aliasNormText.length;
        const aliasTokenLen = row._alias_token_len_cached || aliasNormText.split(' ').filter(Boolean).length;

        const canAttemptDirectVariant =
          categoryCanAttemptCanonicalPrimaryVariant &&
          canAttemptCanonicalPrimaryVariantDirect({
            category: cat,
            source,
            isCanonical,
            heroSlug: row._hero_slug_cached || toStr(row.hero_slug || ''),
            categoryReason,
          });

        if (sameSourceExactSuppressed && !canAttemptDirectVariant && !isShadowOnlyCategory && !(OVERSHOOT_MODE && OVERSHOOT_DISABLE_SUPPRESSION_MAPS)) {
          fuzzyMeta.canonical_primary_variant_relax.exact_same_source_blocked_count += 1;
          continue;
        }

        if (aliasLen <= 2) {
          fuzzyMeta.short_alias_rejected_count += 1;
          fuzzyMeta.category_stats[cat].short_alias_rejected += 1;
          continue;
        }

        if (aliasLen <= 3 && ['rank', 'platform', 'queue'].includes(cat)) {
          fuzzyMeta.short_alias_rejected_count += 1;
          fuzzyMeta.category_stats[cat].short_alias_rejected += 1;
          continue;
        }

        let ngrams = ngramCache.get(aliasTokenLen);
        if (!ngrams) {
          ngrams = generateSpanCandidatesForAliasTokenLength(spanTextNorm, aliasTokenLen, source);
          ngramCache.set(aliasTokenLen, ngrams);
        }
        if (!ngrams.length) continue;

        const rowThreshold = getThresholdFor(cat, aliasNormText, source, { isCanonical, tierUpper });

        const aliasInfo = {
          alnum: row._alias_alnum_cached || alnumNorm(aliasNormText),
          bigrams: row._alias_bigrams_cached || new Set(),
        };

        let bestLocal = null;
        const aliasCharLen = aliasNormText.length;

        const directVariantHit = canAttemptDirectVariant
          ? getCanonicalPrimaryVariantDirectHit({
              category: cat,
              source,
              isCanonical,
              heroSlug: row._hero_slug_cached || toStr(row.hero_slug || ''),
              categoryReason,
              aliasNorm: aliasNormText,
              canonicalSlug,
              ngrams,
              spanTextNorm,
            })
          : null;

        if (sameSourceExactSuppressed) {
          if (directVariantHit && !isShadowOnlyCategory) {
            sameSourceExactSuppressionBypassed = true;
            fuzzyMeta.canonical_primary_variant_relax.exact_same_source_bypass_count += 1;
          } else if (!(OVERSHOOT_MODE && OVERSHOOT_DISABLE_SUPPRESSION_MAPS)) {
            fuzzyMeta.canonical_primary_variant_relax.exact_same_source_blocked_count += 1;
            continue;
          }
        }

        if (directVariantHit) {
          bestLocal = {
            gram: directVariantHit.gram,
            similarity: directVariantHit.similarity,
            directVariantProfile: directVariantHit.profile,
            sameSourceExactSuppressionBypassed,
          };
        }

        for (const gram of ngrams) {
          const gramTokens = gram.split(' ').length;
          const allowDrift = isCanonical ? 2 : 1;
          if (Math.abs(gramTokens - aliasTokenLen) > allowDrift) continue;
          if (aliasLen <= 4 && gramTokens !== aliasTokenLen) continue;

          const maxPoss = maxPossibleSimByLen(gram.length, aliasCharLen);
          if (maxPoss + 1e-6 < rowThreshold) continue;

          let gramInfo = gramInfoCache.get(gram);
          if (!gramInfo) {
            const al = alnumNorm(gram);
            gramInfo = { alnum: al, bigrams: al.length >= 5 ? bigramSet(gram) : new Set() };
            gramInfoCache.set(gram, gramInfo);
          }

          fuzzyMeta.gram_checked_total += 1;
          fuzzyMeta.category_stats[cat].gram_checked += 1;

          if (!passesPrefilter(gramInfo, aliasInfo, { isCanonical, source })) {
            fuzzyMeta.prefilter_rejected_count += 1;
            fuzzyMeta.category_stats[cat].prefilter_rejected += 1;
            continue;
          }

          fuzzyMeta.similarity_calls_total += 1;
          fuzzyMeta.category_stats[cat].similarity_calls += 1;
          const sim = tokenSimilarity(gram, aliasNormText);

          if (bestLocal === null || sim > bestLocal.similarity) {
            bestLocal = { gram, similarity: sim };
            if (sim >= 0.9995) break;
          }
        }

        if (!bestLocal) continue;

        const hit = {
          row,
          aliasNorm: aliasNormText,
          canonicalSlug,
          similarity: bestLocal.similarity,
          matchedGram: bestLocal.gram,
          directVariantProfile: bestLocal.directVariantProfile || null,
          sameSourceExactSuppressionBypassed: bestLocal.sameSourceExactSuppressionBypassed === true,
        };

        if (!topHit || hit.similarity > topHit.similarity) {
          secondHit = topHit;
          topHit = hit;
        } else if (!secondHit || hit.similarity > secondHit.similarity) {
          secondHit = hit;
        }
      }

      const shadowSpanId = stableId([postId, 'shadow', cat, source, sourceId || 'na', spanReason || 'na']);

      if (!topHit) {
        const shadowSpanIdNoMatch = stableId([postId, 'shadow', cat, source, sourceId || 'na', spanReason || 'na']);
        fuzzyMeta.shadow_no_match_span_count += 1;
        fuzzyMeta.category_stats[cat].shadow_no_match_span += 1;
        recordShadowHit(cat, {
          shadow_span_id: shadowSpanIdNoMatch,
          category: cat,
          canonical_slug: null,
          exact_present: false,
          exact_present_reason: null,
          hero_slug: null,
          source,
          source_id: sourceId || null,
          matched_text: null,
          similarity: 0,
          threshold_used: null,
          reason: 'no_match_after_prefilter',
          plausibility: { plausible: true, reasons: [] },
          fuzzy_quality_bucket: null,
          second_best_similarity: null,
          second_best_canonical_slug: null,
          context_snippet: buildSnippet(sourceRaw),
          score_base: 0,
        });
        fuzzyMeta.category_stats[cat].shadow_recorded += 1;
        continue;
      }

      const top = topHit;
      const second = secondHit || null;

      fuzzyMeta.shadow_span_observed_count += 1;
      fuzzyMeta.category_stats[cat].shadow_span_observed += 1;

      const topRow = top.row;
      const topRisk = isObject(topRow._fuzzy_policy_risk) ? topRow._fuzzy_policy_risk : getRowRiskOverlay(topRow, policyRiskCtx);
      const topIsCanonical = topRow.is_canonical === true;
      const topTierUpper = normalizeTier(topRow.tier);

      if (!topIsCanonical && (topTierUpper === 'TIER_2' || topTierUpper === 'TIER_3') && !categoryContextPresent) {
        fuzzyMeta.alias_context_gated_count += 1;
        fuzzyMeta.category_stats[cat].alias_context_gated += 1;

        const ep = exactPresentInfo({ category: cat, canonical_slug: toStr(top.canonicalSlug), source, source_id: sourceId || null });

        recordShadowHit(cat, {
          shadow_span_id: shadowSpanId,
          category: cat,
          canonical_slug: toStr(top.canonicalSlug),
          exact_present: ep.exact_present,
          exact_present_reason: ep.exact_present_reason,
          hero_slug: toStr(top.row?.hero_slug || '') || null,
          source,
          source_id: sourceId || null,
          matched_text: toStr(top.matchedGram),
          similarity: Number(top.similarity.toFixed(4)),
          threshold_used: null,
          reason: 'best_hit_observe_alias_context_gated',
          plausibility: plausibilityCheck({
            category: cat,
            matchedGram: top.matchedGram,
            spanTextNorm,
            source,
            canonicalSlug: toStr(top.canonicalSlug),
            policySignals,
            intentFlags,
            exactPresent: ep.exact_present,
          }),
          fuzzy_quality_bucket: null,
          second_best_similarity: second && toStr(second.canonicalSlug) !== toStr(top.canonicalSlug) ? Number(second.similarity.toFixed(4)) : null,
          second_best_canonical_slug: second ? toStr(second.canonicalSlug) : null,
          context_snippet: buildSnippet(sourceRaw),
          score_base: 0,
        });
        fuzzyMeta.category_stats[cat].shadow_recorded += 1;
        continue;
      }

      const pilotRelaxProfile = getPrimaryAliasRelaxPilotProfile({
        category: cat,
        sourceType: source,
        isCanonical: topIsCanonical,
        tierUpper: topTierUpper,
        aliasNorm: top.aliasNorm,
        categoryContextPresent,
      });

      const thresholdBase = getThresholdFor(cat, top.aliasNorm, source, { isCanonical: topIsCanonical, tierUpper: topTierUpper });
      const threshold = getThresholdFor(cat, top.aliasNorm, source, {
        isCanonical: topIsCanonical,
        tierUpper: topTierUpper,
        relaxProfile: pilotRelaxProfile,
      });

      const tieMarginBase = getTieMarginFor(top.aliasNorm, source, { isCanonical: topIsCanonical, tierUpper: topTierUpper });
      const tieMargin = getTieMarginFor(top.aliasNorm, source, {
        isCanonical: topIsCanonical,
        tierUpper: topTierUpper,
        relaxProfile: pilotRelaxProfile,
      });

      const topCanonical = toStr(top.canonicalSlug);
      const secondCanonical = second ? toStr(second.canonicalSlug) : '';
      const margin = second ? top.similarity - second.similarity : 1;

      const epTop = exactPresentInfo({ category: cat, canonical_slug: topCanonical, source, source_id: sourceId || null });
      fuzzyMeta.canonical_primary_variant_relax.candidate_checks += 1;
      const canonicalPrimaryVariantRelaxProfile = getCanonicalPrimaryVariantRelaxProfile({
        category: cat,
        source,
        isCanonical: topIsCanonical,
        heroSlug: toStr(topRow.hero_slug || ''),
        categoryReason: toStr(categoryReasons[cat] || ''),
        matchedGram: top.matchedGram,
        aliasNorm: top.aliasNorm,
        similarity: top.similarity,
        exactPresent: epTop.exact_present,
        exactPresentReason: epTop.exact_present_reason,
        thresholdBase,
        tieMarginBase,
        secondCanonical,
        margin,
        directProfile: isObject(top.directVariantProfile) ? top.directVariantProfile : null,
      });
      const canonicalPrimaryVariantRelax = !!(canonicalPrimaryVariantRelaxProfile && canonicalPrimaryVariantRelaxProfile.relax === true);
      if (canonicalPrimaryVariantRelax) {
        fuzzyMeta.canonical_primary_variant_relax.applied_count += 1;
        if (canonicalPrimaryVariantRelaxProfile.mode === 'NORM_EQ') fuzzyMeta.canonical_primary_variant_relax.norm_eq_count += 1;
        if (canonicalPrimaryVariantRelaxProfile.mode === 'EDITDIST_EQ') fuzzyMeta.canonical_primary_variant_relax.editdist_eq_count += 1;
        if (canonicalPrimaryVariantRelaxProfile.threshold_save) fuzzyMeta.canonical_primary_variant_relax.threshold_save_count += 1;
        if (canonicalPrimaryVariantRelaxProfile.tie_save) fuzzyMeta.canonical_primary_variant_relax.tie_save_count += 1;
      }

      const tieAmbiguous = second && secondCanonical && secondCanonical !== topCanonical && margin < tieMargin;
      if (tieAmbiguous && !canonicalPrimaryVariantRelax) {
        fuzzyMeta.ambiguous_rejected_count += 1;
        fuzzyMeta.category_stats[cat].ambiguous_rejected += 1;

        const tieMarginActualShadow = Number((second ? top.similarity - second.similarity : 1).toFixed(4));
        const qualityBucketShadow = fuzzyQualityBucket(top.similarity, threshold, tieMarginActualShadow, tieMargin);

        const ep = exactPresentInfo({ category: cat, canonical_slug: topCanonical, source, source_id: sourceId || null });

        recordShadowHit(cat, {
          shadow_span_id: shadowSpanId,
          category: cat,
          canonical_slug: topCanonical,
          exact_present: ep.exact_present,
          exact_present_reason: ep.exact_present_reason,
          hero_slug: toStr(topRow.hero_slug || '') || null,
          policy_risk: topRisk,
          source,
          source_id: sourceId || null,
          matched_text: toStr(top.matchedGram),
          similarity: Number(top.similarity.toFixed(4)),
          threshold_used: Number(threshold.toFixed(4)),
          reason: 'best_hit_observe_tie_ambiguous',
          plausibility: plausibilityCheck({
            category: cat,
            matchedGram: top.matchedGram,
            spanTextNorm,
            source,
            canonicalSlug: topCanonical,
            policySignals,
            intentFlags,
            exactPresent: ep.exact_present,
          }),
          fuzzy_quality_bucket: qualityBucketShadow,
          second_best_similarity: second ? Number(second.similarity.toFixed(4)) : null,
          second_best_canonical_slug: second ? toStr(second.canonicalSlug) : null,
          context_snippet: buildSnippet(sourceRaw),
          score_base: 0,
        });
        fuzzyMeta.category_stats[cat].shadow_recorded += 1;
        continue;
      }

      const carveTok = toStr(heroTypoCarvePlan?.near_match_token || '').toLowerCase();
      const heroTypoCarveThresholdPass =
        Boolean(heroTypoCarveSlug) &&
        Boolean(carveTok) &&
        toStr(cat).toLowerCase() === 'hero' &&
        topIsCanonical &&
        toStr(topCanonical).toLowerCase() === heroTypoCarveSlug &&
        (source === 'title' || source === 'op') &&
        toStr(top.matchedGram).toLowerCase() === carveTok &&
        top.similarity >= HERO_TYPO_CARVE_OUT_MIN_SIMILARITY;

      if (top.similarity < threshold && !canonicalPrimaryVariantRelax) {
        if (heroTypoCarveThresholdPass) {
          fuzzyMeta.hero_typo_carve_out_threshold_bypass_count += 1;
        } else {
          fuzzyMeta.below_threshold_count += 1;
          fuzzyMeta.category_stats[cat].below_threshold += 1;

          if (!OVERSHOOT_MODE) {
            const ep = exactPresentInfo({ category: cat, canonical_slug: topCanonical, source, source_id: sourceId || null });
            const plausBelow = plausibilityCheck({
              category: cat,
              matchedGram: top.matchedGram,
              spanTextNorm,
              source,
              canonicalSlug: topCanonical,
              policySignals,
              intentFlags,
              exactPresent: ep.exact_present,
            });

            const tieMarginActualShadow = Number((second ? top.similarity - second.similarity : 1).toFixed(4));
            const qualityBucketShadow = fuzzyQualityBucket(top.similarity, threshold, tieMarginActualShadow, tieMargin);

            recordShadowHit(cat, {
              shadow_span_id: shadowSpanId,
              category: cat,
              canonical_slug: topCanonical,
              exact_present: ep.exact_present,
              exact_present_reason: ep.exact_present_reason,
              hero_slug: toStr(topRow.hero_slug || '') || null,
              policy_risk: topRisk,
              source,
              source_id: sourceId || null,
              matched_text: toStr(top.matchedGram),
              similarity: Number(top.similarity.toFixed(4)),
              threshold_used: Number(threshold.toFixed(4)),
              reason: 'best_hit_observe_below_threshold',
              plausibility: plausBelow,
              fuzzy_quality_bucket: qualityBucketShadow,
              second_best_similarity:
                second && secondCanonical && secondCanonical !== topCanonical ? Number(second.similarity.toFixed(4)) : null,
              second_best_canonical_slug: second && secondCanonical && secondCanonical !== topCanonical ? toStr(second.canonicalSlug) : null,
              context_snippet: buildSnippet(sourceRaw),
              score_base: 0,
            });
            fuzzyMeta.category_stats[cat].shadow_recorded += 1;
            continue;
          }

          const srcOk = OVERSHOOT_ALLOW_SOURCES.has(source);
          let floor = Math.max(OVERSHOOT_MIN_SIMILARITY_FLOOR, threshold - OVERSHOOT_THRESHOLD_DELTA);
          if (cat === 'queue' || cat === 'rank') floor = Math.min(floor, OVERSHOOT_MIN_SIMILARITY_FLOOR_FALLBACK);
          const nearOk = srcOk && top.similarity >= floor;
          if (!nearOk) continue;
        }
      }

      const plausibility = plausibilityCheck({
        category: cat,
        matchedGram: top.matchedGram,
        spanTextNorm,
        source,
        canonicalSlug: topCanonical,
        policySignals,
        intentFlags,
        exactPresent: epTop.exact_present,
      });

      const cap = isObject(policySignals.concept_anchor_terms_present) ? policySignals.concept_anchor_terms_present : {};
      if (
        (cat === 'rank' && cap.rank === true) ||
        (cat === 'queue' && cap.queue === true) ||
        (cat === 'platform' && cap.platform === true)
      ) {
        fuzzyMeta.plausibility_anchor_terms_bypass_count += 1;
      }
      if (plausibility && plausibility.bypass) {
        if (plausibility.bypass.bypassMissingAnchorByIntent) fuzzyMeta.plausibility_intent_bypass_count += 1;
        if (plausibility.bypass.bypassMissingAnchorByExactPresent) fuzzyMeta.plausibility_exact_present_bypass_count += 1;
      }
      if (safeArray(policySignals.negative_anchor_hits.rank).length > 0 || safeArray(policySignals.negative_anchor_hits.platform_switch).length > 0) {
        if (!plausibility.plausible) fuzzyMeta.plausibility_negative_anchor_reject_count += 1;
      }

      const eligibilitySource = toStr(topRow._fuzzy_eligibility_source || '');
      const tieMarginActual = Number((second ? margin : 1).toFixed(4));
      const qualityBucket = fuzzyQualityBucket(top.similarity, threshold, tieMarginActual, tieMargin);
      const hasCloseSecondChoice = Boolean(
        second && secondCanonical && secondCanonical !== topCanonical && tieMarginActual < Number((tieMargin + 0.015).toFixed(4))
      );

      const scoreBase = fuzzyScoreBase({
        sourceType: source,
        similarity: top.similarity,
        aliasLen: toStr(top.aliasNorm).length,
        dictionaryTier: topRow.tier,
        category: cat,
        eligibilitySource,
      });

      const plausibilityForShadow = plausibility;
      const isBelowThresholdBest = top.similarity < threshold;
      const isImplausibleBest = !plausibilityForShadow.plausible;

      if (isBelowThresholdBest) {
        fuzzyMeta.shadow_best_hit_below_threshold_count += 1;
        fuzzyMeta.category_stats[cat].shadow_best_hit_below_threshold += 1;
      }
      if (isImplausibleBest) {
        fuzzyMeta.shadow_best_hit_implausible_count += 1;
        fuzzyMeta.category_stats[cat].shadow_best_hit_implausible += 1;
      }

      const shadowReason = isImplausibleBest ? 'best_hit_observe_implausible' : isBelowThresholdBest ? 'best_hit_observe_below_threshold' : 'best_hit_observe';

      recordShadowHit(cat, {
        shadow_span_id: shadowSpanId,
        category: cat,
        canonical_slug: topCanonical,
        exact_present: epTop.exact_present,
        exact_present_reason: epTop.exact_present_reason,
        hero_slug: toStr(topRow.hero_slug || '') || null,
        policy_risk: topRisk,
        source,
        source_id: sourceId || null,
        matched_text: toStr(top.matchedGram),
        similarity: Number(top.similarity.toFixed(4)),
        threshold_used: Number(threshold.toFixed(4)),
        reason: shadowReason,
        plausibility: plausibilityForShadow,
        fuzzy_quality_bucket: qualityBucket,
        second_best_similarity: second && secondCanonical && secondCanonical !== topCanonical ? Number(second.similarity.toFixed(4)) : null,
        second_best_canonical_slug: second && secondCanonical && secondCanonical !== topCanonical ? toStr(second.canonicalSlug) : null,
        context_snippet: buildSnippet(sourceRaw),
        score_base: scoreBase,
        variant_relax_candidate: canonicalPrimaryVariantRelax === true,
        variant_relax_mode: canonicalPrimaryVariantRelax ? toStr(canonicalPrimaryVariantRelaxProfile?.mode || '') : null,
        exact_same_source_variant_emit_relax: top.sameSourceExactSuppressionBypassed === true,
      });
      fuzzyMeta.category_stats[cat].shadow_recorded += 1;

      if (second && secondCanonical && secondCanonical !== topCanonical) {
        const marginForShadow = Number((top.similarity - second.similarity).toFixed(4));
        if (marginForShadow <= Number((tieMargin + 0.02).toFixed(4))) {
          fuzzyMeta.shadow_second_best_recorded_count += 1;
          fuzzyMeta.category_stats[cat].shadow_second_best_recorded += 1;

          const ep2 = exactPresentInfo({ category: cat, canonical_slug: secondCanonical, source, source_id: sourceId || null });

          recordShadowHit(cat, {
            shadow_span_id: shadowSpanId,
            category: cat,
            canonical_slug: secondCanonical,
            exact_present: ep2.exact_present,
            exact_present_reason: ep2.exact_present_reason,
            hero_slug: toStr(second.row?.hero_slug || '') || null,
            policy_risk: getRowRiskOverlay(second.row, policyRiskCtx),
            source,
            source_id: sourceId || null,
            matched_text: toStr(top.matchedGram),
            similarity: Number(second.similarity.toFixed(4)),
            threshold_used: Number(threshold.toFixed(4)),
            reason: 'second_best_observe_close',
            plausibility: plausibilityForShadow,
            fuzzy_quality_bucket: qualityBucket,
            second_best_similarity: Number(top.similarity.toFixed(4)),
            second_best_canonical_slug: topCanonical,
            context_snippet: buildSnippet(sourceRaw),
            score_base: scoreBase,
          });
          fuzzyMeta.category_stats[cat].shadow_recorded += 1;
        }
      }

      if (!plausibility.plausible) {
        fuzzyMeta.plausibility_rejected_shadow_only_count += 1;
        fuzzyMeta.category_stats[cat].plausibility_rejected_shadow_only += 1;
        continue;
      }

      if (!emitCandidates) continue;

      if ((topRow && topRow._fuzzy_emit_disabled === true) || (topRisk && topRisk.emit_disabled)) {
        fuzzyMeta.risky_alias_emit_disabled_count += 1;
        fuzzyMeta.category_stats[cat].risky_alias_emit_disabled = (fuzzyMeta.category_stats[cat].risky_alias_emit_disabled || 0) + 1;
        continue;
      }

      const dedupeKey = [postId, cat, topCanonical, source, sourceId, toStr(top.matchedGram), 'fuzzy'].join('|');
      if (seenFuzzy.has(dedupeKey)) continue;
      seenFuzzy.add(dedupeKey);

      if (!canEmitMoreForCategory(cat)) continue;

      const hasPrimarySupportEquivalent = source === 'title' || source === 'op';
      const reviewRecommended = fuzzyReviewRecommended({
        category: cat,
        source,
        isCanonical: topIsCanonical,
        tierUpper: topTierUpper,
        qualityBucket,
        hasPrimarySupportEquivalent,
      });

      const reviewReasonCodes = fuzzyReviewReasonCodes({
        category: cat,
        source,
        isCanonical: topIsCanonical,
        tierUpper: topTierUpper,
        qualityBucket,
        hasPrimarySupportEquivalent,
        hasCloseSecondChoice,
        plausibility,
      });

      const why = [];
      why.push(toStr(categoryReasons[cat] || 'fuzzy_plan_allowed'));
      if (source === 'title' || source === 'op') why.push('primary_span');
      if (source === 'comment') why.push('comment_span');
      if (spanReason) why.push(`span_reason:${spanReason}`);
      if (eligibilitySource === 'canonical_fallback') why.push('canonical_fallback_eligibility');
      if (canonicalPrimaryVariantRelax) why.push(`canonical_primary_variant_relax:${toStr(canonicalPrimaryVariantRelaxProfile?.mode || 'UNKNOWN')}`);
      if (top.sameSourceExactSuppressionBypassed === true) why.push('exact_same_source_variant_emit_relax');

      const aliasRolloutFallback = eligibilitySource.startsWith('alias_rollout_fallback');
      const aliasRolloutExplicit = eligibilitySource === 'explicit_fuzzy_allowed_alias_rollout';
      const aliasRolloutAny = aliasRolloutFallback || aliasRolloutExplicit;

      const fuzzyRiskFlags = {
        comment_source: source === 'comment',
        short_alias: toStr(top.aliasNorm).length <= 4,
        alias_match: !topIsCanonical,
        tier1_alias: !topIsCanonical && (topTierUpper === 'TIER_1' || topTierUpper === 'STATIC_ALIAS'),
        tier2_alias: topTierUpper === 'TIER_2',
        tier3_alias: topTierUpper === 'TIER_3',
        canonical_fallback_eligibility: eligibilitySource === 'canonical_fallback',
        alias_rollout_eligibility: aliasRolloutAny,
        alias_rollout_fallback_eligibility: aliasRolloutFallback,
        alias_rollout_explicit_eligibility: aliasRolloutExplicit,
        low_quality_fuzzy: qualityBucket === 'LOW',
        medium_quality_fuzzy: qualityBucket === 'MEDIUM',
        had_close_second_choice: hasCloseSecondChoice,
        deterministic_category_context_present: categoryContextPresent,
        primary_alias_relax_pilot_applied: !!pilotRelaxProfile,
        canonical_primary_variant_relax: canonicalPrimaryVariantRelax,
        canonical_primary_variant_relax_mode: canonicalPrimaryVariantRelax ? toStr(canonicalPrimaryVariantRelaxProfile?.mode || '') : null,
        exact_same_source_variant_emit_relax: top.sameSourceExactSuppressionBypassed === true,
        alias_collision: topRisk ? topRisk.alias_collision_count > 1 : false,
        alias_common_word_risk: topRisk ? topRisk.alias_common_word_risk : false,
        promotion_risk_high: topRisk ? toStr(topRisk.promotion_risk).toUpperCase() === 'HIGH' : false,
      };

      const fuzzyCandidateId = stableId([postId, 'fuzzy', cat, toStr(topRow.entity_slug), source, sourceId || 'na', toStr(top.matchedGram)]);

      const fuzzyCandidate = {
        category: cat,
        canonical_id: toStr(topRow.entity_slug),
        canonical_slug: toStr(topRow.entity_slug),
        hero_slug: toStr(topRow.hero_slug || '') || null,
        policy_risk: topRisk,
        matched_text: toStr(top.matchedGram),
        matched_text_norm: toStr(top.matchedGram),
        dictionary_alias_text: toStr(topRow.alias_text),
        dictionary_alias_text_norm: toStr(topRow.alias_text_norm),
        source,
        source_id: sourceId || null,
        source_anchor_kind: null,
        fuzzy_span_reason: spanReason || null,
        match_type: 'fuzzy',
        fuzzy_candidate_id: fuzzyCandidateId,
        fuzzy_generation_policy_version: 'fuzzy_v11_9_policy_risk_overlay_collision_commonword_emit_disable',
        fuzzy_policy_contract_version: 'fuzzy_contract_v3',
        overshoot_mode: OVERSHOOT_MODE,
        dictionary_entity_type: toStr(topRow.entity_type).toUpperCase(),
        dictionary_source_kind: toStr(topRow.source_kind),
        dictionary_tier: toStr(topRow.tier),
        is_canonical: topIsCanonical,
        fuzzy_allowed: topRow.fuzzy_allowed === true,
        fuzzy_eligibility_source: eligibilitySource || null,
        promotion_risk: toStr(topRow.promotion_risk || '').toUpperCase() || null,
        alias_collision_count: topRisk ? topRisk.alias_collision_count : 0,
        alias_common_word_risk: topRisk ? topRisk.alias_common_word_risk : false,
        short_alias: topRisk ? topRisk.short_alias : false,
        similarity: Number(top.similarity.toFixed(4)),
        threshold_used: Number(threshold.toFixed(4)),
        threshold_used_base: Number(thresholdBase.toFixed(4)),
        similarity_over_threshold: Number((top.similarity - threshold).toFixed(4)),
        tie_margin_required: Number(tieMargin.toFixed(4)),
        tie_margin_required_base: Number(tieMarginBase.toFixed(4)),
        tie_margin_actual: tieMarginActual,
        second_best_similarity: second ? Number(second.similarity.toFixed(4)) : null,
        second_best_canonical_slug: second ? toStr(second.canonicalSlug) : null,
        fuzzy_quality_bucket: qualityBucket,
        fuzzy_review_recommended: reviewRecommended,
        fuzzy_review_reason_codes: canonicalPrimaryVariantRelax
          ? unique([...reviewReasonCodes, `canonical_primary_variant_relax:${toStr(canonicalPrimaryVariantRelaxProfile?.mode || 'UNKNOWN')}`])
          : reviewReasonCodes,
        fuzzy_plausible: true,
        fuzzy_plausibility_reasons: [],
        fuzzy_equivalence_kind: canonicalPrimaryVariantRelax ? toStr(canonicalPrimaryVariantRelaxProfile?.mode || '') : null,
        fuzzy_equivalence_details: canonicalPrimaryVariantRelax ? canonicalPrimaryVariantRelaxProfile?.details || null : null,
        exact_present: epTop.exact_present,
        exact_present_reason: epTop.exact_present_reason,
        variant_same_source_confirmation: top.sameSourceExactSuppressionBypassed === true,
        variant_same_source_confirmation_reason:
          top.sameSourceExactSuppressionBypassed === true
            ? `variant_${toStr(canonicalPrimaryVariantRelaxProfile?.mode || 'UNKNOWN').toLowerCase()}_same_source_confirmation`
            : null,
        score_base: scoreBase,
        context_snippet: buildSnippet(sourceRaw),
        pack_policy_signals: policySignals,
        evidence: {
          source_weight: sourceWeightFor(source),
          source_is_primary: source === 'title' || source === 'op',
          source_is_comment: source === 'comment',
          alias_tier_bucket: topIsCanonical
            ? 'CANONICAL'
            : topTierUpper === 'TIER_1'
              ? 'TIER_1'
              : topTierUpper === 'TIER_2'
                ? 'TIER_2'
                : topTierUpper === 'TIER_3'
                  ? 'TIER_3'
                  : 'OTHER_ALIAS',
          why_generated: why,
          ambiguity_flags: {
            had_close_second_choice: hasCloseSecondChoice,
            short_alias: toStr(top.aliasNorm).length <= 4,
            comment_source: source === 'comment',
          },
        },
        fuzzy_risk_flags: fuzzyRiskFlags,
        hero_typo_carve_out_emit:
          Boolean(heroTypoCarveSlug && cat === 'hero' && toStr(topRow.entity_slug).toLowerCase() === heroTypoCarveSlug),
        deterministic_category_context_reasons: categoryContextDiag.reasons,
        variant_relax_candidate: canonicalPrimaryVariantRelax === true,
        variant_relax_mode: canonicalPrimaryVariantRelax ? toStr(canonicalPrimaryVariantRelaxProfile?.mode || '') : null,
      };

      fuzzyCandidates.push(fuzzyCandidate);
      noteEmitForCategory(cat);
      fuzzyMeta.generated_count += 1;
      if (canonicalPrimaryVariantRelax) fuzzyMeta.canonical_primary_variant_relax.generated_count += 1;
      if (top.sameSourceExactSuppressionBypassed === true) fuzzyMeta.canonical_primary_variant_relax.exact_same_source_generated_count += 1;
      fuzzyMeta.category_stats[cat].generated += 1;

      if (reviewRecommended) {
        fuzzyMeta.generated_review_recommended_count += 1;
        fuzzyMeta.category_stats[cat].generated_review_recommended += 1;
      }
    }
  }

  return { fuzzyCandidates, fuzzyMeta, shadowHitsByCategory, shadowCountsByCategory };
}

/**
 * @param {object} packOutput - packCandidates() result for one post.
 * @param {object} policyBundle - loadPolicyBundle() result.
 */
function expandFuzzyCandidates(packOutput, policyBundle) {
  const j = packOutput || {};
  if (!isPackStageItem(j)) {
    throw new Error('expandFuzzyCandidates: expected pack output (post_id, detect, entity_candidates_exact, fuzzy_plan).');
  }

  const dictRows = safeArray(policyBundle?.dictionaries?.rows);
  if (!dictRows.length) {
    throw new Error('expandFuzzyCandidates: policyBundle.dictionaries.rows is empty.');
  }

  const policyRiskCtx = buildPolicyRiskContext(policyBundle);
  const fuzzyDict = buildFuzzyDictionaryIndex(dictRows, policyRiskCtx);
  const dictByCategory = fuzzyDict.byCategory;
  const fuzzyDictMeta = fuzzyDict.meta;

  const dictionaryMetaSnapshotCompact = buildFuzzyDictionaryMetaSnapshot(policyBundle);

  const { fuzzyCandidates, fuzzyMeta, shadowHitsByCategory, shadowCountsByCategory } = buildFuzzyCandidatesForItem({
    itemJson: j,
    dictByCategory,
    policyRiskCtx,
  });

  const categoryCounts = {};
  for (const c of fuzzyCandidates) {
    categoryCounts[c.category] = (categoryCounts[c.category] || 0) + 1;
  }

  return {
    post_id: toStr(j.post_id).trim(),
    detect: j.detect,
    entity_candidates_exact: safeArray(j.entity_candidates_exact),
    exact_detection_meta: isObject(j.exact_detection_meta) ? j.exact_detection_meta : {},
    fuzzy_plan: isObject(j.fuzzy_plan) ? j.fuzzy_plan : {},

    entity_candidates_fuzzy: fuzzyCandidates,
    fuzzy_shadow_hits_by_category: shadowHitsByCategory,
    fuzzy_shadow_counts_by_category: shadowCountsByCategory,
    fuzzy_generated_total: fuzzyCandidates.length,
    fuzzy_generated_by_category: categoryCounts,
    fuzzy_policy_version: fuzzyMeta.policy_version,
    fuzzy_detection_meta: {
      candidate_count: fuzzyCandidates.length,
      category_counts: categoryCounts,
      shadow_enabled: SHADOW_ENABLED,
      shadow_topk_per_category: SHADOW_TOPK_PER_CATEGORY,
      shadow_counts_by_category: shadowCountsByCategory,
      ...fuzzyMeta,
      dictionary_fuzzy_meta: fuzzyDictMeta,
      dictionary_meta_snapshot: dictionaryMetaSnapshotCompact,
    },
  };
}

module.exports = {
  expandFuzzyCandidates,
};

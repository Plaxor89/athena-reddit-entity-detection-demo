// packCandidates.js
//
// First deterministic candidate-ledger stage.
// Mirrors the behavior of the n8n "Pack Exact Alias Candidates" node: exact
// dictionary scans over normalized surfaces, exact-ledger metadata, and a
// fuzzy_plan handoff for expandFuzzyCandidates (fuzzy matching is NOT here).
//
// Inputs:
// - one buildDetectionInput item { post_id, detect, ... }
// - shared policyBundle from loadPolicyBundle (dictionaries.rows, policyMeta, meta)
//
// Scope guardrails:
// - Do not perform fuzzy expansion here.
// - Downstream fuzzy must not re-derive this plan from raw buildDetectionInput.

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

function countPhrase(hayNorm, phraseNorm) {
  if (!hayNorm || !phraseNorm) return 0;
  const hay = ` ${hayNorm} `;
  const needle = ` ${phraseNorm} `;
  let count = 0;
  let idx = 0;
  while (true) {
    idx = hay.indexOf(needle, idx);
    if (idx === -1) break;
    count += 1;
    idx += needle.length;
  }
  return count;
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
  if (t === 'RANK_BRACKET') return 'rank_bracket';
  return 'other';
}

function sourceWeightFor(sourceType) {
  if (sourceType === 'title') return 1.0;
  if (sourceType === 'op') return 0.9;
  if (sourceType === 'comment') return 0.55;
  return 0.4;
}

function baseScoreForMatch({ sourceType, isCanonical, tier, category, aliasNorm, surfaceNorm }) {
  let score = sourceWeightFor(sourceType);

  if (isCanonical) {
    score += 0.25;
  } else {
    const t = toStr(tier).toUpperCase();
    if (t === 'TIER_1' || t === 'STATIC_ALIAS') score += 0.12;
    else if (t === 'TIER_2') score += 0.07;
    else if (t === 'TIER_3') score += 0.02;
    else score += 0.05;
  }

  const t = toStr(tier).toUpperCase();
  if (sourceType === 'comment' && category === 'role') score -= 0.08;
  if (sourceType === 'comment' && !isCanonical && t === 'TIER_3') score -= 0.08;
  if (sourceType === 'comment' && category === 'perk') score -= 0.05;
  if (sourceType === 'comment' && category === 'ability') score -= 0.04;

  if (category === 'rank') {
    const weakRankTerms = new Set(['master', 'gm', 'diamond', 'gold', 'silver', 'bronze', 'plat', 'champion']);
    if (weakRankTerms.has(toStr(aliasNorm))) score -= 0.04;
  }

  if (category === 'rank' && toStr(aliasNorm) === 'master') {
    const hay = ` ${toStr(surfaceNorm)} `;
    if (hay.includes(' master chief ')) score -= 0.15;
  }

  score = Math.max(0, Math.min(2, score));
  return Number(score.toFixed(3));
}

function buildSnippet(raw, maxLen = 220) {
  const s = toStr(raw).replace(/\s+/g, ' ').trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}

function getSourceSurfaces(detect) {
  const src = isObject(detect.sources) ? detect.sources : {};

  const title = isObject(src.title) ? src.title : {};
  const op = isObject(src.op) ? src.op : {};
  const comments = safeArray(src.comments);

  const primary = [];
  const commentSurfaces = [];

  if (toStr(title.norm)) {
    primary.push({
      source_type: 'title',
      source_id: 'TITLE',
      raw: toStr(title.raw),
      norm: toStr(title.norm),
      comment_rank: null,
      comment_score: null,
    });
  }

  if (toStr(op.norm)) {
    primary.push({
      source_type: 'op',
      source_id: 'OP',
      raw: toStr(op.raw),
      norm: toStr(op.norm),
      comment_rank: null,
      comment_score: null,
    });
  }

  for (const c of comments) {
    const normText = toStr(c.norm);
    if (!normText) continue;
    commentSurfaces.push({
      source_type: 'comment',
      source_id: toStr(c.id) || null,
      raw: toStr(c.raw),
      norm: normText,
      comment_rank: Number.isFinite(Number(c.rank)) ? Number(c.rank) : null,
      comment_score: Number.isFinite(Number(c.score)) ? Number(c.score) : null,
    });
  }

  return { primary, comments: commentSurfaces };
}

function buildDictionaryIndex(rows) {
  const byType = {};
  for (const r of safeArray(rows)) {
    const entityType = toStr(r.entity_type).toUpperCase();
    const aliasNorm = toStr(r.alias_text_norm);
    if (!entityType || !aliasNorm) continue;
    if (entityType === 'RANK_BRACKET') continue;
    if (!byType[entityType]) byType[entityType] = [];
    byType[entityType].push(r);
  }

  for (const [k, arr] of Object.entries(byType)) {
    arr.sort((a, b) => toStr(b.alias_text_norm).length - toStr(a.alias_text_norm).length);
    byType[k] = arr;
  }

  return byType;
}

/**
 * Policy meta for pack: mirrors n8n `dictionaries.policy_meta` plus fields
 * stored on `policyBundle.policyMeta` in this repo.
 */
function pickPolicyMeta(policyBundle) {
  const nested = policyBundle && isObject(policyBundle.policy_meta) ? policyBundle.policy_meta : null;
  const flat = policyBundle && isObject(policyBundle.policyMeta) ? policyBundle.policyMeta : null;
  const pm = nested || flat || {};

  return {
    anchor_groups: isObject(pm.anchor_groups) ? pm.anchor_groups : {},
    negative_anchors: isObject(pm.negative_anchors) ? pm.negative_anchors : {},
    rank_bracket_membership: isObject(pm.rank_bracket_membership) ? pm.rank_bracket_membership : {},
    alias_collision_registry: isObject(pm.alias_collision_registry) ? pm.alias_collision_registry : {},
    common_word_alias_norms: Array.isArray(pm.common_word_alias_norms) ? pm.common_word_alias_norms : [],
  };
}

const STOPWORD_ANCHOR_TERMS = new Set([
  'in', 'on', 'at', 'to', 'from', 'of', 'for', 'with',
  'play', 'playing', 'played',
  'need', 'team', 'game',
]);

function filterAnchorTerms(anchorTerms, { minLen = 3 } = {}) {
  const out = [];
  for (const t of safeArray(anchorTerms)) {
    const tn = toStr(t).trim().toLowerCase();
    if (!tn) continue;
    if (tn.length < minLen) continue;
    if (STOPWORD_ANCHOR_TERMS.has(tn)) continue;
    out.push(tn);
  }
  return out;
}

function hasAnyAnchorTerm(primaryNormJoined, anchorTerms, opts) {
  if (!primaryNormJoined) return false;
  const hay = ` ${primaryNormJoined} `;
  const terms = filterAnchorTerms(anchorTerms, opts);
  for (const tn of terms) {
    const needle = ` ${tn} `;
    if (hay.includes(needle)) return true;
  }
  return false;
}

function findNegativeAnchors(primaryNormJoined, negativePhrases) {
  const hits = [];
  if (!primaryNormJoined) return hits;
  const hay = ` ${primaryNormJoined} `;
  for (const p of safeArray(negativePhrases)) {
    const pn = toStr(p).trim().toLowerCase();
    if (!pn) continue;
    const needle = ` ${pn} `;
    if (hay.includes(needle)) hits.push(pn);
  }
  return hits;
}

function computePolicySignalsForItem({ detect, policyMeta }) {
  const titleNorm = toStr(detect?.sources?.title?.norm);
  const opNorm = toStr(detect?.sources?.op?.norm);
  const primaryNormJoined = [titleNorm, opNorm].filter(Boolean).join(' ');

  const anchorGroups = isObject(policyMeta.anchor_groups) ? policyMeta.anchor_groups : {};
  const neg = isObject(policyMeta.negative_anchors) ? policyMeta.negative_anchors : {};

  const rankAnchorsPresent = hasAnyAnchorTerm(primaryNormJoined, anchorGroups.rank, { minLen: 2 });
  const platformAnchorsPresent = hasAnyAnchorTerm(primaryNormJoined, anchorGroups.platform, { minLen: 2 });
  const queueAnchorsPresent = hasAnyAnchorTerm(primaryNormJoined, anchorGroups.queue, { minLen: 2 });

  const modeAnchorsPresent = hasAnyAnchorTerm(primaryNormJoined, anchorGroups.mode, { minLen: 3 });
  const roleAnchorsPresent = hasAnyAnchorTerm(primaryNormJoined, anchorGroups.role, { minLen: 3 });

  const rankNegativeHits = findNegativeAnchors(primaryNormJoined, neg.rank);
  const switchVerbHits = findNegativeAnchors(primaryNormJoined, neg.platform_switch);

  return {
    primary_norm_joined: primaryNormJoined,
    anchors_present: {
      rank: rankAnchorsPresent,
      platform: platformAnchorsPresent,
      queue: queueAnchorsPresent,
      mode: modeAnchorsPresent,
      role: roleAnchorsPresent,
    },
    negative_anchor_hits: {
      rank: rankNegativeHits,
      platform_switch: switchVerbHits,
    },
  };
}

function isHighRiskCommentOnlyAlias(row, category) {
  if (!row || row.is_canonical === true) return false;

  const promo = toStr(row.promotion_risk).toUpperCase();
  const shortAlias = row.short_alias === true;
  const collided = Number(row.alias_collision_count || 0) > 1;
  const commonWord = row.alias_common_word_risk === true;

  if (promo === 'HIGH') return true;
  if (shortAlias) return true;
  if (collided) return true;
  if (commonWord) return true;

  const tier = toStr(row.tier).toUpperCase();
  if ((category === 'ability' || category === 'perk') && tier === 'TIER_3') return true;

  return false;
}

function computeThreadContextStrong({ detect, policySignals, heroPrimaryCanonicals }) {
  const intent = isObject(detect?.intent) ? detect.intent : {};
  const targetPrimary = safeArray(intent.target_categories_primary);
  const targetUnion = safeArray(intent.target_categories);

  const intentStrong = Boolean(
    intent.asks_for_entity || intent.asks_question || targetPrimary.length > 0 || targetUnion.length > 0
  );

  const anchorsPresent = isObject(policySignals?.anchors_present) ? policySignals.anchors_present : {};
  const hasAnyConceptAnchor =
    Boolean(anchorsPresent.rank || anchorsPresent.platform || anchorsPresent.queue || anchorsPresent.mode || anchorsPresent.role);

  const hasPrimaryHeroCanonical = heroPrimaryCanonicals && heroPrimaryCanonicals.size > 0;

  return Boolean(intentStrong || hasAnyConceptAnchor || hasPrimaryHeroCanonical);
}

function riskyAliasEscapeHatch({ row, category, surface, detect, policySignals, heroPrimaryCanonicals }) {
  if (!row || row.is_canonical === true) return { allowed: false, rule_id: null, allow_reason_codes: [] };
  if (surface?.source_type !== 'comment') return { allowed: false, rule_id: null, allow_reason_codes: [] };

  const commentRank = Number.isFinite(Number(surface.comment_rank)) ? Number(surface.comment_rank) : null;
  const commentScore = Number.isFinite(Number(surface.comment_score)) ? Number(surface.comment_score) : null;

  const isTopComment = commentRank !== null && commentRank <= 1;
  const threadContextStrong = computeThreadContextStrong({ detect, policySignals, heroPrimaryCanonicals });

  if (category === 'hero') {
    const authorityOk =
      (commentRank !== null && commentRank <= 5) ||
      (commentScore !== null && commentScore >= 50);

    if (authorityOk && threadContextStrong) {
      const ruleId = 'hero_rank_le_5_or_score_ge_50_thread_context';
      return {
        allowed: true,
        rule_id: ruleId,
        allow_reason_codes: ['pack_allow_high_risk_comment_only_alias_due_to_hero_rank_le_5_or_score_ge_50_thread_context'],
      };
    }
    return { allowed: false, rule_id: null, allow_reason_codes: [] };
  }

  if (category === 'ability' || category === 'perk') {
    const owner = toStr(row.hero_slug || '');
    const hasOwnerHeroPrimaryCanonical = owner && heroPrimaryCanonicals && heroPrimaryCanonicals.has(owner);

    const authorityOk = Boolean(isTopComment || (commentScore !== null && commentScore >= 5));

    if (hasOwnerHeroPrimaryCanonical && authorityOk && threadContextStrong) {
      return {
        allowed: true,
        rule_id: 'ability_owner_hero_primary_canonical_support',
        allow_reason_codes: ['pack_allow_high_risk_comment_only_alias_due_to_owner_hero_primary_canonical_support'],
      };
    }
    return { allowed: false, rule_id: null, allow_reason_codes: [] };
  }

  return { allowed: false, rule_id: null, allow_reason_codes: [] };
}

function buildExactCandidatesForItem({ itemJson, dictRowsByType, policySignals }) {
  const postId = toStr(itemJson.post_id).trim();
  const detect = isObject(itemJson.detect) ? itemJson.detect : {};
  const { primary, comments } = getSourceSurfaces(detect);

  const candidates = [];
  const seen = new Set();
  const primaryHitKey = new Set();

  const heroPrimaryCanonicals = new Set();

  const entityTypesToScan = ['HERO', 'MAP', 'RANK', 'PLATFORM', 'QUEUE', 'MODE', 'ROLE', 'ABILITY', 'PERK'];

  const shadowOnlyExactSkips = [];
  const shadowSkipSeen = new Set();

  function addShadowSkip(s) {
    const skipReason = toStr(s.skip_reason || s.reason || '').trim() || 'pack_skip_unspecified';
    s.skip_reason = skipReason;
    s.reason = skipReason;

    const k = `${s.category}|${s.canonical_slug}|${s.matched_text_norm}|${s.source}|${skipReason}`;
    if (shadowSkipSeen.has(k)) return;
    shadowSkipSeen.add(k);
    shadowOnlyExactSkips.push(s);
  }

  function scanSurface(surface, { isCommentPass }) {
    const hayNorm = toStr(surface.norm);
    if (!hayNorm) return;

    for (const entityType of entityTypesToScan) {
      const rows = safeArray(dictRowsByType[entityType]);
      if (!rows.length) continue;

      for (const row of rows) {
        const aliasNorm = toStr(row.alias_text_norm);
        if (!aliasNorm) continue;

        const occurrences = countPhrase(hayNorm, aliasNorm);
        if (occurrences <= 0) continue;

        const category = mapEntityTypeToCategory(entityType);
        const isCanonical = row.is_canonical === true;
        const sourceType = surface.source_type;
        const matchType = isCanonical ? 'exact_canonical' : 'exact_alias';
        const tierUpper = toStr(row.tier).toUpperCase();

        const entKey = [category, toStr(row.entity_slug), toStr(row.hero_slug || '')].join('|');

        let riskyAliasEscaped = false;
        let riskyAliasEscape = null;

        if (isCommentPass && sourceType === 'comment' && !isCanonical) {
          const hasPrimarySupport = primaryHitKey.has(entKey);
          if (!hasPrimarySupport && isHighRiskCommentOnlyAlias(row, category)) {
            riskyAliasEscape = riskyAliasEscapeHatch({
              row,
              category,
              surface,
              detect,
              policySignals,
              heroPrimaryCanonicals,
            });

            if (riskyAliasEscape && riskyAliasEscape.allowed) {
              riskyAliasEscaped = true;
            } else {
              addShadowSkip({
                category,
                canonical_slug: toStr(row.entity_slug),
                hero_slug: toStr(row.hero_slug || '') || null,
                matched_text_norm: aliasNorm,
                matched_text: toStr(row.alias_text),
                alias_text: toStr(row.alias_text),
                source: 'comment',
                source_id: surface.source_id,
                source_comment_rank: surface.comment_rank,
                source_comment_score: surface.comment_score,
                context_snippet: buildSnippet(surface.raw),
                dictionary_entity_type: entityType,
                dictionary_tier: toStr(row.tier),
                dictionary_source_kind: toStr(row.source_kind),
                is_canonical: false,
                promotion_risk: toStr(row.promotion_risk || '').toUpperCase() || null,

                alias_collision_count: Number(row.alias_collision_count || 0),
                alias_collision_key: toStr(row.alias_collision_key) || null,
                alias_common_word_risk: row.alias_common_word_risk === true,
                short_alias: row.short_alias === true,

                skip_reason: 'pack_skip_high_risk_comment_only_alias',
              });
              continue;
            }
          }
        }

        const dedupeKey = [
          postId,
          category,
          toStr(row.entity_slug),
          toStr(row.hero_slug || ''),
          sourceType,
          toStr(surface.source_id || ''),
          aliasNorm,
          matchType,
        ].join('|');

        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        if (!isCommentPass && (sourceType === 'title' || sourceType === 'op')) {
          primaryHitKey.add(entKey);
          if (category === 'hero' && isCanonical && (sourceType === 'title' || sourceType === 'op')) {
            heroPrimaryCanonicals.add(toStr(row.entity_slug));
          }
        }

        const rawNorm = ` ${hayNorm} `;
        const weakRankTerms = new Set(['master', 'gm', 'diamond', 'gold', 'silver', 'bronze', 'plat', 'champion']);

        const policy = {
          requires_ow_context: row.requires_ow_context,
          requires_anchor: row.requires_anchor,
          anchor_group: row.anchor_group,
          window_tokens: row.window_tokens,
          comment_only_requires_corroboration: row.comment_only_requires_corroboration,
          short_alias: row.short_alias,
          prefer_canonical_over_alias: row.prefer_canonical_over_alias,
          allow_high_tier_only: row.allow_high_tier_only,
        };

        const primaryAnchorPresentForCategory = (() => {
          if (!policySignals || !policySignals.anchors_present) return null;
          if (category === 'rank') return policySignals.anchors_present.rank;
          if (category === 'platform') return policySignals.anchors_present.platform;
          if (category === 'queue') return policySignals.anchors_present.queue;
          if (category === 'mode') return policySignals.anchors_present.mode;
          if (category === 'role') return policySignals.anchors_present.role;
          return null;
        })();

        const rankNegHits = safeArray(policySignals?.negative_anchor_hits?.rank);
        const switchVerbHits = safeArray(policySignals?.negative_anchor_hits?.platform_switch);

        const lexicalNoiseFlags = {
          rank_master_chief_collision:
            category === 'rank' &&
            aliasNorm === 'master' &&
            rawNorm.includes(' master chief '),

          rank_gm_vehicle_context:
            category === 'rank' &&
            (aliasNorm === 'gm' || aliasNorm === 'grandmaster') &&
            (rawNorm.includes(' gm truck ') || rawNorm.includes(' gm cars ') || rawNorm.includes(' general motors ')),

          non_ow_franchise_context:
            rawNorm.includes(' halo ') ||
            rawNorm.includes(' valorant ') ||
            rawNorm.includes(' apex ') ||
            rawNorm.includes(' cod ') ||
            rawNorm.includes(' call of duty '),

          rank_negative_anchor_primary_hit:
            category === 'rank' &&
            (surface.source_type === 'title' || surface.source_type === 'op') &&
            rankNegHits.length > 0,

          switch_verb_primary_hit:
            category === 'platform' &&
            toStr(row.entity_slug).toLowerCase() === 'switch' &&
            (surface.source_type === 'title' || surface.source_type === 'op') &&
            switchVerbHits.length > 0,
        };

        const noiseFlags = {
          comment_only_like_term: sourceType === 'comment' && (category === 'role' || category === 'rank' || category === 'queue'),
          risky_alias_tier3_comment: sourceType === 'comment' && !isCanonical && tierUpper === 'TIER_3',
          genericish_perk_comment: sourceType === 'comment' && category === 'perk',
          genericish_ability_comment: sourceType === 'comment' && category === 'ability',
          comment_mode_or_role: sourceType === 'comment' && (category === 'mode' || category === 'role'),
          rank_weak_term: category === 'rank' && weakRankTerms.has(aliasNorm),

          requires_anchor: row.requires_anchor === true,
          anchor_group: toStr(row.anchor_group) || null,
          primary_anchor_terms_present: primaryAnchorPresentForCategory,
          short_alias: row.short_alias === true,
          allow_high_tier_only: row.allow_high_tier_only === true,
          comment_only_requires_corroboration: row.comment_only_requires_corroboration === true,

          alias_collision_count: Number(row.alias_collision_count || 0),
          alias_collision_key: toStr(row.alias_collision_key) || null,
          alias_common_word_risk: row.alias_common_word_risk === true,

          pack_risky_alias_escaped: riskyAliasEscaped === true,
          pack_risky_alias_escape_rule: riskyAliasEscaped ? toStr(riskyAliasEscape?.rule_id) : null,

          ...lexicalNoiseFlags,
        };

        candidates.push({
          category,
          canonical_id: toStr(row.entity_slug),
          canonical_slug: toStr(row.entity_slug),
          hero_slug: toStr(row.hero_slug || '') || null,
          matched_text: toStr(row.alias_text),
          matched_text_norm: aliasNorm,
          source: sourceType,
          source_id: surface.source_id,
          source_comment_rank: surface.comment_rank,
          source_comment_score: surface.comment_score,
          match_type: matchType,
          dictionary_entity_type: entityType,
          dictionary_source_kind: toStr(row.source_kind),
          dictionary_tier: toStr(row.tier),
          is_canonical: isCanonical,
          fuzzy_allowed: row.fuzzy_allowed === true,
          promotion_risk: toStr(row.promotion_risk || '').toUpperCase() || null,

          pack_gate: riskyAliasEscaped ? (`RISKY_ALIAS_ESCAPED:${toStr(riskyAliasEscape?.rule_id)}`) : null,
          max_lane: riskyAliasEscaped ? 'HIGH' : null,
          pack_allow_reason_codes: riskyAliasEscaped ? safeArray(riskyAliasEscape?.allow_reason_codes) : [],

          policy,

          occurrences,
          score_base: baseScoreForMatch({
            sourceType,
            isCanonical,
            tier: row.tier,
            category,
            aliasNorm,
            surfaceNorm: hayNorm,
          }),
          context_snippet: buildSnippet(surface.raw),
          evidence: {
            source_weight: sourceWeightFor(sourceType),
            alias_text_norm: aliasNorm,
            source_is_primary: sourceType === 'title' || sourceType === 'op',
            source_is_comment: sourceType === 'comment',
            alias_tier_bucket:
              isCanonical ? 'CANONICAL' :
                (tierUpper === 'TIER_1' ? 'TIER_1' :
                  tierUpper === 'TIER_2' ? 'TIER_2' :
                    tierUpper === 'TIER_3' ? 'TIER_3' : 'OTHER_ALIAS'),
            noise_flags: noiseFlags,
          },
        });
      }
    }
  }

  for (const s of primary) scanSurface(s, { isCommentPass: false });
  for (const s of comments) scanSurface(s, { isCommentPass: true });

  return { candidates, shadow_only_exact_skips: shadowOnlyExactSkips };
}

/** Levenshtein distance for narrow hero typo carve-out (pack-local; keep minimal). */
function levenshteinDistancePack(a, b) {
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

/** Match expandFuzzyCandidates.normalizeSpanText for primary typo scan parity. */
function normalizeSpanTextPack(s) {
  const x = toStr(s).toLowerCase();
  return x.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const HERO_PRIMARY_TYPO_CARVE_OUT_MIN_LEN = 4;
/** Adjacent transposition typos (e.g. muaga→mauga) are distance 2 under plain Levenshtein. */
const HERO_PRIMARY_TYPO_MAX_DIST_SHORT = 1;
const HERO_PRIMARY_TYPO_MAX_DIST_LONG = 2;
const HERO_PRIMARY_TYPO_LONG_TOKEN_LEN = 5;

/**
 * Comment-sourced hero exacts must corroborate exactly one dominant canonical hero:
 * count exact rows per canonical_slug; unique strict winner; ties disable carve-out.
 * At least one winning-row hit must be canonical (not alias-only on that slug).
 */
function getHeroCommentDominantCanonicalCorroboration(candidates) {
  const heroComment = safeArray(candidates).filter(
    (c) => toStr(c.category).toLowerCase() === 'hero' && toStr(c.source) === 'comment' && toStr(c.canonical_slug),
  );
  if (!heroComment.length) return null;
  const counts = new Map();
  for (const c of heroComment) {
    const slug = toStr(c.canonical_slug).toLowerCase();
    counts.set(slug, (counts.get(slug) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length >= 2 && ranked[0][1] === ranked[1][1]) return null;
  const slug = ranked[0][0];
  const hasCanonicalRow = heroComment.some(
    (c) => toStr(c.canonical_slug).toLowerCase() === slug && c.is_canonical === true,
  );
  if (!hasCanonicalRow) return null;
  return slug;
}

function canonicalHeroNormTargetsForSlug(dictRows, slug) {
  const s = toStr(slug).toLowerCase();
  const norms = new Set();
  for (const r of safeArray(dictRows)) {
    if (toStr(r.entity_type).toUpperCase() !== 'HERO') continue;
    if (r.is_canonical !== true) continue;
    if (toStr(r.entity_slug).toLowerCase() !== s) continue;
    const n = toStr(r.alias_text_norm).trim().toLowerCase();
    if (n) norms.add(n);
  }
  return [...norms];
}

/**
 * Primary title/OP norm: token must be within max dist of a canonical hero name/slug norm;
 * targets and tokens shorter than HERO_PRIMARY_TYPO_CARVE_OUT_MIN_LEN are excluded (ana/dva-class risk).
 */
function maxTypoDistForPair(tok, targ) {
  const t = toStr(tok);
  const a = toStr(targ);
  if (Math.abs(t.length - a.length) > HERO_PRIMARY_TYPO_MAX_DIST_LONG) return null;
  const longEnough = t.length >= HERO_PRIMARY_TYPO_LONG_TOKEN_LEN && a.length >= HERO_PRIMARY_TYPO_LONG_TOKEN_LEN;
  const maxD = longEnough ? HERO_PRIMARY_TYPO_MAX_DIST_LONG : HERO_PRIMARY_TYPO_MAX_DIST_SHORT;
  const d = levenshteinDistancePack(t, a);
  if (d > maxD) return null;
  return d;
}

function findPrimaryNearMatchToHeroTargets(titleNorm, opNorm, targets) {
  const targs = safeArray(targets).filter((t) => toStr(t).length >= HERO_PRIMARY_TYPO_CARVE_OUT_MIN_LEN);
  if (!targs.length) return null;
  const surfaces = [titleNorm, opNorm].map((x) => normalizeSpanTextPack(x)).filter(Boolean);
  let best = null;
  for (const surf of surfaces) {
    const tokens = surf.split(/\s+/).filter((w) => toStr(w).length >= HERO_PRIMARY_TYPO_CARVE_OUT_MIN_LEN);
    for (const tok of tokens) {
      for (const targ of targs) {
        const d = maxTypoDistForPair(tok, targ);
        if (d === null) continue;
        if (!best || d < best.distance || (d === best.distance && tok.length > best.token.length)) {
          best = { token: tok, target: targ, distance: d };
        }
      }
    }
  }
  return best;
}

function tryHeroPrimaryTypoCarveOut({ candidates, titleNorm, opNorm, dictRows }) {
  const slug = getHeroCommentDominantCanonicalCorroboration(candidates);
  if (!slug) return null;
  const targets = canonicalHeroNormTargetsForSlug(dictRows, slug);
  const near = findPrimaryNearMatchToHeroTargets(titleNorm, opNorm, targets);
  if (!near) return null;
  return {
    canonical_slug: slug,
    near_match_token: near.token,
    near_match_target: near.target,
    levenshtein_distance: near.distance,
  };
}

function summarizeExact(candidates) {
  const byCategory = {};
  const exactStrongByCategory = {};

  for (const c of candidates) {
    if (!byCategory[c.category]) {
      byCategory[c.category] = {
        total: 0,
        title: 0,
        op: 0,
        comment: 0,
        primary_total: 0,
        comment_only_total: 0,
        canonical: 0,
        canonical_primary: 0,
        canonical_comment: 0,
        alias: 0,
        tier_1: 0,
        tier_2: 0,
        tier_3: 0,
        max_score_base: 0,
        has_primary_exact: false,
        has_primary_canonical_exact: false,
        has_comment_only_exact: false,
        weak_rank_term_hits: 0,
        lexical_collision_hits: 0,

        requires_anchor_hits: 0,
        short_alias_hits: 0,
        negative_anchor_primary_hits: 0,

        alias_collision_hits: 0,
        common_word_alias_hits: 0,
      };
    }

    const b = byCategory[c.category];
    b.total += 1;
    if (c.source === 'title') b.title += 1;
    if (c.source === 'op') b.op += 1;
    if (c.source === 'comment') b.comment += 1;
    if (c.source === 'title' || c.source === 'op') b.primary_total += 1;
    if (c.source === 'comment') b.comment_only_total += 1;

    if (c.is_canonical) {
      b.canonical += 1;
      if (c.source === 'title' || c.source === 'op') b.canonical_primary += 1;
      if (c.source === 'comment') b.canonical_comment += 1;
    } else {
      b.alias += 1;
    }

    const t = toStr(c.dictionary_tier).toUpperCase();
    if (t === 'TIER_1' || t === 'STATIC_ALIAS') b.tier_1 += 1;
    if (t === 'TIER_2') b.tier_2 += 1;
    if (t === 'TIER_3') b.tier_3 += 1;

    const nf = c?.evidence?.noise_flags || {};
    if (nf.rank_weak_term) b.weak_rank_term_hits += 1;
    if (nf.rank_master_chief_collision || nf.rank_gm_vehicle_context) b.lexical_collision_hits += 1;

    if (nf.requires_anchor) b.requires_anchor_hits += 1;
    if (nf.short_alias) b.short_alias_hits += 1;
    if (nf.rank_negative_anchor_primary_hit || nf.switch_verb_primary_hit) b.negative_anchor_primary_hits += 1;

    if (Number(nf.alias_collision_count || 0) > 1) b.alias_collision_hits += 1;
    if (nf.alias_common_word_risk === true) b.common_word_alias_hits += 1;

    b.max_score_base = Math.max(b.max_score_base, Number(c.score_base) || 0);
  }

  for (const [cat, b] of Object.entries(byCategory)) {
    const hasPrimary = (b.title + b.op) > 0;
    const hasPrimaryCanonical = candidates.some(
      (c) => c.category === cat && c.is_canonical && (c.source === 'title' || c.source === 'op')
    );
    const repeated = b.total >= 2;

    b.has_primary_exact = hasPrimary;
    b.has_primary_canonical_exact = hasPrimaryCanonical;
    b.has_comment_only_exact = b.comment > 0 && !hasPrimary;

    if (cat === 'rank' && !hasPrimaryCanonical) {
      const allRankCandidates = candidates.filter((x) => x.category === 'rank');
      const allWeakish = allRankCandidates.length > 0 && allRankCandidates.every((x) => x?.evidence?.noise_flags?.rank_weak_term === true);
      exactStrongByCategory[cat] = Boolean(!allWeakish && hasPrimary && repeated);
    } else {
      exactStrongByCategory[cat] = Boolean(hasPrimaryCanonical || (hasPrimary && repeated));
    }
  }

  const heroCandidates = candidates.filter((c) => c.category === 'hero');
  const abilityCandidates = candidates.filter((c) => c.category === 'ability');

  const heroPrimaryCanonicals = unique(
    heroCandidates
      .filter((c) => c.is_canonical && (c.source === 'title' || c.source === 'op'))
      .map((c) => toStr(c.canonical_slug))
      .filter(Boolean)
  );

  const heroPrimaryAny = unique(
    heroCandidates
      .filter((c) => (c.source === 'title' || c.source === 'op'))
      .map((c) => toStr(c.canonical_slug))
      .filter(Boolean)
  );

  const abilityPrimaryCanonicals = unique(
    abilityCandidates
      .filter((c) => c.is_canonical && (c.source === 'title' || c.source === 'op'))
      .map((c) => toStr(c.canonical_slug))
      .filter(Boolean)
  );

  const abilityHeroPrimarySupportHits = abilityCandidates.filter((c) =>
    toStr(c.hero_slug) &&
    heroPrimaryCanonicals.includes(toStr(c.hero_slug))
  );

  const abilityHeroAnyPrimarySupportHits = abilityCandidates.filter((c) =>
    toStr(c.hero_slug) &&
    heroPrimaryAny.includes(toStr(c.hero_slug))
  );

  const abilitySupportSummary = {
    hero_primary_canonical_slugs: heroPrimaryCanonicals,
    hero_primary_any_slugs: heroPrimaryAny,
    ability_primary_canonical_slugs: abilityPrimaryCanonicals,
    ability_candidates_total: abilityCandidates.length,
    ability_candidates_with_owner_hero_primary_canonical_support: abilityHeroPrimarySupportHits.length,
    ability_candidates_with_owner_hero_primary_any_support: abilityHeroAnyPrimarySupportHits.length,
    has_ability_owner_hero_primary_canonical_support: abilityHeroPrimarySupportHits.length > 0,
    has_ability_owner_hero_primary_any_support: abilityHeroAnyPrimarySupportHits.length > 0,
  };

  return {
    by_category: byCategory,
    exact_strong_by_category: exactStrongByCategory,
    exact_presence_flags_by_category: Object.fromEntries(
      Object.entries(byCategory).map(([cat, bb]) => [
        cat,
        {
          has_primary_exact: Boolean(bb.has_primary_exact),
          has_primary_canonical_exact: Boolean(bb.has_primary_canonical_exact),
          has_comment_only_exact: Boolean(bb.has_comment_only_exact),
          weak_rank_term_hits: Number(bb.weak_rank_term_hits || 0),
          lexical_collision_hits: Number(bb.lexical_collision_hits || 0),
          requires_anchor_hits: Number(bb.requires_anchor_hits || 0),
          short_alias_hits: Number(bb.short_alias_hits || 0),
          negative_anchor_primary_hits: Number(bb.negative_anchor_primary_hits || 0),
          alias_collision_hits: Number(bb.alias_collision_hits || 0),
          common_word_alias_hits: Number(bb.common_word_alias_hits || 0),
        },
      ])
    ),
    unmatched_anchors: [],
    ability_support_summary: abilitySupportSummary,
  };
}

function buildFuzzyPlan({ detect, exactSummary, candidates, policySignals, dictRows }) {
  const intent = isObject(detect.intent) ? detect.intent : {};

  const targetCategoriesPrimary = safeArray(intent.target_categories_primary).map((x) => toStr(x).toLowerCase());
  const targetCategoriesUnion = safeArray(intent.target_categories).map((x) => toStr(x).toLowerCase());

  const exactStrong = isObject(exactSummary.exact_strong_by_category) ? exactSummary.exact_strong_by_category : {};
  const byCategory = isObject(exactSummary.by_category) ? exactSummary.by_category : {};
  const abilitySupportSummary = isObject(exactSummary.ability_support_summary) ? exactSummary.ability_support_summary : {};

  const asksForEntity = Boolean(intent.asks_for_entity || intent.asks_question);

  const rankPrimaryContext = Boolean(intent.rank_context_requested_primary);
  const platformPrimaryContext = Boolean(intent.platform_context_requested_primary);
  const queuePrimaryContext = Boolean(intent.queue_context_requested_primary);
  const mapPrimaryContext = Boolean(intent.map_context_requested_primary);

  const allCategories = ['hero', 'map', 'rank', 'platform', 'queue', 'mode', 'role', 'ability', 'perk'];
  const fuzzyAllowlist = new Set(['hero', 'map', 'rank', 'platform', 'queue', 'ability']);

  const SHADOW_MODE_ENABLED = true;
  const SHADOW_MODE_RESTRICT_TO_PRIMARY_SURFACES = true;
  const shadowAllowed = {};
  const shadowCandidateSpans = {};

  function addShadowSpan(cat, span) {
    if (!shadowCandidateSpans[cat]) shadowCandidateSpans[cat] = [];
    const key = `${span.source}|${span.source_id || ''}|${span.text_norm || ''}|${span.reason || ''}`;
    if (!shadowCandidateSpans[cat]._seen) shadowCandidateSpans[cat]._seen = new Set();
    if (shadowCandidateSpans[cat]._seen.has(key)) return;
    shadowCandidateSpans[cat]._seen.add(key);
    shadowCandidateSpans[cat].push(span);
  }

  const allowed = {};
  const blocked = {};
  const candidateSpans = {};
  const categoriesWithAnyExact = unique(candidates.map((c) => c.category));
  let heroFuzzyCarveOut = null;

  function addSpan(cat, span) {
    if (!candidateSpans[cat]) candidateSpans[cat] = [];
    const key = `${span.source}|${span.source_id || ''}|${span.text_norm || ''}|${span.reason || ''}`;
    if (!candidateSpans[cat]._seen) candidateSpans[cat]._seen = new Set();
    if (candidateSpans[cat]._seen.has(key)) return;
    candidateSpans[cat]._seen.add(key);
    candidateSpans[cat].push(span);
  }

  function hasPrimaryExactFor(cat) {
    const s = byCategory[cat];
    if (!s) return false;
    return Number(s.primary_total || 0) > 0;
  }

  function hasPrimaryCanonicalExactFor(cat) {
    const s = byCategory[cat];
    if (!s) return false;
    return Number(s.canonical_primary || 0) > 0;
  }

  function hasCommentOnlyExactFor(cat) {
    const s = byCategory[cat];
    if (!s) return false;
    return Number(s.comment || 0) > 0 && Number(s.primary_total || 0) === 0;
  }

  function hasAnchorSignalFor() { return false; }
  function hasHeroAnchorSignal() { return false; }
  function hasAbilityAnchorSignal() { return false; }

  function hasAbilityOwnerHeroPrimarySupport() {
    return Boolean(
      abilitySupportSummary.has_ability_owner_hero_primary_canonical_support ||
      abilitySupportSummary.has_ability_owner_hero_primary_any_support
    );
  }

  const titleRaw = toStr(detect?.sources?.title?.raw);
  const opRaw = toStr(detect?.sources?.op?.raw);
  const titleNorm = toStr(detect?.sources?.title?.norm);
  const opNorm = toStr(detect?.sources?.op?.norm);
  const comments = safeArray(detect?.sources?.comments);

  function primaryRawHasDelimiterVariantSignal() {
    const raws = [titleRaw, opRaw].filter(Boolean);
    if (!raws.length) return false;
    return raws.some((r) => /[-_/]/.test(toStr(r)));
  }

  function primaryNormLooksMultiToken() {
    return /\s/.test(titleNorm) || /\s/.test(opNorm);
  }

  function hasPrimaryDelimiterVariantOpportunity(cat) {
    if (!primaryRawHasDelimiterVariantSignal()) return false;
    if (!primaryNormLooksMultiToken()) return false;
    if (cat === 'hero' || cat === 'map') return true;
    if (cat === 'ability') return hasAbilityOwnerHeroPrimarySupport();
    return false;
  }

  const anchorTermsPresent = isObject(policySignals?.anchors_present) ? policySignals.anchors_present : {};
  const negativeHits = isObject(policySignals?.negative_anchor_hits) ? policySignals.negative_anchor_hits : {};

  function addShadowPrimarySpansForCategory(cat, why) {
    if (!SHADOW_MODE_ENABLED) return;
    if (!SHADOW_MODE_RESTRICT_TO_PRIMARY_SURFACES) return;

    if (titleNorm) addShadowSpan(cat, { source: 'title', source_id: 'TITLE', text_norm: titleNorm, reason: why });
    if (opNorm) addShadowSpan(cat, { source: 'op', source_id: 'OP', text_norm: opNorm, reason: why });
  }

  for (const cat of allCategories) {
    let isAllowed = false;
    let reason = 'no_intent_or_anchor_signal';

    if (!fuzzyAllowlist.has(cat)) {
      blocked[cat] = 'fuzzy_v2_category_disabled';
      continue;
    }

    if (exactStrong[cat]) {
      blocked[cat] = 'exact_strong_match_present';
      if (SHADOW_MODE_ENABLED) {
        shadowAllowed[cat] = 'exact_strong_match_present_shadow_only';
        addShadowPrimarySpansForCategory(cat, 'shadow_only_exact_strong');
      }
      continue;
    }

    const hasAnchorSignal = hasAnchorSignalFor(cat);
    const inPrimaryIntent = targetCategoriesPrimary.includes(cat);
    const inUnionIntentOnly = !inPrimaryIntent && targetCategoriesUnion.includes(cat);
    const hasAnyExactForCat = categoriesWithAnyExact.includes(cat);

    const conceptAnchorTermsPresent =
      (cat === 'rank' && !!anchorTermsPresent.rank) ||
      (cat === 'platform' && !!anchorTermsPresent.platform) ||
      (cat === 'queue' && !!anchorTermsPresent.queue) ||
      (cat === 'mode' && !!anchorTermsPresent.mode) ||
      (cat === 'role' && !!anchorTermsPresent.role);

    if (cat === 'rank' && safeArray(negativeHits.rank).length > 0) {
      if (!hasAnchorSignal && !inPrimaryIntent && !rankPrimaryContext) {
        blocked[cat] = 'rank_negative_anchor_primary_block';
        if (SHADOW_MODE_ENABLED) {
          shadowAllowed[cat] = 'rank_negative_anchor_primary_shadow_only';
          addShadowPrimarySpansForCategory(cat, 'shadow_only_rank_negative_anchor_primary');
        }
        continue;
      }
    }
    if (cat === 'platform' && safeArray(negativeHits.platform_switch).length > 0) {
      if (!hasAnchorSignal && !inPrimaryIntent && !platformPrimaryContext) {
        blocked[cat] = 'platform_switch_verb_primary_block';
        if (SHADOW_MODE_ENABLED) {
          shadowAllowed[cat] = 'platform_switch_verb_primary_shadow_only';
          addShadowPrimarySpansForCategory(cat, 'shadow_only_platform_switch_verb_primary');
        }
        continue;
      }
    }

    if (inPrimaryIntent) {
      isAllowed = true;
      reason = 'intent_target_category_primary_unresolved';
    }

    if (!isAllowed && hasAnchorSignal) {
      isAllowed = true;
      reason = 'unmatched_anchor_literal';
    }

    if (!isAllowed && asksForEntity && ['hero', 'rank'].includes(cat)) {
      if (hasAnyExactForCat || hasAnchorSignal) {
        isAllowed = true;
        reason = 'question_intent_with_partial_signal';
      }
    }

    if (!isAllowed && cat === 'ability') {
      const heroAnchor = hasHeroAnchorSignal();
      const abilityAnchor = hasAbilityAnchorSignal();
      const ownerHeroPrimarySupport = hasAbilityOwnerHeroPrimarySupport();
      const hasAbilityExact = hasAnyExactForCat;

      if (abilityAnchor) {
        isAllowed = true;
        reason = 'ability_unmatched_anchor_literal';
      } else if (heroAnchor && (hasAbilityExact || hasPrimaryExactFor('hero') || hasPrimaryCanonicalExactFor('hero'))) {
        isAllowed = true;
        reason = 'hero_anchor_with_ability_or_hero_exact_support';
      } else if (ownerHeroPrimarySupport) {
        isAllowed = true;
        reason = 'ability_owner_hero_primary_support';
      } else if (hasAbilityExact && !hasCommentOnlyExactFor('ability')) {
        isAllowed = true;
        reason = 'ability_exact_partial_primary_support';
      }
    }

    if (isAllowed && cat === 'hero' && !hasAnchorSignal) {
      const commentOnlyHero = hasCommentOnlyExactFor('hero');
      const hasPrimaryHero = hasPrimaryExactFor('hero');
      if (commentOnlyHero && !hasPrimaryHero) {
        isAllowed = false;
        reason = 'comment_only_hero_signal_no_primary_or_anchor';
      }
    }

    if (isAllowed && cat === 'map' && !hasAnchorSignal) {
      const commentOnlyMap = hasCommentOnlyExactFor('map');
      if (commentOnlyMap && !mapPrimaryContext && !inPrimaryIntent) {
        isAllowed = false;
        reason = 'comment_only_map_signal_no_primary_context';
      }
      if (!mapPrimaryContext && !inPrimaryIntent && !hasPrimaryExactFor('map')) {
        isAllowed = false;
        reason = 'map_fuzzy_requires_primary_map_signal_or_anchor';
      }
    }

    if (isAllowed && cat === 'ability' && !hasAnchorSignalFor('ability')) {
      const commentOnlyAbility = hasCommentOnlyExactFor('ability');
      const ownerHeroPrimarySupport = hasAbilityOwnerHeroPrimarySupport();
      const heroAnchor = hasHeroAnchorSignal();
      if (commentOnlyAbility && !ownerHeroPrimarySupport && !heroAnchor && !hasPrimaryCanonicalExactFor('ability')) {
        isAllowed = false;
        reason = 'comment_only_ability_signal_no_anchor_or_owner_hero_primary_support';
      }
    }

    if (isAllowed && ['rank', 'platform', 'queue'].includes(cat) && !hasAnchorSignal) {
      const hasPrimaryContext =
        (cat === 'rank' && rankPrimaryContext) ||
        (cat === 'platform' && platformPrimaryContext) ||
        (cat === 'queue' && queuePrimaryContext);

      if (!hasPrimaryContext && !inPrimaryIntent && !conceptAnchorTermsPresent) {
        isAllowed = false;
        reason = `requires_anchor_terms_missing_${cat}`;
      }
    }

    if (isAllowed && inUnionIntentOnly && !hasAnchorSignal) {
      if (cat === 'rank' && !rankPrimaryContext && hasCommentOnlyExactFor(cat)) {
        isAllowed = false;
        reason = 'comment_only_rank_signal_no_primary_context';
      }
      if (cat === 'platform' && !platformPrimaryContext && hasCommentOnlyExactFor(cat)) {
        isAllowed = false;
        reason = 'comment_only_platform_signal_no_primary_context';
      }
      if (cat === 'queue' && !queuePrimaryContext && hasCommentOnlyExactFor(cat)) {
        isAllowed = false;
        reason = 'comment_only_queue_signal_no_primary_context';
      }
    }

    if (!isAllowed && hasPrimaryDelimiterVariantOpportunity(cat) && !hasCommentOnlyExactFor(cat) && !hasPrimaryExactFor(cat)) {
      isAllowed = true;
      reason = `primary_delimiter_variant_${cat}`;
    }

    if (cat === 'hero' && !isAllowed && hasCommentOnlyExactFor('hero') && !hasPrimaryExactFor('hero')) {
      const carve = tryHeroPrimaryTypoCarveOut({
        candidates,
        titleNorm,
        opNorm,
        dictRows: safeArray(dictRows),
      });
      if (carve) {
        isAllowed = true;
        reason = 'hero_primary_typo_carve_out';
        heroFuzzyCarveOut = carve;
      }
    }

    if (!isAllowed) {
      blocked[cat] = reason;
      continue;
    }

    allowed[cat] = reason;

    if (SHADOW_MODE_ENABLED && !shadowAllowed[cat]) shadowAllowed[cat] = reason;

    if (titleNorm) {
      addSpan(cat, { source: 'title', source_id: 'TITLE', text_norm: titleNorm, reason: 'primary_text' });
      if (SHADOW_MODE_ENABLED) addShadowSpan(cat, { source: 'title', source_id: 'TITLE', text_norm: titleNorm, reason: 'primary_text' });
    }
    if (opNorm) {
      addSpan(cat, { source: 'op', source_id: 'OP', text_norm: opNorm, reason: 'primary_text' });
      if (SHADOW_MODE_ENABLED) addShadowSpan(cat, { source: 'op', source_id: 'OP', text_norm: opNorm, reason: 'primary_text' });
    }

    if (['rank', 'platform', 'queue'].includes(cat)) {
      const hasPrimaryContext =
        (cat === 'rank' && rankPrimaryContext) ||
        (cat === 'platform' && platformPrimaryContext) ||
        (cat === 'queue' && queuePrimaryContext);

      const allowCommentScan =
        hasPrimaryContext ||
        hasAnchorSignal ||
        inPrimaryIntent ||
        conceptAnchorTermsPresent ||
        hasPrimaryExactFor(cat) ||
        hasPrimaryCanonicalExactFor(cat);

      if (allowCommentScan) {
        for (const c of comments) {
          const cNorm = toStr(c.norm);
          if (!cNorm) continue;
          addSpan(cat, { source: 'comment', source_id: toStr(c.id) || null, text_norm: cNorm, reason: 'comment_fallback' });
        }
      }
    }
  }

  for (const cat of Object.keys(candidateSpans)) {
    if (candidateSpans[cat] && candidateSpans[cat]._seen) delete candidateSpans[cat]._seen;
  }
  for (const cat of Object.keys(shadowCandidateSpans)) {
    if (shadowCandidateSpans[cat] && shadowCandidateSpans[cat]._seen) delete shadowCandidateSpans[cat]._seen;
  }

  return {
    allowed_categories: Object.keys(allowed),
    blocked_categories: blocked,
    category_reasons: allowed,
    candidate_spans: candidateSpans,

    hero_fuzzy_carve_out: heroFuzzyCarveOut,

    shadow_allowed_categories: Object.keys(shadowAllowed),
    shadow_blocked_categories: blocked,
    shadow_category_reasons: shadowAllowed,
    shadow_candidate_spans: shadowCandidateSpans,

    policy_signals: {
      concept_anchor_terms_present: anchorTermsPresent,
      negative_anchor_hits: negativeHits,
    },

    policy: {
      exact_first: true,
      skip_if_exact_strong: true,
      fuzzy_v2_allowlist: ['hero', 'map', 'rank', 'platform', 'queue', 'ability'],
      comments_fuzzy_restricted_to: ['rank', 'platform', 'queue'],
      comments_fuzzy_disabled_for: ['hero', 'map', 'ability'],
      comments_fuzzy_requires_primary_context_for: ['rank', 'platform', 'queue'],
      map_question_fuzzy_fallback_disabled: true,
      mode_role_fuzzy_disabled: true,
      ability_fuzzy_enabled: true,
      ability_fuzzy_open_requires: [
        'primary_intent',
        'ability_owner_hero_primary_support',
        'ability_exact_partial_primary_support',
      ],
      ability_comments_fuzzy_disabled: true,
      perk_fuzzy_disabled: true,
      primary_delimiter_variant_relax_enabled: true,
      primary_delimiter_variant_canonical_categories: ['hero', 'map'],
      primary_delimiter_variant_owner_supported_categories: ['ability'],
      shadow_mode_enabled: SHADOW_MODE_ENABLED,
      shadow_mode_restrict_to_primary_surfaces: SHADOW_MODE_RESTRICT_TO_PRIMARY_SURFACES,
      shadow_mode_notes: 'shadow_allowed_categories/spans are for telemetry only; do not emit candidates when not in allowed_categories',
      variant_relax_notes: 'allows narrow primary delimiter/hyphen opportunities into allowed_categories so deterministic equivalence can decide later',
    },
  };
}

/** Curated n8n Combine Dictionaries notes (for snapshot parity when meta.notes is absent). */
const DEFAULT_DICTIONARY_META_NOTES = [
  'Combined DB dictionaries + static detection dictionaries',
  'DB+META rows pulled from node: Merge SQL data',
  'META rows are used for deterministic context only (no text matching)',
  'rank_brackets are derived taxonomy and are not direct text-matched (RANK_BRACKET rows excluded from rows)',
  'policy_meta includes anchor_groups + negative_anchors + bracket membership',
  'v3.3 adds policy overlay for risky ABILITY/PERK aliases + alias collision registry',
  'v3.4 carries answer_slot_patterns from static dictionaries for downstream answer-tier scoring',
];

function compactDictionaryMeta(meta, policyMeta) {
  if (!isObject(meta)) return null;

  const hasEntityMetaObject = isObject(meta.entity_meta);
  const hasEntityMetaRows = Boolean(meta.entity_meta_counts && meta.entity_meta_counts.meta_rows_in > 0);
  const hasEntityMeta = hasEntityMetaObject || hasEntityMetaRows;

  const out = {
    source_counts: isObject(meta.source_counts) ? meta.source_counts : null,
    category_counts: isObject(meta.category_counts) ? meta.category_counts : null,
    entity_meta_counts: isObject(meta.entity_meta_counts) ? meta.entity_meta_counts : null,
    has_entity_meta: Boolean(hasEntityMeta),
    notes: Array.isArray(meta.notes) ? meta.notes : DEFAULT_DICTIONARY_META_NOTES,
  };

  const ag = isObject(policyMeta?.anchor_groups) ? policyMeta.anchor_groups : {};
  const na = isObject(policyMeta?.negative_anchors) ? policyMeta.negative_anchors : {};
  const acr = isObject(policyMeta?.alias_collision_registry) ? policyMeta.alias_collision_registry : {};
  const cw = Array.isArray(policyMeta?.common_word_alias_norms) ? policyMeta.common_word_alias_norms : [];

  out.policy_meta_snapshot = {
    anchor_groups_keys: Object.keys(ag),
    negative_anchors_keys: Object.keys(na),
    alias_collision_registry_types: Object.keys(acr),
    common_word_alias_norms_count: cw.length,
  };

  return out;
}

function isDetectionItem(j) {
  return isObject(j) && typeof j.post_id !== 'undefined' && isObject(j.detect);
}

/**
 * @param {object} detectionInputItem - Output of buildDetectionInput for one post.
 * @param {object} policyBundle - Output of loadPolicyBundle.
 * @returns {object} Pack stage payload (post_id, detect, entity_candidates_exact, exact_detection_meta, fuzzy_plan).
 */
function packCandidates(detectionInputItem, policyBundle) {
  const j = detectionInputItem || {};
  if (!isDetectionItem(j)) {
    throw new Error('packCandidates: expected an object with post_id and detect (buildDetectionInput output).');
  }

  const dictRows = safeArray(policyBundle?.dictionaries?.rows);
  if (!dictRows.length) {
    throw new Error('packCandidates: policyBundle.dictionaries.rows is empty.');
  }

  const policyMeta = pickPolicyMeta(policyBundle);
  const dictRowsByType = buildDictionaryIndex(dictRows);
  const dictionaryMetaSnapshotCompact = compactDictionaryMeta(policyBundle.meta, policyMeta);

  const postId = toStr(j.post_id).trim();
  const detect = isObject(j.detect) ? j.detect : {};

  const policySignals = computePolicySignalsForItem({ detect, policyMeta });

  const { candidates: exactCandidates, shadow_only_exact_skips } = buildExactCandidatesForItem({
    itemJson: j,
    dictRowsByType,
    policySignals,
  });

  const exactSummary = summarizeExact(exactCandidates);
  const fuzzyPlan = buildFuzzyPlan({
    detect,
    exactSummary,
    candidates: exactCandidates,
    policySignals,
    dictRows,
  });

  const exactCountsByCategory = {};
  for (const c of exactCandidates) {
    exactCountsByCategory[c.category] = (exactCountsByCategory[c.category] || 0) + 1;
  }

  return {
    post_id: postId,
    detect,
    entity_candidates_exact: exactCandidates,
    exact_detection_meta: {
      version: 'pack_exact_v7.9_no_anchors',
      candidate_count: exactCandidates.length,
      category_counts: exactCountsByCategory,
      exact_summary: exactSummary,
      dictionary_meta_snapshot: dictionaryMetaSnapshotCompact,
      policy_signals: policySignals,
      shadow_only_exact_skips: shadow_only_exact_skips,
    },
    fuzzy_plan: {
      ...fuzzyPlan,
      version: 'fuzzy_plan_v3.3_hero_primary_typo_carve_out',
    },
  };
}

module.exports = {
  packCandidates,
};

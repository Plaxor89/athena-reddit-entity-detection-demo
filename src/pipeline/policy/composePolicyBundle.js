const { summarizePolicyBundleMeta } = require('./summarizePolicyBundleMeta');

function toStr(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

function norm(input) {
  let s = toStr(input).normalize('NFKC').toLowerCase();
  s = s.replace(/[\u2018\u2019\u201B]/g, "'");
  s = s.replace(/[\u201C\u201D]/g, '"');
  s = s.replace(/[^a-z0-9\s]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function toBool(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

function toInt(v, fallback = null) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

const COMMON_WORD_ALIAS_NORMS = new Set([
  'window', 'anti', 'coal', 'cryo', 'blossom', 'charge', 'hook', 'bubble', 'wall',
  'beam', 'orb', 'shield', 'heal', 'speed', 'boost', 'speed boost', 'nade', 'grenade',
  'sleep', 'dart', 'spear', 'mine', 'swap', 'switch', 'push', 'hold', 'tap', 'ping'
]);

function isCommonRiskAlias(aliasNorm) {
  if (!aliasNorm) return false;
  if (COMMON_WORD_ALIAS_NORMS.has(aliasNorm)) return true;
  const parts = aliasNorm.split(' ');
  return parts.length === 1 ? parts[0].length <= 4 : false;
}

function computeShortAlias(aliasNorm) {
  if (!aliasNorm) return false;
  const parts = aliasNorm.split(' ');
  return parts.length === 1 ? parts[0].length <= 3 : false;
}

function normalizeRow(raw) {
  return {
    entity_type: toStr(raw.entity_type).trim().toUpperCase(),
    entity_slug: toStr(raw.entity_slug).trim(),
    hero_slug: toStr(raw.hero_slug).trim() || null,
    alias_text: toStr(raw.alias_text).trim(),
    alias_text_norm: toStr(raw.alias_text_norm).trim() || norm(raw.alias_text),
    source_kind: toStr(raw.source_kind).trim() || 'unknown',
    tier: toStr(raw.tier).trim() || 'UNKNOWN',
    is_canonical: toBool(raw.is_canonical),
    fuzzy_allowed: toBool(raw.fuzzy_allowed),
    promotion_risk: toStr(raw.promotion_risk).trim().toUpperCase() || null,
    requires_ow_context: raw.requires_ow_context === undefined ? null : toBool(raw.requires_ow_context),
    requires_anchor: raw.requires_anchor === undefined ? null : toBool(raw.requires_anchor),
    anchor_group: toStr(raw.anchor_group).trim() || null,
    window_tokens: raw.window_tokens === undefined ? null : toInt(raw.window_tokens, null),
    comment_only_requires_corroboration: raw.comment_only_requires_corroboration === undefined ? null : toBool(raw.comment_only_requires_corroboration),
    short_alias: raw.short_alias === undefined ? null : toBool(raw.short_alias),
    prefer_canonical_over_alias: raw.prefer_canonical_over_alias === undefined ? null : toBool(raw.prefer_canonical_over_alias),
    allow_high_tier_only: raw.allow_high_tier_only === undefined ? null : toBool(raw.allow_high_tier_only),
    alias_collision_count: null,
    alias_collision_key: null,
    alias_common_word_risk: null,
  };
}

function normalizeMetaRow(raw) {
  return {
    meta_type: toStr(raw.meta_type).trim().toUpperCase(),
    slug: toStr(raw.slug).trim(),
    owner_slug: toStr(raw.owner_slug).trim() || null,
    k1: toStr(raw.k1).trim() || null,
    k2: toStr(raw.k2).trim() || null,
  };
}

function mergePolicyPreferNonNull(target, incoming) {
  const out = { ...target };
  for (const k of [
    'requires_ow_context', 'requires_anchor', 'anchor_group', 'window_tokens',
    'comment_only_requires_corroboration', 'short_alias', 'prefer_canonical_over_alias',
    'allow_high_tier_only'
  ]) {
    if ((out[k] === null || out[k] === undefined) && (incoming[k] !== null && incoming[k] !== undefined)) {
      out[k] = incoming[k];
    }
  }

  const sev = { LOW: 1, MEDIUM: 2, HIGH: 3 };
  const a = toStr(out.promotion_risk).toUpperCase();
  const b = toStr(incoming.promotion_risk).toUpperCase();
  if (a && b) out.promotion_risk = sev[b] > sev[a] ? b : a;
  else if (!a && b) out.promotion_risk = b;

  out.fuzzy_allowed = Boolean(out.fuzzy_allowed || incoming.fuzzy_allowed);
  out.is_canonical = Boolean(out.is_canonical || incoming.is_canonical);
  return out;
}

function rowKey(r) {
  return [r.entity_type, r.entity_slug, r.hero_slug || '', r.alias_text_norm].join('|');
}

function sortRowsForDedupe(a, b) {
  const ka = rowKey(a);
  const kb = rowKey(b);
  if (ka < kb) return -1;
  if (ka > kb) return 1;
  if (a.is_canonical !== b.is_canonical) return a.is_canonical ? -1 : 1;
  if (a.source_kind < b.source_kind) return -1;
  if (a.source_kind > b.source_kind) return 1;
  const rank = (t) => ({ CANONICAL: 0, TIER_1: 1, TIER_2: 2, TIER_3: 3, STATIC_ALIAS: 4 }[toStr(t).toUpperCase()] ?? 9);
  return rank(a.tier) - rank(b.tier);
}

function dedupeRows(rows) {
  const seen = new Map();
  for (const r of [...rows].sort(sortRowsForDedupe)) {
    if (!r.entity_type || !r.entity_slug || !r.alias_text_norm) continue;
    if (r.entity_type === 'RANK_BRACKET') continue;
    const key = rowKey(r);
    seen.set(key, seen.has(key) ? mergePolicyPreferNonNull(seen.get(key), r) : r);
  }
  return Array.from(seen.values());
}

function overlayPolicy(rows, staticPolicyMeta) {
  const anchorGroups = staticPolicyMeta.anchor_groups || {};
  const defaultAnchorGroupByType = { ABILITY: 'ability', PERK: 'perk' };
  return rows.map((r) => {
    const rr = { ...r };
    if (rr.short_alias === null || rr.short_alias === undefined) rr.short_alias = computeShortAlias(rr.alias_text_norm);
    const isAlias = !rr.is_canonical;
    const tierU = toStr(rr.tier).toUpperCase();
    const commonRisk = isAlias && (tierU === 'TIER_3' || tierU === 'TIER_2') && isCommonRiskAlias(rr.alias_text_norm);
    rr.alias_common_word_risk = commonRisk;

    if (!rr.promotion_risk && (commonRisk || rr.short_alias)) rr.promotion_risk = 'HIGH';
    if (rr.promotion_risk && (commonRisk || rr.short_alias) && rr.promotion_risk !== 'HIGH') rr.promotion_risk = 'HIGH';

    if (isAlias && (rr.entity_type === 'ABILITY' || rr.entity_type === 'PERK')) {
      if (rr.requires_ow_context === null) rr.requires_ow_context = true;
      const riskyOverlay = commonRisk || rr.short_alias;
      if (riskyOverlay) {
        if (rr.requires_anchor === null) rr.requires_anchor = true;
        if (!rr.anchor_group) rr.anchor_group = defaultAnchorGroupByType[rr.entity_type] || null;
        if (rr.window_tokens === null) rr.window_tokens = 24;
        if (rr.comment_only_requires_corroboration === null) rr.comment_only_requires_corroboration = true;
        if (rr.allow_high_tier_only === null) rr.allow_high_tier_only = true;
        if (rr.prefer_canonical_over_alias === null) rr.prefer_canonical_over_alias = true;
      }
    }

    if (isAlias && (rr.entity_type === 'HERO' || rr.entity_type === 'MAP') && rr.short_alias) {
      if (rr.requires_ow_context === null) rr.requires_ow_context = true;
      if (rr.requires_anchor === null) rr.requires_anchor = true;
      if (!rr.window_tokens) rr.window_tokens = 24;
      if (!rr.anchor_group) {
        const guess = rr.entity_type === 'HERO' ? 'hero' : 'map';
        rr.anchor_group = anchorGroups[guess] ? guess : rr.anchor_group;
      }
      if (rr.comment_only_requires_corroboration === null) rr.comment_only_requires_corroboration = true;
      if (rr.allow_high_tier_only === null) rr.allow_high_tier_only = true;
      if (rr.prefer_canonical_over_alias === null) rr.prefer_canonical_over_alias = true;
      if (!rr.promotion_risk) rr.promotion_risk = 'HIGH';
    }
    return rr;
  });
}

function computeAliasCollisions(rows) {
  const registry = {};
  const buckets = {};
  for (const r of rows) {
    if (!r.entity_type || !r.alias_text_norm) continue;
    const key = `${r.entity_type}|${r.alias_text_norm}`;
    if (!buckets[key]) buckets[key] = new Set();
    buckets[key].add(`${r.entity_slug}|${r.hero_slug || ''}`);
  }

  const out = rows.map((r) => {
    const key = `${r.entity_type}|${r.alias_text_norm}`;
    const n = buckets[key] ? buckets[key].size : 0;
    const rr = { ...r, alias_collision_count: n, alias_collision_key: n > 1 ? key : null };
    if (!rr.is_canonical && n > 1) {
      rr.promotion_risk = 'HIGH';
      if (rr.requires_anchor === null) rr.requires_anchor = true;
      if (rr.window_tokens === null) rr.window_tokens = 24;
      if (rr.comment_only_requires_corroboration === null) rr.comment_only_requires_corroboration = true;
      if (rr.allow_high_tier_only === null) rr.allow_high_tier_only = true;
      if (rr.prefer_canonical_over_alias === null) rr.prefer_canonical_over_alias = true;
    }
    return rr;
  });

  for (const [key, set] of Object.entries(buckets)) {
    if (set.size <= 1) continue;
    const [type, aliasNorm] = key.split('|');
    if (!registry[type]) registry[type] = {};
    registry[type][aliasNorm] = Array.from(set);
  }

  return { rows: out, aliasCollisionRegistry: registry };
}

function buildGrouped(rows) {
  const byType = {};
  const aliasIndexByType = {};
  for (const row of rows) {
    const type = row.entity_type;
    byType[type] = byType[type] || {};
    aliasIndexByType[type] = aliasIndexByType[type] || {};

    if (!byType[type][row.entity_slug]) {
      byType[type][row.entity_slug] = {
        entity_type: type,
        entity_slug: row.entity_slug,
        hero_slug: row.hero_slug || null,
        canonical_aliases: [],
        alias_rows: [],
        has_canonical: false,
        has_aliases: false,
      };
    }
    const bucket = byType[type][row.entity_slug];
    bucket.alias_rows.push(row);
    if (row.is_canonical) {
      bucket.has_canonical = true;
      bucket.canonical_aliases.push(row.alias_text_norm);
    } else {
      bucket.has_aliases = true;
    }

    aliasIndexByType[type][row.alias_text_norm] = aliasIndexByType[type][row.alias_text_norm] || [];
    aliasIndexByType[type][row.alias_text_norm].push({
      entity_slug: row.entity_slug,
      hero_slug: row.hero_slug || null,
      source_kind: row.source_kind,
      tier: row.tier,
      is_canonical: row.is_canonical,
      fuzzy_allowed: row.fuzzy_allowed,
      promotion_risk: row.promotion_risk,
      requires_ow_context: row.requires_ow_context,
      requires_anchor: row.requires_anchor,
      anchor_group: row.anchor_group,
      window_tokens: row.window_tokens,
      comment_only_requires_corroboration: row.comment_only_requires_corroboration,
      short_alias: row.short_alias,
      prefer_canonical_over_alias: row.prefer_canonical_over_alias,
      allow_high_tier_only: row.allow_high_tier_only,
      alias_collision_count: row.alias_collision_count,
      alias_common_word_risk: row.alias_common_word_risk,
    });
  }

  const grouped = {};
  for (const [type, entities] of Object.entries(byType)) {
    grouped[type] = Object.values(entities).map((entry) => ({
      ...entry,
      canonical_aliases: [...new Set(entry.canonical_aliases)],
    }));
  }
  return { grouped, aliasIndexByType };
}

function buildEntityMeta(metaRowsRaw) {
  const metaRows = metaRowsRaw.map(normalizeMetaRow);
  const heroMetaBySlug = {};
  const mapMetaBySlug = {};
  const abilityMetaBySlug = {};
  const perkMetaBySlug = {};
  const by_type = { HERO: 0, MAP: 0, ABILITY: 0, PERK: 0, UNKNOWN: 0 };

  for (const r of metaRows) {
    if (by_type[r.meta_type] === undefined) by_type.UNKNOWN += 1;
    else by_type[r.meta_type] += 1;

    if (r.meta_type === 'HERO' && r.slug && r.k1) heroMetaBySlug[r.slug] = { role: r.k1 };
    if (r.meta_type === 'MAP' && r.slug && r.k1 && r.k2) mapMetaBySlug[r.slug] = { game_mode: r.k1, type: r.k2 };
    if (r.meta_type === 'ABILITY' && r.slug && r.owner_slug && r.k1) {
      abilityMetaBySlug[r.slug] = abilityMetaBySlug[r.slug] || { owners: [] };
      const owners = abilityMetaBySlug[r.slug].owners;
      const key = `${r.owner_slug}|${r.k1}`;
      if (!owners.some((o) => `${o.hero_slug}|${o.ability_kind}` === key)) owners.push({ hero_slug: r.owner_slug, ability_kind: r.k1 });
    }
    if (r.meta_type === 'PERK' && r.slug && r.owner_slug && r.k1) {
      perkMetaBySlug[r.slug] = perkMetaBySlug[r.slug] || { owners: [] };
      const owners = perkMetaBySlug[r.slug].owners;
      const key = `${r.owner_slug}|${r.k1}`;
      if (!owners.some((o) => `${o.hero_slug}|${o.tier}` === key)) owners.push({ hero_slug: r.owner_slug, tier: r.k1 });
    }
  }

  const entityMeta = { heroMetaBySlug, mapMetaBySlug, abilityMetaBySlug, perkMetaBySlug };
  const entityMetaCounts = {
    meta_rows_in: metaRows.length,
    by_type,
    heroMetaBySlug: Object.keys(heroMetaBySlug).length,
    mapMetaBySlug: Object.keys(mapMetaBySlug).length,
    abilityMetaBySlug: Object.keys(abilityMetaBySlug).length,
    perkMetaBySlug: Object.keys(perkMetaBySlug).length,
    ability_multi_owner_slugs: Object.values(abilityMetaBySlug).filter((v) => (v.owners || []).length > 1).length,
    perk_multi_owner_slugs: Object.values(perkMetaBySlug).filter((v) => (v.owners || []).length > 1).length,
  };
  return { entityMeta, entityMetaCounts };
}

function composePolicyBundle({ dbDictionaryRows, dbEntityMetaRows, staticPolicySources }) {
  const staticRowsRaw = Array.isArray(staticPolicySources.rows) ? staticPolicySources.rows : [];
  const rankBracketsRaw = Array.isArray(staticPolicySources.rank_brackets) ? staticPolicySources.rank_brackets : [];
  const staticMetaRaw = staticPolicySources.meta && typeof staticPolicySources.meta === 'object' ? staticPolicySources.meta : {};
  const staticAnswerSlotPatterns = staticPolicySources.answer_slot_patterns && typeof staticPolicySources.answer_slot_patterns === 'object'
    ? staticPolicySources.answer_slot_patterns
    : null;

  const staticPolicyMeta = {
    anchor_groups: staticMetaRaw.anchor_groups || {},
    negative_anchors: staticMetaRaw.negative_anchors || {},
    rank_bracket_membership: staticMetaRaw.rank_bracket_membership || {},
  };

  let combinedRows = dedupeRows([
    ...(Array.isArray(dbDictionaryRows) ? dbDictionaryRows : []).map(normalizeRow),
    ...staticRowsRaw.map(normalizeRow),
  ]);
  combinedRows = overlayPolicy(combinedRows, staticPolicyMeta);
  const collisionPack = computeAliasCollisions(combinedRows);
  const { grouped, aliasIndexByType } = buildGrouped(collisionPack.rows);
  const { entityMeta, entityMetaCounts } = buildEntityMeta(Array.isArray(dbEntityMetaRows) ? dbEntityMetaRows : []);

  const policyMeta = {
    anchor_groups: staticPolicyMeta.anchor_groups,
    negative_anchors: staticPolicyMeta.negative_anchors,
    rank_bracket_membership: staticPolicyMeta.rank_bracket_membership,
    answer_slot_patterns: staticAnswerSlotPatterns,
    alias_collision_registry: collisionPack.aliasCollisionRegistry,
    common_word_alias_norms: Array.from(COMMON_WORD_ALIAS_NORMS),
  };

  const dictionaries = {
    rows: collisionPack.rows,
    grouped,
    heroes: grouped.HERO || [],
    maps: grouped.MAP || [],
    abilities: grouped.ABILITY || [],
    perks: grouped.PERK || [],
    ranks: grouped.RANK || [],
    platforms: grouped.PLATFORM || [],
    queues: grouped.QUEUE || [],
    modes: grouped.MODE || [],
    roles: grouped.ROLE || [],
    alias_index_by_type: aliasIndexByType,
    rank_brackets: rankBracketsRaw,
  };

  const sourceCounts = {
    db_rows_in: Array.isArray(dbDictionaryRows) ? dbDictionaryRows.length : 0,
    meta_rows_in: Array.isArray(dbEntityMetaRows) ? dbEntityMetaRows.length : 0,
    static_rows_in: staticRowsRaw.length,
    combined_rows_out: collisionPack.rows.length,
  };

  const meta = summarizePolicyBundleMeta({
    dictionaries,
    entityMetaCounts,
    sourceCounts,
    staticMetaVersion: toStr(staticMetaRaw.version || '').trim() || null,
    aliasCollisionRegistry: collisionPack.aliasCollisionRegistry,
  });

  return {
    dictionaries,
    entityMeta,
    policyMeta,
    meta,
  };
}

module.exports = {
  composePolicyBundle,
};

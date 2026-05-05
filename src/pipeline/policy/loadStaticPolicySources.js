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

function isShortAliasText(aliasTextNorm) {
  return aliasTextNorm && aliasTextNorm.length <= 3;
}

function makeRows({ entityType, entries, defaults }) {
  const rows = [];
  const entityTypeUpper = toStr(entityType).toUpperCase();

  for (const entry of entries) {
    const canonicalId = toStr(entry.canonical_id).trim();
    const canonicalName = toStr(entry.canonical_name || canonicalId).trim();
    const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];

    const fuzzyAllowedCanonical = entry.fuzzy_allowed_canonical !== false;
    const fuzzyAllowedAliases = entry.fuzzy_allowed_aliases === true;

    const promotionRisk = toStr(entry.promotion_risk || defaults.promotion_risk || 'LOW').toUpperCase();
    const requiresOwContext = entry.requires_ow_context ?? defaults.requires_ow_context ?? true;
    const requiresAnchor = entry.requires_anchor ?? defaults.requires_anchor ?? false;
    const anchorGroup = entry.anchor_group ?? defaults.anchor_group ?? null;
    const commentOnlyRequiresCorroboration =
      entry.comment_only_requires_corroboration ?? defaults.comment_only_requires_corroboration ?? false;

    function basePolicy(extra = {}) {
      return {
        requires_ow_context: !!requiresOwContext,
        requires_anchor: !!requiresAnchor,
        anchor_group: anchorGroup,
        window_tokens: extra.window_tokens ?? defaults.window_tokens ?? 8,
        comment_only_requires_corroboration: !!commentOnlyRequiresCorroboration,
        short_alias: !!extra.short_alias,
        prefer_canonical_over_alias: extra.prefer_canonical_over_alias ?? defaults.prefer_canonical_over_alias ?? true,
        allow_high_tier_only: extra.allow_high_tier_only ?? defaults.allow_high_tier_only ?? false
      };
    }

    rows.push({
      entity_type: entityTypeUpper,
      entity_slug: canonicalId,
      hero_slug: null,
      alias_text: canonicalName,
      alias_text_norm: norm(canonicalName),
      source_kind: `${entityType.toLowerCase()}_name`,
      tier: 'CANONICAL',
      is_canonical: true,
      fuzzy_allowed: fuzzyAllowedCanonical,
      promotion_risk: promotionRisk,
      ...basePolicy({ short_alias: false })
    });

    rows.push({
      entity_type: entityTypeUpper,
      entity_slug: canonicalId,
      hero_slug: null,
      alias_text: canonicalId,
      alias_text_norm: norm(canonicalId.replace(/[_-]+/g, ' ')),
      source_kind: `${entityType.toLowerCase()}_slug`,
      tier: 'CANONICAL',
      is_canonical: true,
      fuzzy_allowed: fuzzyAllowedCanonical,
      promotion_risk: promotionRisk,
      ...basePolicy({ short_alias: false })
    });

    for (const a of aliases) {
      const aliasText = toStr(a).trim();
      if (!aliasText) continue;

      const aliasNorm = norm(aliasText);
      if (!aliasNorm) continue;

      const shortAlias = isShortAliasText(aliasNorm);

      rows.push({
        entity_type: entityTypeUpper,
        entity_slug: canonicalId,
        hero_slug: null,
        alias_text: aliasText,
        alias_text_norm: aliasNorm,
        source_kind: `${entityType.toLowerCase()}_alias`,
        tier: 'STATIC_ALIAS',
        is_canonical: false,
        fuzzy_allowed: fuzzyAllowedAliases,
        promotion_risk: promotionRisk,
        ...basePolicy({
          short_alias: shortAlias,
          allow_high_tier_only: shortAlias || promotionRisk === 'HIGH'
        })
      });
    }
  }

  const dedup = [];
  const seen = new Set();
  for (const r of rows) {
    if (!r.alias_text_norm) continue;
    const key = [r.entity_type, r.entity_slug, r.alias_text_norm].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(r);
  }
  return dedup;
}

const anchor_groups = {
  rank: ['rank', 'ranked', 'sr', 'mmr', 'elo', 'tier', 'division', 'derank', 'deranked', 'promote', 'promotion', 'climb', 'placement', 'placements'],
  platform: ['pc', 'computer', 'console', 'controller', 'ps4', 'ps5', 'psn', 'playstation', 'xbox', 'series x', 'series s', 'switch', 'nintendo', 'battle net', 'bnet', 'battlenet'],
  queue: ['queue', 'role queue', 'open queue', 'roleq', 'openq', 'rq', 'oq'],
  mode: ['mode', 'queue', 'match', 'game', 'in', 'play', 'playing'],
  role: ['role', 'comp', 'composition', 'team', 'need', 'swap', 'flex']
};

const negative_anchors = {
  rank: ['gold gun', 'golden gun', 'gold gun skin', 'diamond skin', 'diamond camo', 'master program', 'masterclass', 'master class', 'bronze medal', 'silver medal', 'gold medal'],
  platform_switch: ['switch to', 'switching to', 'switching', 'switched to']
};

const answer_slot_patterns = {
  tier1: [
    "\\bthe answer is\\b", "\\banswer\\s*:\\b", "\\bshort answer\\b", "\\btl\\s*;\\s*dr\\b", "\\bhere'?s (how|what|why)\\b",
    "\\bsolution\\b", "\\bworkaround\\b", "\\bfix(?:ed|es|ing)?\\b", "\\bresolved\\b", "\\bthat'?s the fix\\b",
    "\\bthat fixed it\\b", "\\bthis fixed it\\b", "\\bwhat worked for me\\b", "\\bworked for me\\b",
    "\\btry (this|doing|restarting|reinstalling|verifying)\\b", "\\brestart (the game|overwatch|ow2|your pc|your console)\\b",
    "\\breinstall\\b", "\\bverify (game )?files\\b", "\\bupdate (your|the) (drivers?|game)\\b", "\\bupdate your gpu drivers\\b",
    "\\bdisable (overlays?|overlay)\\b", "\\bturn (on|off)\\b", "\\benable\\b", "\\bdisable\\b",
    "\\bgo to (settings|options)\\b", "\\bgo into (settings|options)\\b", "\\bin (settings|options)\\b", "\\bset (it|this|your)\\b",
    "\\bchange (it|this|your)\\b", "\\bbind\\b", "\\bkeybind\\b", "\\brebind\\b", "\\bsensitivity\\b", "\\bdeadzone\\b",
    "\\bvsync\\b", "\\bframe cap\\b", "\\bfps cap\\b", "\\brender scale\\b",
    "\\bit(?:'?s| is) because\\b", "\\bthat'?s because\\b", "\\bthe reason is\\b", "\\bworks if\\b", "\\bworks when\\b", "\\bdoesn'?t work if\\b"
  ],
  tier2: [
    "\\bi think\\b", "\\bimo\\b", "\\bin my opinion\\b", "\\bin my experience\\b", "\\bi'?ve found\\b",
    "\\bfrom what i'?ve seen\\b", "\\bprobably\\b", "\\bmaybe\\b", "\\bmight\\b", "\\bcould be\\b",
    "\\bseems like\\b", "\\bfeels like\\b", "\\bi guess\\b"
  ],
  tier3: [
    "\\byou mean\\b", "\\bactually\\b", "\\bcorrection\\b", "\\bnot (?:really|exactly)\\b",
    "\\bit(?:'?s| is)\\s+not\\b", "\\bisn'?t\\b", "\\baren'?t\\b", "\\bno[, ]+\\s*(?:it(?:'?s| is)\\s*)?",
    "\\bnot\\s+.+\\bbut\\b"
  ],
  tier3_pairs: [
    { label: "NOT_X_ITS_Y", re: "\\b(?:it(?:'?s| is)\\s+)?not\\s+(.+?)\\s*(?:,|\\s)\\s*(?:it(?:'?s| is)|but)\\s+(.+?)\\b" },
    { label: "NO_ITS_Y", re: "\\bno[, ]+\\s*(?:it(?:'?s| is)\\s*)?(.+?)\\b" },
    { label: "YOU_MEAN_Y", re: "\\byou mean\\s+(.+?)\\b" }
  ]
};

const ranks = [
  { canonical_id: 'bronze', canonical_name: 'Bronze', aliases: ['bronze rank'], fuzzy_allowed_canonical: true, promotion_risk: 'MEDIUM', requires_ow_context: true, requires_anchor: true, anchor_group: 'rank', comment_only_requires_corroboration: true },
  { canonical_id: 'silver', canonical_name: 'Silver', aliases: ['silver rank'], fuzzy_allowed_canonical: true, promotion_risk: 'MEDIUM', requires_ow_context: true, requires_anchor: true, anchor_group: 'rank', comment_only_requires_corroboration: true },
  { canonical_id: 'gold', canonical_name: 'Gold', aliases: ['gold rank'], fuzzy_allowed_canonical: true, promotion_risk: 'MEDIUM', requires_ow_context: true, requires_anchor: true, anchor_group: 'rank', comment_only_requires_corroboration: true },
  { canonical_id: 'platinum', canonical_name: 'Platinum', aliases: ['plat', 'plat rank'], fuzzy_allowed_canonical: true, promotion_risk: 'HIGH', requires_ow_context: true, requires_anchor: true, anchor_group: 'rank', comment_only_requires_corroboration: true },
  { canonical_id: 'diamond', canonical_name: 'Diamond', aliases: ['diamond rank'], fuzzy_allowed_canonical: true, promotion_risk: 'HIGH', requires_ow_context: true, requires_anchor: true, anchor_group: 'rank', comment_only_requires_corroboration: true },
  { canonical_id: 'master', canonical_name: 'Master', aliases: ['masters', 'master rank'], fuzzy_allowed_canonical: true, promotion_risk: 'HIGH', requires_ow_context: true, requires_anchor: true, anchor_group: 'rank', comment_only_requires_corroboration: true },
  { canonical_id: 'grandmaster', canonical_name: 'Grandmaster', aliases: ['gm', 'grand master', 'gm rank', 'grandmasters'], fuzzy_allowed_canonical: true, promotion_risk: 'HIGH', requires_ow_context: true, requires_anchor: true, anchor_group: 'rank', comment_only_requires_corroboration: true },
  { canonical_id: 'champion', canonical_name: 'Champion', aliases: ['champ', 'champ rank'], fuzzy_allowed_canonical: true, promotion_risk: 'HIGH', requires_ow_context: true, requires_anchor: true, anchor_group: 'rank', comment_only_requires_corroboration: true }
];

const platforms = [
  { canonical_id: 'pc', canonical_name: 'PC', aliases: ['computer', 'battle.net', 'bnet', 'battlenet'], fuzzy_allowed_canonical: true, promotion_risk: 'MEDIUM', requires_ow_context: true, requires_anchor: true, anchor_group: 'platform' },
  { canonical_id: 'console', canonical_name: 'Console', aliases: ['consoles'], fuzzy_allowed_canonical: true, promotion_risk: 'LOW', requires_ow_context: true, requires_anchor: true, anchor_group: 'platform' },
  { canonical_id: 'playstation', canonical_name: 'PlayStation', aliases: ['psn', 'ps4', 'ps5', 'ps'], fuzzy_allowed_canonical: true, promotion_risk: 'MEDIUM', requires_ow_context: true, requires_anchor: true, anchor_group: 'platform' },
  { canonical_id: 'xbox', canonical_name: 'Xbox', aliases: ['series x', 'series s'], fuzzy_allowed_canonical: true, promotion_risk: 'MEDIUM', requires_ow_context: true, requires_anchor: true, anchor_group: 'platform' },
  { canonical_id: 'switch', canonical_name: 'Switch', aliases: ['nintendo switch'], fuzzy_allowed_canonical: true, promotion_risk: 'HIGH', requires_ow_context: true, requires_anchor: true, anchor_group: 'platform' }
];

const queues = [
  { canonical_id: 'role_queue', canonical_name: 'Role Queue', aliases: ['roleq', 'rq'], fuzzy_allowed_canonical: true, promotion_risk: 'MEDIUM', requires_ow_context: true, requires_anchor: true, anchor_group: 'queue', comment_only_requires_corroboration: true },
  { canonical_id: 'open_queue', canonical_name: 'Open Queue', aliases: ['openq', 'oq'], fuzzy_allowed_canonical: true, promotion_risk: 'MEDIUM', requires_ow_context: true, requires_anchor: true, anchor_group: 'queue', comment_only_requires_corroboration: true }
];

const modes = [
  { canonical_id: 'competitive', canonical_name: 'Competitive', aliases: ['comp', 'ranked'], fuzzy_allowed_canonical: true, promotion_risk: 'MEDIUM', requires_ow_context: true, anchor_group: 'mode' },
  { canonical_id: 'quick_play', canonical_name: 'Quick Play', aliases: ['quickplay', 'qp'], fuzzy_allowed_canonical: true, promotion_risk: 'MEDIUM', requires_ow_context: true, anchor_group: 'mode' },
  { canonical_id: 'arcade', canonical_name: 'Arcade', aliases: [], fuzzy_allowed_canonical: true, promotion_risk: 'LOW', requires_ow_context: true, anchor_group: 'mode' },
  { canonical_id: 'custom_game', canonical_name: 'Custom Game', aliases: ['custom games', 'custom lobby', 'custom lobbies'], fuzzy_allowed_canonical: true, promotion_risk: 'MEDIUM', requires_ow_context: true, anchor_group: 'mode' },
  { canonical_id: 'stadium', canonical_name: 'Stadium', aliases: [], fuzzy_allowed_canonical: true, promotion_risk: 'MEDIUM', requires_ow_context: true, anchor_group: 'mode' },
  { canonical_id: 'workshop', canonical_name: 'Workshop', aliases: ['workshop code'], fuzzy_allowed_canonical: true, promotion_risk: 'LOW', requires_ow_context: true, anchor_group: 'mode' },
  { canonical_id: 'practice_range', canonical_name: 'Practice Range', aliases: ['practice range'], fuzzy_allowed_canonical: true, promotion_risk: 'LOW', requires_ow_context: true, anchor_group: 'mode' },
  { canonical_id: 'mystery_heroes', canonical_name: 'Mystery Heroes', aliases: ['mystery heroes'], fuzzy_allowed_canonical: true, promotion_risk: 'LOW', requires_ow_context: true, anchor_group: 'mode' },
  { canonical_id: 'deathmatch', canonical_name: 'Deathmatch', aliases: ['death match'], fuzzy_allowed_canonical: true, promotion_risk: 'MEDIUM', requires_ow_context: true, anchor_group: 'mode' },
  { canonical_id: 'team_deathmatch', canonical_name: 'Team Deathmatch', aliases: ['team death match'], fuzzy_allowed_canonical: true, promotion_risk: 'MEDIUM', requires_ow_context: true, anchor_group: 'mode' },
  { canonical_id: 'capture_the_flag', canonical_name: 'Capture the Flag', aliases: ['capture the flag', 'ctf'], fuzzy_allowed_canonical: true, promotion_risk: 'HIGH', requires_ow_context: true, requires_anchor: true, anchor_group: 'mode' }
];

const roles = [
  { canonical_id: 'tank', canonical_name: 'Tank', aliases: ['tanks'], fuzzy_allowed_canonical: true, promotion_risk: 'LOW', requires_ow_context: true, anchor_group: 'role' },
  { canonical_id: 'damage', canonical_name: 'Damage', aliases: ['dps'], fuzzy_allowed_canonical: true, promotion_risk: 'MEDIUM', requires_ow_context: true, anchor_group: 'role' },
  { canonical_id: 'support', canonical_name: 'Support', aliases: ['supports', 'healer', 'healers'], fuzzy_allowed_canonical: true, promotion_risk: 'MEDIUM', requires_ow_context: true, anchor_group: 'role' }
];

const rankBrackets = [
  { canonical_id: 'metal_ranks', canonical_name: 'Metal Ranks' },
  { canonical_id: 'high_rank', canonical_name: 'High Rank' },
  { canonical_id: 'gm_plus', canonical_name: 'GM+' }
];

const defaultsByType = {
  RANK: { requires_ow_context: true, requires_anchor: true, anchor_group: 'rank', comment_only_requires_corroboration: true, window_tokens: 10, prefer_canonical_over_alias: true, promotion_risk: 'MEDIUM' },
  PLATFORM: { requires_ow_context: true, requires_anchor: true, anchor_group: 'platform', window_tokens: 8, prefer_canonical_over_alias: true, promotion_risk: 'MEDIUM' },
  QUEUE: { requires_ow_context: true, requires_anchor: true, anchor_group: 'queue', comment_only_requires_corroboration: true, window_tokens: 8, prefer_canonical_over_alias: true, promotion_risk: 'MEDIUM' },
  MODE: { requires_ow_context: true, requires_anchor: false, anchor_group: 'mode', window_tokens: 8, prefer_canonical_over_alias: true, promotion_risk: 'LOW' },
  ROLE: { requires_ow_context: true, requires_anchor: false, anchor_group: 'role', window_tokens: 8, prefer_canonical_over_alias: true, promotion_risk: 'LOW' }
};

/**
 * Hero aliases missing from DB `alias_registry` / canonical surfaces. Merged in composePolicyBundle with DB rows.
 *
 * Pack matching uses space-padded phrases (` ${alias_norm} `), so very short forms like `ram` only hit as a
 * standalone token (e.g. ` by ram as `), not inside unrelated words.
 *
 * `requires_ow_context: false` keeps deriveIntentEvidence non-applicable for these rows so matchup titles that
 * lack global OW cue tokens (`hero`, `overwatch`, etc.) are not blocked by intent_anchor + ow_context_present.
 */
const HERO_STATIC_ALIAS_ROWS = [
  {
    entity_type: 'HERO',
    entity_slug: 'ramattra',
    hero_slug: 'ramattra',
    alias_text: 'ram',
    alias_text_norm: 'ram',
    source_kind: 'static_hero_alias',
    tier: 'STATIC_ALIAS',
    is_canonical: false,
    fuzzy_allowed: false,
    promotion_risk: 'HIGH',
    requires_ow_context: false,
    requires_anchor: false,
    anchor_group: null,
    window_tokens: null,
    comment_only_requires_corroboration: null,
    short_alias: true,
    prefer_canonical_over_alias: true,
    allow_high_tier_only: null,
  },
  {
    entity_type: 'HERO',
    entity_slug: 'reinhardt',
    hero_slug: 'reinhardt',
    alias_text: 'reinfart',
    alias_text_norm: 'reinfart',
    source_kind: 'static_hero_alias',
    tier: 'STATIC_ALIAS',
    is_canonical: false,
    fuzzy_allowed: false,
    promotion_risk: 'MEDIUM',
    requires_ow_context: false,
    requires_anchor: false,
    anchor_group: null,
    window_tokens: null,
    comment_only_requires_corroboration: null,
    short_alias: false,
    prefer_canonical_over_alias: true,
    allow_high_tier_only: null,
  },
  {
    entity_type: 'HERO',
    entity_slug: 'juno',
    hero_slug: 'juno',
    alias_text: 'the cat is',
    alias_text_norm: norm('the cat is'),
    source_kind: 'static_hero_alias',
    tier: 'STATIC_ALIAS',
    is_canonical: false,
    fuzzy_allowed: false,
    promotion_risk: 'MEDIUM',
    requires_ow_context: true,
    requires_anchor: false,
    anchor_group: null,
    window_tokens: null,
    comment_only_requires_corroboration: null,
    short_alias: false,
    prefer_canonical_over_alias: true,
    allow_high_tier_only: null,
  },
  {
    entity_type: 'HERO',
    entity_slug: 'juno',
    hero_slug: 'juno',
    alias_text: 'the cat was',
    alias_text_norm: norm('the cat was'),
    source_kind: 'static_hero_alias',
    tier: 'STATIC_ALIAS',
    is_canonical: false,
    fuzzy_allowed: false,
    promotion_risk: 'MEDIUM',
    requires_ow_context: true,
    requires_anchor: false,
    anchor_group: null,
    window_tokens: null,
    comment_only_requires_corroboration: null,
    short_alias: false,
    prefer_canonical_over_alias: true,
    allow_high_tier_only: null,
  },
];

function loadStaticPolicySources() {
  const staticRows = [
    ...HERO_STATIC_ALIAS_ROWS,
    ...makeRows({ entityType: 'RANK', entries: ranks, defaults: defaultsByType.RANK }),
    ...makeRows({ entityType: 'PLATFORM', entries: platforms, defaults: defaultsByType.PLATFORM }),
    ...makeRows({ entityType: 'QUEUE', entries: queues, defaults: defaultsByType.QUEUE }),
    ...makeRows({ entityType: 'MODE', entries: modes, defaults: defaultsByType.MODE }),
    ...makeRows({ entityType: 'ROLE', entries: roles, defaults: defaultsByType.ROLE })
  ];

  const rankBracketRows = rankBrackets.map((rb) => ({
    entity_type: 'RANK_BRACKET',
    entity_slug: rb.canonical_id,
    hero_slug: null,
    alias_text: rb.canonical_name,
    alias_text_norm: norm(rb.canonical_name),
    source_kind: 'rank_bracket_name',
    tier: 'STATIC_DERIVED',
    is_canonical: true,
    fuzzy_allowed: false,
    promotion_risk: 'LOW',
    requires_ow_context: true,
    requires_anchor: false,
    anchor_group: null,
    window_tokens: 0,
    comment_only_requires_corroboration: false,
    short_alias: false,
    prefer_canonical_over_alias: true,
    allow_high_tier_only: false
  }));

  return {
    rows: staticRows,
    rank_brackets: rankBracketRows,
    answer_slot_patterns,
    meta: {
      version: 'v2.1',
      anchor_groups,
      negative_anchors,
      rank_bracket_membership: {
        metal_ranks: ['bronze', 'silver', 'gold', 'platinum', 'diamond'],
        high_rank: ['master', 'grandmaster', 'champion'],
        gm_plus: ['grandmaster', 'champion']
      }
    }
  };
}

module.exports = {
  loadStaticPolicySources,
};

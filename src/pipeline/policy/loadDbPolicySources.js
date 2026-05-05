const { query: defaultQuery } = require('../../lib/db');

const CANONICAL_ALIAS_SQL = `
WITH blacklist_term AS (
  SELECT lower(trim(p.alias_text)) AS term
  FROM public.alias_registry_policy p
  WHERE p.policy_enabled = true
    AND p.policy_action = 'BLACKLIST'
    AND p.policy_match_kind = 'TERM'
    AND p.policy_scope = 'GLOBAL'
),
current_perks AS (
  SELECT
    hp.hero_slug,
    COALESCE(hpv.perk_slug, hp.perk_slug) AS perk_slug,
    hpv.perk_name
  FROM public.hero_perks hp
  JOIN public.hero_perk_versions hpv ON hpv.perk_key = hp.perk_key
  WHERE hp.is_active = true
    AND hpv.is_active = true
    AND hpv.valid_to_patch_id IS NULL
    AND hpv.perk_name IS NOT NULL
),
canonical_raw AS (
  SELECT 'MAP'::text AS entity_type, m.map_slug AS entity_slug, NULL::text AS hero_slug, m.map_slug AS alias_text, lower(trim(m.map_slug)) AS alias_text_norm, 'map_slug'::text AS source_kind, 'CANONICAL'::text AS tier, true AS is_canonical
  FROM public.maps m
  UNION ALL
  SELECT 'MAP', m.map_slug, NULL::text, m.map_name, lower(trim(m.map_name)) AS alias_text_norm, 'map_name', 'CANONICAL', true
  FROM public.maps m
  UNION ALL
  SELECT 'HERO', h.hero_slug, h.hero_slug, h.hero_slug, lower(trim(h.hero_slug)) AS alias_text_norm, 'hero_slug', 'CANONICAL', true
  FROM public.heroes h
  UNION ALL
  SELECT 'HERO', h.hero_slug, h.hero_slug, h.hero_name, lower(trim(h.hero_name)) AS alias_text_norm, 'hero_name', 'CANONICAL', true
  FROM public.heroes h
  UNION ALL
  SELECT 'ABILITY', ha.ability_slug, ha.hero_slug, ha.ability_slug, lower(trim(ha.ability_slug)) AS alias_text_norm, 'ability_slug', 'CANONICAL', true
  FROM public.hero_ability ha
  WHERE ha.is_active = true
  UNION ALL
  SELECT 'ABILITY', ha.ability_slug, ha.hero_slug, ha.ability_name, lower(trim(ha.ability_name)) AS alias_text_norm, 'ability_name', 'CANONICAL', true
  FROM public.hero_ability ha
  WHERE ha.is_active = true
  UNION ALL
  SELECT 'PERK', cp.perk_slug, cp.hero_slug, cp.perk_slug, lower(trim(cp.perk_slug)) AS alias_text_norm, 'perk_slug', 'CANONICAL', true
  FROM current_perks cp
  UNION ALL
  SELECT 'PERK', cp.perk_slug, cp.hero_slug, cp.perk_name, lower(trim(cp.perk_name)) AS alias_text_norm, 'perk_name', 'CANONICAL', true
  FROM current_perks cp
),
canonical AS (
  SELECT *
  FROM canonical_raw c
  WHERE c.alias_text IS NOT NULL
    AND c.alias_text_norm <> ''
    AND (
      c.entity_type IN ('HERO','PERK')
      OR NOT EXISTS (
        SELECT 1
        FROM blacklist_term bt
        WHERE c.alias_text_norm = bt.term
      )
    )
),
derived_aliases_raw AS (
  SELECT
    ar.entity_type::text AS entity_type,
    ar.entity_slug AS entity_slug,
    ar.hero_slug AS hero_slug,
    ar.alias_text AS alias_text,
    lower(trim(ar.alias_text)) AS alias_text_norm,
    ar.source_kind AS source_kind,
    ar.tier::text AS tier,
    false AS is_canonical
  FROM public.alias_registry ar
  WHERE ar.row_kind = 'DERIVED'
    AND ar.is_blacklisted = false
    AND ar.entity_type IN ('HERO', 'ABILITY')
    AND NOT (ar.source_kind LIKE '%_name' OR ar.source_kind LIKE '%_slug')
),
derived_aliases AS (
  SELECT *
  FROM derived_aliases_raw a
  WHERE a.alias_text IS NOT NULL
    AND a.alias_text_norm <> ''
    AND NOT EXISTS (
      SELECT 1
      FROM blacklist_term bt
      WHERE a.alias_text_norm = bt.term
    )
),
pack_dedup AS (
  SELECT DISTINCT ON (
    p.entity_type,
    p.entity_slug,
    COALESCE(p.hero_slug, ''),
    p.alias_text_norm
  )
    p.entity_type,
    p.entity_slug,
    p.hero_slug,
    p.alias_text,
    p.alias_text_norm,
    p.source_kind,
    p.tier,
    p.is_canonical
  FROM (
    SELECT * FROM canonical
    UNION ALL
    SELECT * FROM derived_aliases
  ) p
  ORDER BY
    p.entity_type,
    p.entity_slug,
    COALESCE(p.hero_slug, ''),
    p.alias_text_norm,
    p.is_canonical DESC,
    p.source_kind,
    p.tier
)
SELECT *
FROM pack_dedup
ORDER BY
  entity_type,
  entity_slug,
  is_canonical DESC,
  tier,
  source_kind,
  alias_text;
`;

const ENTITY_META_SQL = `
WITH current_perks AS (
  SELECT
    hp.hero_slug,
    COALESCE(hpv.perk_slug, hp.perk_slug) AS perk_slug,
    hpv.tier
  FROM public.hero_perks hp
  JOIN public.hero_perk_versions hpv ON hpv.perk_key = hp.perk_key
  WHERE hp.is_active = true
    AND hpv.is_active = true
    AND hpv.valid_to_patch_id IS NULL
)
SELECT 'META'::text AS row_kind, 'HERO'::text AS meta_type, h.hero_slug::text AS slug, NULL::text AS owner_slug, h.role::text AS k1, NULL::text AS k2
FROM heroes h
WHERE h.hero_slug IS NOT NULL AND h.role IS NOT NULL
UNION ALL
SELECT 'META'::text, 'MAP'::text, m.map_slug::text, NULL::text, m.game_mode::text, m.type::text
FROM maps m
WHERE m.map_slug IS NOT NULL AND m.game_mode IS NOT NULL AND m.type IS NOT NULL
UNION ALL
SELECT 'META'::text, 'ABILITY'::text, ha.ability_slug::text, ha.hero_slug::text, ha.ability_kind::text, NULL::text
FROM hero_ability ha
WHERE ha.is_active = true
  AND ha.ability_slug IS NOT NULL
  AND ha.hero_slug IS NOT NULL
  AND ha.ability_kind IS NOT NULL
UNION ALL
SELECT 'META'::text, 'PERK'::text, cp.perk_slug::text, cp.hero_slug::text, cp.tier::text, NULL::text
FROM current_perks cp
WHERE cp.perk_slug IS NOT NULL
  AND cp.hero_slug IS NOT NULL
  AND cp.tier IS NOT NULL;
`;

async function loadDbPolicySources({ query = defaultQuery } = {}) {
  const [dictionaryResult, entityMetaResult] = await Promise.all([
    query(CANONICAL_ALIAS_SQL),
    query(ENTITY_META_SQL),
  ]);

  return {
    dictionaryRows: dictionaryResult.rows || [],
    entityMetaRows: entityMetaResult.rows || [],
  };
}

module.exports = {
  loadDbPolicySources,
};

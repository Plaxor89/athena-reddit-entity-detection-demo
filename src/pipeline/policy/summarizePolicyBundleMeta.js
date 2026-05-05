function summarizePolicyBundleMeta({
  dictionaries,
  entityMetaCounts,
  sourceCounts,
  staticMetaVersion,
  aliasCollisionRegistry,
}) {
  const grouped = dictionaries.grouped || {};
  const aliasIndexByType = dictionaries.alias_index_by_type || {};

  const aliasCollisionSummary = {};
  for (const [type, index] of Object.entries(aliasIndexByType)) {
    const keys = Object.keys(index);
    let collided = 0;
    let maxBucket = 0;
    for (const key of keys) {
      const rows = Array.isArray(index[key]) ? index[key] : [];
      const uniqueEntityRefs = new Set(rows.map((r) => `${r.entity_slug}|${r.hero_slug || ''}`));
      const size = uniqueEntityRefs.size;
      if (size > 1) collided += 1;
      if (size > maxBucket) maxBucket = size;
    }
    aliasCollisionSummary[type] = {
      alias_norm_total: keys.length,
      alias_norm_collided: collided,
      alias_norm_collided_pct: keys.length ? Math.round((collided / keys.length) * 1000) / 10 : 0,
      max_collision_bucket: maxBucket,
    };
  }

  return {
    source_counts: sourceCounts,
    category_counts: {
      HERO: (grouped.HERO || []).length,
      MAP: (grouped.MAP || []).length,
      ABILITY: (grouped.ABILITY || []).length,
      PERK: (grouped.PERK || []).length,
      RANK: (grouped.RANK || []).length,
      PLATFORM: (grouped.PLATFORM || []).length,
      QUEUE: (grouped.QUEUE || []).length,
      MODE: (grouped.MODE || []).length,
      ROLE: (grouped.ROLE || []).length,
      RANK_BRACKET: (dictionaries.rank_brackets || []).length,
    },
    entity_meta_counts: entityMetaCounts,
    alias_collision_summary: aliasCollisionSummary,
    alias_collision_registry_types: Object.keys(aliasCollisionRegistry || {}),
    static_meta_version: staticMetaVersion || null,
  };
}

module.exports = {
  summarizePolicyBundleMeta,
};

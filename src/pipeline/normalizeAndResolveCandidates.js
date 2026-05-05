// normalizeAndResolveCandidates.js
//
// One responsibility-based stage: merge exact + fuzzy candidates, normalize evidence,
// attach policy, apply tier-3 binding hints, canonical/alias directives.
// Behavior informed by historical fixtures under reference/examples/legacy/canonical-alias-resolver, not n8n source copies.

function isObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

function toStr(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

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

function stableKeyForCandidate(c) {
  return `${toStr(c.category)}||${toStr(c.canonical_slug)}||${toStr(c.dictionary_entity_type)}`;
}

function evidenceKey(ev) {
  return [
    toStr(ev.source_type),
    toStr(ev.source_id),
    String(Number.isFinite(ev.comment_rank) ? ev.comment_rank : ''),
    toStr(ev.surface_norm),
    toStr(ev.surface_raw),
  ].join('|');
}

function normalizeEvidenceFromFields({
  source_type,
  source_id,
  comment_rank,
  comment_score,
  surface_raw,
  surface_norm,
  context_snippet,
}) {
  const st = toStr(source_type).trim().toLowerCase();
  const sid = toStr(source_id);
  const cr = Number.isFinite(comment_rank) ? comment_rank : null;
  const cs = Number.isFinite(comment_score) ? comment_score : null;
  const sr = toStr(surface_raw);
  const sn = toStr(surface_norm);
  const snip = toStr(context_snippet).slice(0, 240);

  let previewReason = '';
  if (st === 'title') previewReason = 'evidence:title_match';
  else if (st === 'op') previewReason = 'evidence:op_match';
  else if (st === 'comment') {
    if (Number.isFinite(cr) && cr <= 3) previewReason = 'evidence:comment_top_rank_match';
    else if (Number.isFinite(cr) && cr <= 10) previewReason = 'evidence:comment_ranked_match';
    else previewReason = 'evidence:comment_match';
  } else if (st) previewReason = `evidence:${st}_match`;
  else previewReason = 'evidence:match';

  return {
    source_type: st,
    source_id: sid,
    comment_rank: cr,
    comment_score: cs,
    surface_raw: sr,
    surface_norm: sn,
    context_snippet: snip,
    preview_reason: previewReason,
    match_kind: '',
    match_origin: '',
    alias_hint: '',
    exact_hint: sr || sn,
  };
}

function evidenceLinesFromCandidate(c) {
  const source = toStr(c.source).trim().toLowerCase();
  const sourceId = toStr(c.source_id);
  const rank = Number.isFinite(c.source_comment_rank) ? c.source_comment_rank : null;
  const score = Number.isFinite(c.source_comment_score) ? c.source_comment_score : null;
  const raw = toStr(c.matched_text);
  const norm = toStr(c.matched_text_norm);
  const snip = toStr(c.context_snippet).slice(0, 240);

  const ev = normalizeEvidenceFromFields({
    source_type: source,
    source_id: sourceId,
    comment_rank: rank,
    comment_score: score,
    surface_raw: raw,
    surface_norm: norm,
    context_snippet: snip,
  });
  return [ev];
}

function commentRankBucket(bestRank) {
  if (!Number.isFinite(bestRank)) return 'NONE';
  if (bestRank === 1) return 'TOP_1';
  if (bestRank <= 3) return 'TOP_3';
  if (bestRank <= 10) return 'TOP_10';
  return 'OTHER';
}

function buildEvidenceSummary(evidenceList) {
  const evs = safeArray(evidenceList);
  let hasTitleOp = false;
  let hasComment = false;
  let bestRank = null;
  let bestScore = null;
  const commentIds = new Set();
  let titleCount = 0;
  let opCount = 0;
  let titleSurfaceHits = 0;
  let opSurfaceHits = 0;
  let commentSurfaceHits = 0;

  for (const ev of evs) {
    const st = toStr(ev.source_type);
    if (st === 'title') {
      hasTitleOp = true;
      titleCount += 1;
    }
    if (st === 'op') {
      hasTitleOp = true;
      opCount += 1;
    }
    if (st === 'comment') hasComment = true;

    const hasSurface = Boolean(toStr(ev.surface_norm));
    if (hasSurface) {
      if (st === 'title') titleSurfaceHits += 1;
      else if (st === 'op') opSurfaceHits += 1;
      else if (st === 'comment') commentSurfaceHits += 1;
    }

    if (st === 'comment') {
      const cid = toStr(ev.source_id);
      if (cid) commentIds.add(cid);
      if (Number.isFinite(ev.comment_rank)) {
        if (bestRank === null || ev.comment_rank < bestRank) bestRank = ev.comment_rank;
      }
      if (Number.isFinite(ev.comment_score)) {
        if (bestScore === null || ev.comment_score > bestScore) bestScore = ev.comment_score;
      }
    }
  }

  const uniqueCommentIdsN = commentIds.size;
  const independentEvidenceN = (titleCount > 0 ? 1 : 0) + (opCount > 0 ? 1 : 0) + uniqueCommentIdsN;

  return {
    ev_n: evs.length,
    has_title_op: hasTitleOp,
    has_comment: hasComment,
    comment_only: !hasTitleOp && hasComment,
    best_comment_rank: bestRank,
    best_comment_score: bestScore,
    unique_comment_ids_n: uniqueCommentIdsN,
    unique_comment_sources_n: uniqueCommentIdsN,
    independent_evidence_n: independentEvidenceN,
    comment_rank_bucket: commentRankBucket(bestRank),
    topicality_atoms: {
      title_surface_hits: titleSurfaceHits,
      op_surface_hits: opSurfaceHits,
      comment_surface_hits: commentSurfaceHits,
      title_count: titleCount,
      op_count: opCount,
      unique_comment_ids_n: uniqueCommentIdsN,
      independent_evidence_n: independentEvidenceN,
    },
  };
}

function deriveTopicalityStrong(es) {
  if (!es || es.has_title_op !== true) return false;
  const indep = Number(es.independent_evidence_n || 0);
  const atoms = isObject(es.topicality_atoms) ? es.topicality_atoms : {};
  const titleHits = Number(atoms.title_surface_hits || 0);
  const opHits = Number(atoms.op_surface_hits || 0);
  if (indep >= 2) return true;
  if (titleHits + opHits >= 1) return true;
  return false;
}

function deriveCommentExactRelevance(es, outCand) {
  if (!es) return null;
  if (es.comment_only !== true) return null;
  const bestRank = Number.isFinite(es.best_comment_rank) ? es.best_comment_rank : null;
  const indep = Number(es.independent_evidence_n || 0);
  const ecs = isObject(outCand?.evidence_summary?.exact_context_signals) ? outCand.evidence_summary.exact_context_signals : null;

  if (Number.isFinite(bestRank) && bestRank <= 2) {
    return { bucket: 'HIGH', reasons: ['comment_rel:best_rank_le2'] };
  }
  if (indep >= 2 && Number.isFinite(bestRank) && bestRank <= 3) {
    return { bucket: 'HIGH', reasons: ['comment_rel:indep_ge2_and_rank_le3'] };
  }
  if (Number.isFinite(bestRank) && bestRank <= 5) {
    return { bucket: 'MED', reasons: ['comment_rel:best_rank_le5'] };
  }
  if (indep >= 2) {
    return { bucket: 'MED', reasons: ['comment_rel:indep_ge2'] };
  }
  if (ecs?.safe_comment_candidate === true && ecs?.strong_context === true && Number.isFinite(bestRank) && bestRank <= 5) {
    return { bucket: 'HIGH', reasons: ['comment_rel:exact_context_safe_strong'] };
  }
  if (ecs?.safe_comment_candidate === true && (ecs?.light_context === true || ecs?.strong_context === true)) {
    return { bucket: 'MED', reasons: ['comment_rel:exact_context_safe_light'] };
  }
  return { bucket: 'LOW', reasons: ['comment_rel:default_low'] };
}

function normalizeTextBasic(v) {
  return toStr(v)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[_/]+/g, ' ')
    .replace(/[^a-z0-9+\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTextTight(v) {
  return normalizeTextBasic(v).replace(/[\s\-+]+/g, '');
}

function stableUniqNormalized(arr) {
  const out = [];
  const seen = new Set();
  for (const v of safeArray(arr)) {
    const s = normalizeTextBasic(v);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function extractAnchorTerms(raw) {
  const out = [];
  if (typeof raw === 'string') {
    const s = normalizeTextBasic(raw);
    if (s) out.push(s);
  } else if (Array.isArray(raw)) {
    for (const v of raw) out.push(...extractAnchorTerms(v));
  } else if (isObject(raw)) {
    for (const key of ['term', 'text', 'norm', 'surface', 'anchor', 'phrase', 'value', 'pattern', 'token']) {
      if (raw[key] !== undefined) out.push(...extractAnchorTerms(raw[key]));
    }
  }
  return stableUniqNormalized(out);
}

function extractAllStringLeaves(raw, depth = 0, cap = 128) {
  const out = [];
  if (depth > 6) return out;
  if (typeof raw === 'string') {
    const s = normalizeTextBasic(raw);
    if (s) out.push(s);
    return out;
  }
  if (Array.isArray(raw)) {
    for (const v of raw) {
      out.push(...extractAllStringLeaves(v, depth + 1, cap));
      if (out.length >= cap) break;
    }
    return stableUniqNormalized(out).slice(0, cap);
  }
  if (isObject(raw)) {
    for (const v of Object.values(raw)) {
      out.push(...extractAllStringLeaves(v, depth + 1, cap));
      if (out.length >= cap) break;
    }
  }
  return stableUniqNormalized(out).slice(0, cap);
}

function anchorGroupAliases(groupName) {
  const g = normalizeTextBasic(groupName);
  const aliases = new Set([g]);
  if (g === 'rank') {
    ['ranks', 'competitive rank', 'comp rank', 'skill tier', 'skill rating'].forEach((x) => aliases.add(normalizeTextBasic(x)));
  }
  if (g === 'platform') {
    ['platforms', 'input', 'inputs', 'crossplay', 'cross play'].forEach((x) => aliases.add(normalizeTextBasic(x)));
  }
  if (g === 'queue') {
    ['queues', 'role queue', 'open queue', 'matchmaking queue', 'matchmaking'].forEach((x) => aliases.add(normalizeTextBasic(x)));
  }
  if (g === 'mode') {
    ['modes', 'game mode', 'game modes', 'gamemode', 'gamemodes'].forEach((x) => aliases.add(normalizeTextBasic(x)));
  }
  if (g === 'role') {
    ['roles', 'class', 'classes'].forEach((x) => aliases.add(normalizeTextBasic(x)));
  }
  return [...aliases].filter(Boolean);
}

function anchorGroupMatches(candidateKey, groupAliases) {
  const keyNorm = normalizeTextBasic(candidateKey);
  if (!keyNorm) return false;
  for (const a of safeArray(groupAliases)) {
    const alias = normalizeTextBasic(a);
    if (!alias) continue;
    if (keyNorm === alias) return true;
    if (keyNorm.includes(alias) || alias.includes(keyNorm)) return true;
  }
  return false;
}

function isConceptIntentCategory(catRaw) {
  const c = toStr(catRaw).toLowerCase();
  return c === 'role' || c === 'mode' || c === 'queue' || c === 'rank' || c === 'platform';
}

function defaultConceptAnchorTerms(category) {
  const c = toStr(category).toLowerCase();
  if (c === 'rank') {
    return stableUniqNormalized(['rank', 'sr', 'elo', 'competitive', 'comp', 'placement', 'placements', 'division', 'tier', 'climb', 'climbing', 'derank']);
  }
  if (c === 'platform') {
    return stableUniqNormalized(['pc', 'console', 'xbox', 'playstation', 'ps4', 'ps5', 'switch', 'crossplay', 'controller', 'mouse keyboard', 'mnk']);
  }
  if (c === 'queue') {
    return stableUniqNormalized(['queue', 'queued', 'queuing', 'role queue', 'open queue', 'tank queue', 'support queue', 'dps queue']);
  }
  if (c === 'mode') {
    return stableUniqNormalized(['mode', 'gamemode', 'quick play', 'qp', 'competitive', 'comp', 'arcade', 'mystery heroes', 'custom game']);
  }
  if (c === 'role') {
    return stableUniqNormalized(['role', 'tank', 'support', 'dps', 'damage', 'flex', 'main support', 'off tank']);
  }
  return [];
}

function defaultConceptNegativeTerms(category) {
  const c = toStr(category).toLowerCase();
  if (c === 'rank') {
    return stableUniqNormalized([
      'gold gun', 'gold weapon', 'gold guns', 'weapon variant', 'jade weapon', 'gold variant',
    ]);
  }
  if (c === 'queue') {
    return stableUniqNormalized([
      'queue times', 'queue time', 'long queue', 'long queues', 'match queue time', 'times are long',
    ]);
  }
  if (c === 'mode') {
    return stableUniqNormalized([
      'dark mode', 'sleep mode', 'airplane mode', 'safe mode', 'photo mode',
    ]);
  }
  if (c === 'platform') {
    return stableUniqNormalized([
      'platform shoes', 'platform boot', 'platformer', 'train platform', 'oil platform',
    ]);
  }
  if (c === 'role') {
    return stableUniqNormalized([
      'job role', 'movie role', 'acting role', 'leadership role', 'support ticket', 'support email',
    ]);
  }
  return [];
}

function getAnchorTermsFromPolicy(policy, kind) {
  const p = isObject(policy) ? policy : {};
  const positiveKeys = [
    'anchor_terms', 'intent_anchor_terms', 'anchors', 'anchor_list',
    'positive_anchors', 'positive_anchor_terms',
  ];
  const negativeKeys = [
    'negative_anchors', 'negative_anchor_terms', 'negative_anchor_list',
    'neg_anchors', 'neg_anchor_terms',
  ];
  const keys = kind === 'positive' ? positiveKeys : negativeKeys;
  const out = [];
  for (const key of keys) {
    if (p[key] !== undefined) out.push(...extractAnchorTerms(p[key]));
  }
  return stableUniqNormalized(out);
}

function getAnchorTermsFromPolicyMeta(policyMeta, groupName, kind) {
  const pm = isObject(policyMeta) ? policyMeta : {};
  const group = normalizeTextBasic(groupName);
  if (!group) return [];

  const aliases = anchorGroupAliases(group);
  const out = [];
  const visited = new Set();

  const directSources = [];
  if (kind === 'positive') {
    directSources.push(pm.anchor_groups, pm.intent_anchor_groups, pm.anchorGroups);
  } else {
    directSources.push(pm.negative_anchors, pm.negative_anchor_groups, pm.negativeAnchors);
  }

  for (const src of directSources) {
    if (!isObject(src)) continue;
    for (const [k, v] of Object.entries(src)) {
      if (!anchorGroupMatches(k, aliases)) continue;
      out.push(...extractAnchorTerms(v));
      out.push(...extractAllStringLeaves(v));
    }
  }

  const nestedKeys = kind === 'positive'
    ? ['anchor_terms', 'intent_anchor_terms', 'anchors', 'positive_anchors', 'positive_anchor_terms']
    : ['negative_anchors', 'negative_anchor_terms', 'negative_anchor_list', 'neg_anchors', 'neg_anchor_terms'];

  function walk(node, depth = 0) {
    if (depth > 6 || !node) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }
    if (!isObject(node)) return;

    if (visited.has(node)) return;
    visited.add(node);

    const identityValues = [
      node.group, node.group_name, node.groupName, node.anchor_group, node.anchorGroup,
      node.category, node.entity_category, node.entityCategory, node.name, node.key,
    ].map((v) => normalizeTextBasic(v)).filter(Boolean);

    const objMatches = identityValues.some((v) => anchorGroupMatches(v, aliases));
    if (objMatches) {
      for (const key of nestedKeys) {
        if (node[key] !== undefined) out.push(...extractAnchorTerms(node[key]));
      }
      if (kind === 'negative' && node.negative_anchors === undefined && node.negative_anchor_terms === undefined) {
        out.push(...extractAnchorTerms(node.negatives));
      }
    }

    for (const [k, v] of Object.entries(node)) {
      if (anchorGroupMatches(k, aliases)) {
        out.push(...extractAnchorTerms(v));
        if (kind === 'negative') out.push(...extractAllStringLeaves(v));
      }
      walk(v, depth + 1);
    }
  }

  walk(pm, 0);
  return stableUniqNormalized(out);
}

function collectHaystackTexts(j, outCand) {
  const detect = isObject(j.detect) ? j.detect : {};
  const sources = isObject(detect.sources) ? detect.sources : {};
  const joins = isObject(detect.joins) ? detect.joins : {};

  const texts = [];
  const pushText = (v) => {
    const s = normalizeTextBasic(v);
    if (s) texts.push(s);
  };

  pushText(sources.title?.norm);
  pushText(sources.title?.raw);
  pushText(sources.op?.norm);
  pushText(sources.op?.raw);
  pushText(joins.comments_norm);
  pushText(joins.comments_raw);

  for (const ev of safeArray(outCand?.evidence)) {
    pushText(ev.surface_norm);
    pushText(ev.surface_raw);
    pushText(ev.context_snippet);
  }

  for (const s of safeArray(outCand?.alias_norms)) pushText(s);
  for (const s of safeArray(outCand?.alias_texts)) pushText(s);

  return stableUniqNormalized(texts);
}

function hayHasAny(hay, terms) {
  for (const term of safeArray(terms)) {
    const t = normalizeTextBasic(term);
    if (!t) continue;
    if (hay.some((h) => h.includes(t))) return true;
  }
  return false;
}

function countContextCueGroups(hay, groups) {
  let n = 0;
  const reasons = [];
  for (const [name, terms] of Object.entries(isObject(groups) ? groups : {})) {
    if (hayHasAny(hay, terms)) {
      n += 1;
      reasons.push(`ctx:${name}`);
    }
  }
  return { count: n, reasons };
}

function deriveExactContextSignals(j, outCand) {
  const category = toStr(outCand?.category).toLowerCase();
  const slug = normalizeTextBasic(outCand?.canonical_slug);
  const origins = new Set(safeArray(outCand?.origins).map((x) => toStr(x)));
  const es = isObject(outCand?.evidence_summary) ? outCand.evidence_summary : {};
  const hay = collectHaystackTexts(j, outCand);

  const commentOnly = es.comment_only === true;
  const hasTitleOp = es.has_title_op === true;
  const exactOnly = origins.has('exact') && !origins.has('fuzzy');
  const exactPresent = origins.has('exact');

  const out = {
    applicable: false,
    category: category || null,
    canonical_slug: slug || null,
    exact_present: exactPresent,
    exact_only: exactOnly,
    comment_only: commentOnly,
    has_title_op: hasTitleOp,
    light_context: false,
    strong_context: false,
    context_group_count: 0,
    reasons: [],
    safe_candidate: false,
    safe_comment_candidate: false,
    collision_band: null,
  };

  if (!category || !exactPresent) return out;

  const anchorHit = safeArray(outCand?.intent_evidence?.intent_anchor_hits).length > 0;
  const positiveAnchor = outCand?.intent_evidence?.intent_anchor_present === true || anchorHit;

  if (category === 'rank') {
    out.applicable = true;
    const groups = {
      rank_vocab: ['rank','ranks','ranked','competitive','comp','elo','sr','skill rating','division','tier','placement','placements','climb','derank'],
      rank_question: ['what rank','my rank','their rank','which rank','rank am i'],
      comp_mode: ['comp game','comp match','competitive match','competitive game'],
    };
    const ctx = countContextCueGroups(hay, groups);
    out.context_group_count = ctx.count;
    out.reasons.push(...ctx.reasons.slice(0, 4));

    const strict = new Set(['master','champion','gm']);
    const mid = new Set(['grandmaster']);
    const low = new Set(['bronze','silver','gold','plat','platinum','diamond']);

    if (strict.has(slug)) out.collision_band = 'STRICT';
    else if (mid.has(slug)) out.collision_band = 'MID';
    else if (low.has(slug)) out.collision_band = 'LOW';

    out.strong_context = ctx.count >= 2 || (ctx.count >= 1 && positiveAnchor);
    out.light_context = ctx.count >= 1 || positiveAnchor;
    out.safe_candidate = exactOnly && !hasTitleOp && ((out.collision_band === 'STRICT' && out.strong_context) || (out.collision_band === 'MID' && out.light_context) || (out.collision_band === 'LOW' && out.light_context));
    out.safe_comment_candidate = commentOnly && out.safe_candidate;
    return out;
  }

  if (category === 'platform') {
    out.applicable = true;
    const groups = {
      platform_vocab: ['platform','platforms','console','pc','xbox','playstation','ps4','ps5','switch','crossplay','cross play'],
      controller_settings: ['controller','aim assist','sensitivity','deadzone','dualsense','dualsense','gyro'],
      input_vocab: ['mnk','mouse keyboard','mouse and keyboard','kbm'],
    };
    const ctx = countContextCueGroups(hay, groups);
    out.context_group_count = ctx.count;
    out.reasons.push(...ctx.reasons.slice(0, 4));
    out.collision_band = slug === 'switch' ? 'STRICT' : 'NORMAL';
    out.strong_context = ctx.count >= 2 || (ctx.count >= 1 && positiveAnchor);
    out.light_context = ctx.count >= 1 || positiveAnchor;
    out.safe_candidate = exactOnly && !hasTitleOp && ((slug === 'switch' && out.strong_context) || (slug !== 'switch' && out.strong_context));
    out.safe_comment_candidate = commentOnly && out.safe_candidate;
    return out;
  }

  if (category === 'queue') {
    out.applicable = true;
    const groups = {
      queue_vocab: ['queue','queues','queued','queuing','role queue','open queue','matchmaking'],
      queue_types: ['tank queue','support queue','dps queue','damage queue'],
    };
    const ctx = countContextCueGroups(hay, groups);
    out.context_group_count = ctx.count;
    out.reasons.push(...ctx.reasons.slice(0, 4));
    out.strong_context = ctx.count >= 2 || (ctx.count >= 1 && positiveAnchor);
    out.light_context = ctx.count >= 1 || positiveAnchor;
    out.safe_candidate = exactOnly && !hasTitleOp && out.light_context;
    out.safe_comment_candidate = commentOnly && out.safe_candidate;
    return out;
  }

  if (category === 'mode' || category === 'role') {
    out.applicable = true;
    out.context_group_count = positiveAnchor ? 1 : 0;
    if (positiveAnchor) out.reasons.push('ctx:intent_anchor');
    out.light_context = positiveAnchor;
    out.strong_context = positiveAnchor && commentOnly !== true;
    out.safe_candidate = exactOnly && !hasTitleOp && positiveAnchor;
    out.safe_comment_candidate = commentOnly && out.safe_candidate && out.strong_context;
    return out;
  }

  return out;
}

function deriveIntentEvidence(j, outCand, policy, policyMeta, owContextPresent) {
  const category = toStr(outCand?.category).toLowerCase();
  const applicable =
    isConceptIntentCategory(category) ||
    Boolean(toStr(policy?.anchor_group)) ||
    policy?.requires_ow_context === true;

  if (!applicable) return null;

  const anchorGroup = toStr(policy?.anchor_group || category).trim() || category;

  const positiveAnchors = stableUniqNormalized([
    ...getAnchorTermsFromPolicyMeta(policyMeta, anchorGroup, 'positive'),
    ...getAnchorTermsFromPolicy(policy, 'positive'),
    ...defaultConceptAnchorTerms(category),
  ]);

  const negativeAnchors = stableUniqNormalized([
    ...getAnchorTermsFromPolicyMeta(policyMeta, anchorGroup, 'negative'),
    ...getAnchorTermsFromPolicy(policy, 'negative'),
    ...defaultConceptNegativeTerms(category),
  ]);

  const hay = collectHaystackTexts(j, outCand);

  const posHits = [];
  const negHits = [];

  const hasTerm = (term) => {
    const t = normalizeTextBasic(term);
    if (!t) return false;
    return hay.some((h) => h.includes(t));
  };

  const hasNegativeTerm = (term) => {
    const t = normalizeTextBasic(term);
    if (!t) return false;
    if (hay.some((h) => h.includes(t))) return true;

    const tight = normalizeTextTight(t);
    if (!tight) return false;
    return hay.some((h) => normalizeTextTight(h).includes(tight));
  };

  for (const term of positiveAnchors) if (hasTerm(term)) posHits.push(term);
  for (const term of negativeAnchors) if (hasNegativeTerm(term)) negHits.push(term);

  const requiresContext =
    policy?.requires_ow_context === true || isConceptIntentCategory(category);

  const reasons = [];
  if (owContextPresent === true) reasons.push('intent:ow_context_present');
  else if (requiresContext) reasons.push('intent:ow_context_missing');

  if (posHits.length) reasons.push(`intent:anchor_group_hit:${normalizeTextBasic(anchorGroup).replace(/\s+/g, '_')}`);
  else if (positiveAnchors.length) reasons.push('intent:anchor_group_missing');
  else reasons.push('intent:no_anchor_terms_loaded');

  if (negHits.length) {
    for (const term of negHits.slice(0, 3)) {
      reasons.push(`intent:neg_anchor_hit:${term.replace(/\s+/g, '_')}`);
    }
  }

  return {
    applicable: true,
    anchor_group: anchorGroup || null,
    requires_ow_context: requiresContext,
    requires_context: requiresContext,
    requires_intent_anchor: positiveAnchors.length > 0,
    ow_context_present: owContextPresent === true,
    anchor_terms_n: positiveAnchors.length,
    intent_anchor_present: posHits.length > 0,
    anchor_hits_n: posHits.length,
    anchor_hits: posHits.slice(0, 8),
    intent_anchor_hits: posHits.slice(0, 8),
    neg_anchor_terms_n: negativeAnchors.length,
    neg_anchor_present: negHits.length > 0,
    neg_anchor_hits_n: negHits.length,
    neg_anchor_hits: negHits.slice(0, 8),
    pass_intent_anchor: positiveAnchors.length ? posHits.length > 0 : owContextPresent === true,
    pass_negative_anchor_gate: negHits.length === 0,
    reasons,
  };
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

function deriveOwnerEvidence(outCand, policy) {
  const slugs = stableUniqStrings(safeArray(outCand.hero_slugs).map(toStr));
  const n = slugs.length;
  const es = isObject(outCand?.evidence_summary) ? outCand.evidence_summary : {};
  const hasTitleOp = es.has_title_op === true;
  const heroConflict = outCand?.hero_slug_conflict === true;
  const category = toStr(outCand?.category).toLowerCase();
  const strictOwnerScope = category === 'ability' || category === 'perk';
  const policyTier = toStr(policy?.tier).toUpperCase();
  const ownerRequiredLevel = strictOwnerScope ? (policyTier === 'TIER3' || policy?.allow_high_tier_only === true ? 'TIER3' : 'TIER2') : 'NONE';

  const sourceBuckets = {};
  let titleEvidenceN = 0;
  let opEvidenceN = 0;
  let commentEvidenceN = 0;
  for (const ev of safeArray(outCand.evidence)) {
    const st = toStr(ev.source_type || 'unknown').toLowerCase();
    if (st === 'title') titleEvidenceN += 1;
    else if (st === 'op') opEvidenceN += 1;
    else if (st === 'comment') commentEvidenceN += 1;
    sourceBuckets[st] = sourceBuckets[st] || new Set();
    for (const slug of slugs) sourceBuckets[st].add(slug);
  }

  const supportingSources = Object.entries(sourceBuckets)
    .filter(([, set]) => set.size === 1)
    .map(([sourceType]) => sourceType);

  const independentEvidenceN = Number(es.independent_evidence_n || 0);
  const secondContextReasons = [];
  if (independentEvidenceN >= 2) secondContextReasons.push('multi_independent_evidence');
  if (commentEvidenceN >= 2) secondContextReasons.push('multi_comment_evidence');
  if (hasTitleOp) secondContextReasons.push('title_or_op_context');
  if (supportingSources.includes('title')) secondContextReasons.push('owner_hero_title_support');
  if (supportingSources.includes('op')) secondContextReasons.push('owner_hero_op_support');
  if (supportingSources.includes('title') || supportingSources.includes('op')) secondContextReasons.push('owner_hero_same_source_support');
  if (strictOwnerScope) secondContextReasons.push('hero_scoped_category');
  if (policyTier === 'TIER3' || policy?.allow_high_tier_only === true) secondContextReasons.push('policy_tier3_requires_context');

  const secondContext = secondContextReasons.some((r) => (
    r !== 'owner_hero_same_source_support' &&
    r !== 'owner_hero_title_support' &&
    r !== 'owner_hero_op_support'
  ));

  const titleOpSupport = hasTitleOp || supportingSources.includes('title') || supportingSources.includes('op');
  const exactTitleOpSupport = (supportingSources.includes('title') || supportingSources.includes('op')) && hasTitleOp;
  const sameSourceUnlock = supportingSources.length > 0;
  const sameSourceExactCanonical = exactTitleOpSupport;
  const competingHeroContext = heroConflict || n > 1;
  const ownerStatus = n === 1 ? 'KNOWN' : (n > 1 ? 'CONFLICT' : 'UNKNOWN');

  const ownerHeroTitlePrimary = ownerStatus === 'KNOWN' && titleEvidenceN > 0 && !heroConflict;
  const ownerHeroOpPrimary = ownerStatus === 'KNOWN' && opEvidenceN > 0 && !heroConflict;
  const competingHeroTitlePrimary = ownerStatus === 'CONFLICT' && titleEvidenceN > 0;
  const competingHeroOpPrimary = ownerStatus === 'CONFLICT' && opEvidenceN > 0;
  const ownerHeroSameSourcePresent = ownerStatus === 'KNOWN' && sameSourceUnlock;
  const competingHeroSameSourcePresent = ownerStatus === 'CONFLICT' && sameSourceUnlock;
  const sameHeroContextUnlock = ownerStatus === 'KNOWN' && !competingHeroContext && (titleOpSupport || sameSourceUnlock || secondContext);
  const ownerSignalCount = [
    sameSourceUnlock,
    exactTitleOpSupport,
    titleOpSupport,
    secondContext,
    ownerStatus === 'KNOWN',
    ownerHeroTitlePrimary,
    ownerHeroOpPrimary,
    sameHeroContextUnlock,
  ].filter(Boolean).length;

  let ownerContextStrength = 'WEAK';
  if (ownerStatus === 'CONFLICT') ownerContextStrength = 'CONFLICT';
  else if (ownerStatus === 'KNOWN' && (sameSourceExactCanonical || (titleOpSupport && secondContext) || sameHeroContextUnlock)) ownerContextStrength = 'STRONG';
  else if (ownerStatus === 'KNOWN' && (titleOpSupport || sameSourceUnlock || secondContext)) ownerContextStrength = 'MEDIUM';
  else if (ownerStatus === 'UNKNOWN' && (titleOpSupport || secondContext)) ownerContextStrength = 'MEDIUM';

  const ownerContextReadyTier2 = ownerStatus === 'KNOWN' && (titleOpSupport || sameSourceUnlock || secondContext || sameHeroContextUnlock);
  const ownerContextReadyTier3 = ownerStatus === 'KNOWN' && (sameSourceExactCanonical || secondContext || (titleOpSupport && ownerContextStrength === 'STRONG') || sameHeroContextUnlock);

  const base = {
    owner_status: ownerStatus,
    owner_required_level: ownerRequiredLevel,
    owner_signal_count: ownerSignalCount,
    owner_context_ready_tier2: ownerContextReadyTier2,
    owner_context_ready_tier3: ownerContextReadyTier3,
    owner_hero_unique_n: n,
    owner_hero_slugs: n > 1 ? slugs.slice(0, 6) : slugs,
    owner_same_source_unlock: sameSourceUnlock,
    owner_same_source_types: supportingSources.slice(0, 4),
    owner_same_source_exact_canonical: sameSourceExactCanonical,
    owner_title_op_support: titleOpSupport,
    owner_exact_title_op_support: exactTitleOpSupport,
    owner_competing_hero_context: competingHeroContext,
    owner_context_strength: ownerContextStrength,
    owner_second_context: secondContext,
    owner_second_context_present: secondContext,
    owner_second_context_reasons: stableUniqStrings(secondContextReasons).slice(0, 8),
    same_hero_context_unlock: sameHeroContextUnlock,
    owner_hero_title_primary: ownerHeroTitlePrimary,
    owner_hero_op_primary: ownerHeroOpPrimary,
    owner_hero_same_source_present: ownerHeroSameSourcePresent,
    owner_hero_same_source_exact_canonical: sameSourceExactCanonical,
    owner_hero_metadata_unique_owner: false,
    competing_hero_title_primary: competingHeroTitlePrimary,
    competing_hero_op_primary: competingHeroOpPrimary,
    competing_hero_same_source_present: competingHeroSameSourcePresent,
    competing_hero_same_source_slugs: ownerStatus === 'CONFLICT' ? slugs.slice(0, 6) : [],
    owner_reasons: [],
  };

  if (ownerStatus === 'KNOWN') {
    const reasons = ['owner:unique_from_hero_slugs'];
    if (sameSourceUnlock) reasons.push('owner:same_source_unlock');
    if (sameSourceExactCanonical) reasons.push('owner:same_source_exact_canonical');
    if (secondContext) reasons.push('owner:second_context_present');
    if (sameHeroContextUnlock) reasons.push('owner:same_hero_context_unlock');
    if (ownerHeroTitlePrimary) reasons.push('owner:hero_title_primary');
    if (ownerHeroOpPrimary) reasons.push('owner:hero_op_primary');
    if (titleOpSupport) reasons.push('owner:title_op_support');
    if (ownerContextReadyTier2) reasons.push('owner:ready_tier2');
    if (ownerContextReadyTier3) reasons.push('owner:ready_tier3');
    base.owner_reasons = reasons;
    return base;
  }
  if (ownerStatus === 'CONFLICT') {
    base.owner_reasons = stableUniqStrings([
      'owner:conflict_multiple_hero_slugs',
      competingHeroTitlePrimary ? 'owner:competing_hero_title_primary' : null,
      competingHeroOpPrimary ? 'owner:competing_hero_op_primary' : null,
      secondContext ? 'owner:second_context_present' : null,
    ]);
    return base;
  }
  base.owner_reasons = stableUniqStrings(secondContext
    ? ['owner:missing_hero_slugs', 'owner:second_context_present']
    : ['owner:missing_hero_slugs']);
  return base;
}

function deriveProtectedContext(outCand, intentEvidence, ownerEvidence) {
  const es = isObject(outCand?.evidence_summary) ? outCand.evidence_summary : {};
  const origins = safeArray(outCand?.origins).map((x) => toStr(x));
  const hasExact = origins.includes('exact');
  const hasFuzzy = origins.includes('fuzzy');
  const hasTitleOp = es.has_title_op === true;
  const independentN = Number(es.independent_evidence_n || 0);
  const commentOnly = es.comment_only === true;
  const category = toStr(outCand?.category).toLowerCase();
  const strictOwnerScope = category === 'ability' || category === 'perk';
  const ownerStatus = toStr(ownerEvidence?.owner_status).toUpperCase();
  const ownerUnlock = ownerEvidence?.owner_same_source_unlock === true || ownerEvidence?.owner_second_context === true;
  const ownerTitleOpSupport = ownerEvidence?.owner_title_op_support === true;
  const ownerExactTitleOpSupport = ownerEvidence?.owner_exact_title_op_support === true;
  const ownerStrength = toStr(ownerEvidence?.owner_context_strength).toUpperCase();
  const ownerCompeting = ownerEvidence?.owner_competing_hero_context === true;
  const positiveAnchor =
    intentEvidence?.intent_anchor_present === true || safeArray(intentEvidence?.intent_anchor_hits).length > 0;
  const owContext = intentEvidence?.ow_context_present === true || intentEvidence?.requires_ow_context !== true;

  const protectedExactContext = hasExact && (hasTitleOp || ownerExactTitleOpSupport);
  const protectedTitleOpContext =
    hasTitleOp &&
    (positiveAnchor ||
      independentN >= 1 ||
      ownerTitleOpSupport ||
      ownerExactTitleOpSupport ||
      ownerStrength === 'MEDIUM' ||
      ownerStrength === 'STRONG');
  const protectedCommentContext =
    commentOnly &&
    independentN >= 2 &&
    (intentEvidence?.pass_negative_anchor_gate !== false) &&
    (positiveAnchor || ownerUnlock || ownerStrength === 'MEDIUM' || ownerStrength === 'STRONG');

  const protectedOwContext = owContext && (positiveAnchor || hasTitleOp || ownerUnlock || ownerStrength === 'STRONG');
  const protectedPrimary =
    protectedExactContext ||
    (hasTitleOp && owContext && (positiveAnchor || ownerExactTitleOpSupport || ownerStrength === 'STRONG')) ||
    (strictOwnerScope && ownerStatus === 'KNOWN' && (ownerExactTitleOpSupport || ownerUnlock || ownerStrength === 'STRONG'));

  const passProtectedContext =
    protectedExactContext ||
    protectedTitleOpContext ||
    protectedCommentContext ||
    protectedOwContext ||
    protectedPrimary ||
    (strictOwnerScope && ownerStatus === 'KNOWN' && (ownerUnlock || ownerTitleOpSupport || ownerStrength === 'STRONG'));

  return {
    strict_owner_scope: strictOwnerScope,
    has_exact_origin: hasExact,
    has_fuzzy_origin: hasFuzzy,
    has_title_op: hasTitleOp,
    comment_only: commentOnly,
    independent_evidence_n: independentN,
    owner_status: ownerStatus || null,
    owner_context_strength: ownerStrength || null,
    owner_title_op_support: ownerTitleOpSupport,
    owner_exact_title_op_support: ownerExactTitleOpSupport,
    owner_competing_hero_context: ownerCompeting,
    protected_exact_context: protectedExactContext,
    protected_title_op_context: protectedTitleOpContext,
    protected_comment_context: protectedCommentContext,
    protected_primary: protectedPrimary,
    protected_ow_context: protectedOwContext,
    protected_context: passProtectedContext,
    is_protected: passProtectedContext,
    pass_protected_context: passProtectedContext,
  };
}

function normalizeTierPolicy(x) {
  const s = toStr(x).toUpperCase();
  return s || null;
}

function pickPolicyFromRow(row) {
  const r = isObject(row) ? row : {};
  const out = {};
  out.tier = normalizeTierPolicy(r.tier || r.alias_tier || r.dictionary_tier || r.row_tier || null);
  const boolFields = [
    'comment_only_requires_corroboration',
    'prefer_canonical_over_alias',
    'allow_high_tier_only',
    'short_alias',
    'requires_ow_context',
  ];
  for (const f of boolFields) {
    if (r[f] === true || r[f] === false) out[f] = r[f];
  }
  const pr = toStr(r.promotion_risk || r.promotionRisk || '');
  if (pr) out.promotion_risk = pr.toUpperCase();
  const ag = toStr(r.anchor_group || r.anchorGroup || '');
  if (ag) out.anchor_group = ag;
  return out;
}

function lookupPolicy(dictRows, dictionaryEntityType, canonicalSlug, aliasNorms) {
  const et = toStr(dictionaryEntityType);
  const slug = toStr(canonicalSlug);
  const aliasSet = new Set(safeArray(aliasNorms).map(toStr).filter(Boolean));

  let canonicalRow = null;
  let aliasRow = null;

  for (const row of safeArray(dictRows)) {
    if (!isObject(row)) continue;
    const rowEt = toStr(row.entity_type || row.entityType || row.dictionary_entity_type || row.dictionaryEntityType);
    const rowSlug = toStr(row.entity_slug || row.entitySlug || row.canonical_slug || row.canonicalSlug);
    if (rowEt && et && rowEt !== et) continue;
    if (rowSlug && slug && rowSlug === slug) {
      canonicalRow = row;
      break;
    }
  }

  if (!canonicalRow && aliasSet.size) {
    for (const row of safeArray(dictRows)) {
      if (!isObject(row)) continue;
      const rowEt = toStr(row.entity_type || row.entityType || row.dictionary_entity_type || row.dictionaryEntityType);
      if (rowEt && et && rowEt !== et) continue;
      const aliasNorm = toStr(row.alias_text_norm || row.alias_norm || row.aliasTextNorm);
      if (aliasNorm && aliasSet.has(aliasNorm)) {
        aliasRow = row;
        break;
      }
    }
  }

  const chosen = canonicalRow || aliasRow;
  if (!chosen) return null;
  const policy = pickPolicyFromRow(chosen);
  policy._policy_source = canonicalRow ? 'policy_from_canonical_row' : 'policy_from_alias_row';
  return policy;
}

function computeOwContextPresent(j) {
  const detect = isObject(j.detect) ? j.detect : {};
  const sources = isObject(detect.sources) ? detect.sources : {};
  const titleNorm = toStr(sources.title?.norm);
  const opNorm = toStr(sources.op?.norm);
  const joins = isObject(detect.joins) ? detect.joins : {};
  const commentsNorm = toStr(joins.comments_norm);
  const hay = `${titleNorm} ${opNorm} ${commentsNorm}`.trim();
  if (!hay) return false;
  const cues = [
    /\boverwatch\b/,
    /\bow\b/,
    /\bblizzard\b/,
    /\bhero\b/,
    /\bqueue\b/,
    /\bquick play\b/,
    /\brole queue\b/,
    /\bopen queue\b/,
    /\branked\b/,
    /\bcomp\b/,
  ];
  return cues.some((re) => re.test(hay));
}

function normalizeLaneName(x) {
  const s = toStr(x).trim().toUpperCase();
  if (!s) return null;
  if (s === 'HARD' || s === 'HIGH' || s === 'SOFT' || s === 'SHADOW') return s;
  return null;
}

const LANE_ORDER = { SHADOW: 0, SOFT: 1, HIGH: 2, HARD: 3 };
const LANE_INV = ['SHADOW', 'SOFT', 'HIGH', 'HARD'];

function minLane(a, b) {
  const aa = normalizeLaneName(a);
  const bb = normalizeLaneName(b);
  if (!aa) return bb;
  if (!bb) return aa;
  return LANE_INV[Math.min(LANE_ORDER[aa], LANE_ORDER[bb])];
}

function extractFuzzyMeta(raw) {
  const c = isObject(raw) ? raw : {};
  const sim =
    (Number.isFinite(c.fuzzy_sim) ? c.fuzzy_sim : null) ??
    (Number.isFinite(c.fuzzy_score) ? c.fuzzy_score : null) ??
    (Number.isFinite(c.similarity) ? c.similarity : null);
  const method = toStr(c.fuzzy_method || c.match_method || '');
  const out = {};
  if (sim !== null) out.sim = sim;
  if (method) out.method = method;
  const algo = toStr(c.algo || c.algorithm || '');
  if (algo) out.algo = algo;
  if (c.hero_typo_carve_out_emit === true) out.hero_typo_carve_out_emit = true;
  return Object.keys(out).length ? out : null;
}

function extractPackMeta(raw) {
  const c = isObject(raw) ? raw : {};
  const maxLane =
    normalizeLaneName(c.max_lane) ||
    normalizeLaneName(c.maxLane) ||
    normalizeLaneName(c.pack_max_lane) ||
    null;
  const packGate = toStr(c.pack_gate || c.packGate || c.gate || '').trim() || null;
  const allowCodes = safeArray(c.pack_allow_reason_codes).length
    ? safeArray(c.pack_allow_reason_codes)
    : safeArray(c.packAllowReasonCodes);
  const pack_allow_reason_codes = stableUniqStrings(allowCodes.map(toStr));
  const nf = isObject(c.evidence?.noise_flags) ? c.evidence.noise_flags : isObject(c.noise_flags) ? c.noise_flags : {};
  const pack_risky_alias_escaped = c.pack_risky_alias_escaped === true || nf.pack_risky_alias_escaped === true;
  const pack_risky_alias_escape_rule = toStr(c.pack_risky_alias_escape_rule || nf.pack_risky_alias_escape_rule || '').trim() || null;
  const out = {
    max_lane: maxLane,
    pack_gate: packGate,
    pack_allow_reason_codes,
    pack_risky_alias_escaped: Boolean(pack_risky_alias_escaped),
    pack_risky_alias_escape_rule,
  };
  const hasAny =
    out.max_lane !== null ||
    out.pack_gate !== null ||
    out.pack_allow_reason_codes.length > 0 ||
    out.pack_risky_alias_escaped === true ||
    out.pack_risky_alias_escape_rule !== null;
  return hasAny ? out : null;
}

function normalizeRawCandidate(c, origin) {
  const category = toStr(c.category);
  const canonical_slug = toStr(c.canonical_slug || c.entity_slug);
  const dictionary_entity_type = toStr(c.dictionary_entity_type || c.entity_type);
  const hero_slug = toStr(c.hero_slug || c.heroSlug) || null;
  const alias_text = toStr(c.alias_text || c.alias) || null;
  const alias_norm = toStr(c.alias_text_norm || c.alias_norm) || null;
  const promotion_risk = toStr(c.promotion_risk) || null;
  const evs = evidenceLinesFromCandidate(c);
  const fuzzy_meta = origin === 'fuzzy' ? extractFuzzyMeta(c) : null;
  const pack_meta = extractPackMeta(c);
  const policy = isObject(c.policy) ? c.policy : null;
  return {
    category,
    canonical_slug,
    dictionary_entity_type,
    hero_slug,
    alias_text,
    alias_norm,
    promotion_risk,
    origin,
    fuzzy_meta,
    pack_meta,
    evidence: evs,
    candidate_id: toStr(c.fuzzy_candidate_id || c.candidate_id || '') || null,
    policy,
  };
}

function mergeHeroSlugs(into, addSlug) {
  const slugs = stableUniqStrings([...(into.hero_slugs || []), toStr(addSlug)].filter(Boolean));
  into.hero_slugs = slugs;
  if (slugs.length === 1) {
    into.hero_slug = slugs[0];
    into.hero_slug_conflict = false;
  } else if (slugs.length > 1) {
    into.hero_slug = null;
    into.hero_slug_conflict = true;
  }
}

function mergeIntoBucket(bucket, add) {
  mergeHeroSlugs(bucket, add.hero_slug);
  bucket.origins = stableUniqStrings([...(bucket.origins || []), add.origin]);
  if (add.alias_text) bucket.alias_texts = stableUniqStrings([...(bucket.alias_texts || []), add.alias_text]);
  if (add.alias_norm) bucket.alias_norms = stableUniqStrings([...(bucket.alias_norms || []), add.alias_norm]);
  if (add.promotion_risk && !bucket.promotion_risk) bucket.promotion_risk = add.promotion_risk;
  if (isObject(add.policy) && !bucket.policy) bucket.policy = add.policy;

  if (isObject(add.pack_meta)) {
    bucket.pack_meta = bucket.pack_meta || {
      max_lane: null,
      pack_gate: null,
      pack_allow_reason_codes: [],
      pack_risky_alias_escaped: false,
      pack_risky_alias_escape_rule: null,
    };
    const order = { SHADOW: 0, SOFT: 1, HIGH: 2, HARD: 3 };
    const cur = normalizeLaneName(bucket.pack_meta.max_lane);
    const nxt = normalizeLaneName(add.pack_meta.max_lane);
    if (cur === null) bucket.pack_meta.max_lane = nxt;
    else if (nxt !== null && order[nxt] < order[cur]) bucket.pack_meta.max_lane = nxt;
    if (!bucket.pack_meta.pack_gate && add.pack_meta.pack_gate) bucket.pack_meta.pack_gate = add.pack_meta.pack_gate;
    bucket.pack_meta.pack_allow_reason_codes = stableUniqStrings([
      ...(bucket.pack_meta.pack_allow_reason_codes || []),
      ...(add.pack_meta.pack_allow_reason_codes || []),
    ]);
    if (add.pack_meta.pack_risky_alias_escaped === true) bucket.pack_meta.pack_risky_alias_escaped = true;
    if (!bucket.pack_meta.pack_risky_alias_escape_rule && add.pack_meta.pack_risky_alias_escape_rule) {
      bucket.pack_meta.pack_risky_alias_escape_rule = add.pack_meta.pack_risky_alias_escape_rule;
    }
  }

  if (isObject(add.fuzzy_meta)) {
    bucket.fuzzy_meta = bucket.fuzzy_meta || {};
    const curSim = Number.isFinite(bucket.fuzzy_meta.sim) ? bucket.fuzzy_meta.sim : null;
    const addSim = Number.isFinite(add.fuzzy_meta.sim) ? add.fuzzy_meta.sim : null;
    if (curSim === null && addSim !== null) bucket.fuzzy_meta.sim = addSim;
    if (!bucket.fuzzy_meta.method && add.fuzzy_meta.method) bucket.fuzzy_meta.method = add.fuzzy_meta.method;
    if (!bucket.fuzzy_meta.algo && add.fuzzy_meta.algo) bucket.fuzzy_meta.algo = add.fuzzy_meta.algo;
    if (add.fuzzy_meta.hero_typo_carve_out_emit === true) bucket.fuzzy_meta.hero_typo_carve_out_emit = true;
  }

  const seen = bucket._seenEvidenceKeys || new Set();
  for (const ev of safeArray(add.evidence)) {
    const k = evidenceKey(ev);
    if (seen.has(k)) continue;
    seen.add(k);
    bucket.evidence.push(ev);
  }
  bucket._seenEvidenceKeys = seen;

  if (add.candidate_id) {
    bucket.candidate_ids = stableUniqStrings([...(bucket.candidate_ids || []), add.candidate_id]);
  }
}

function stableSortEvidence(evs) {
  return safeArray(evs).slice().sort((a, b) => {
    const as = toStr(a.source_type);
    const bs = toStr(b.source_type);
    if (as !== bs) return as < bs ? -1 : 1;
    const ac = toStr(a.source_id);
    const bc = toStr(b.source_id);
    if (ac !== bc) return ac < bc ? -1 : 1;
    const ar = Number.isFinite(a.comment_rank) ? a.comment_rank : 9999;
    const br = Number.isFinite(b.comment_rank) ? b.comment_rank : 9999;
    if (ar !== br) return ar - br;
    const an = toStr(a.surface_norm);
    const bn = toStr(b.surface_norm);
    if (an !== bn) return an < bn ? -1 : 1;
    return 0;
  });
}

function evidenceSourcePriority(st) {
  const s = toStr(st).trim().toLowerCase();
  if (s === 'title') return 0;
  if (s === 'op') return 1;
  if (s === 'comment') return 2;
  return 3;
}

function sortEvidencePreviewItems(arr) {
  return safeArray(arr).slice().sort((a, b) => {
    const pa = evidenceSourcePriority(a?.source_type);
    const pb = evidenceSourcePriority(b?.source_type);
    if (pa !== pb) return pa - pb;
    const ar = Number.isFinite(a?.comment_rank) ? a.comment_rank : 9999;
    const br = Number.isFinite(b?.comment_rank) ? b.comment_rank : 9999;
    if (ar !== br) return ar - br;
    const as = Number.isFinite(a?.comment_score) ? -a.comment_score : 999999;
    const bs = Number.isFinite(b?.comment_score) ? -b.comment_score : 999999;
    if (as !== bs) return as - bs;
    const am = toStr(a?.matched_text_norm || a?.matched_text);
    const bm = toStr(b?.matched_text_norm || b?.matched_text);
    if (am !== bm) return am < bm ? -1 : 1;
    return 0;
  });
}

function evidencePreviewQuality(pv) {
  const p = isObject(pv) ? pv : {};
  let q = 0;
  if (toStr(p.matched_text).trim()) q += 4;
  if (toStr(p.matched_text_norm).trim()) q += 2;
  if (toStr(p.context_snippet).trim()) q += 3;
  if (toStr(p.reason).trim()) q += 1;
  if (toStr(p.source_type).trim()) q += 1;
  if (Number.isFinite(p.comment_rank)) q += 1;
  return q;
}

function buildEvidencePreviewItems(evidenceList, maxItems = 5) {
  const pool = [];
  for (const ev of safeArray(evidenceList)) {
    const matchedText = toStr(ev.surface_raw || ev.surface_norm).trim();
    const matchedTextNorm = toStr(ev.surface_norm).trim();
    pool.push({
      source_type: toStr(ev.source_type) || '',
      source_id: toStr(ev.source_id) || '',
      comment_rank: Number.isFinite(ev.comment_rank) ? ev.comment_rank : null,
      comment_score: Number.isFinite(ev.comment_score) ? ev.comment_score : null,
      matched_text: matchedText || '',
      matched_text_norm: matchedTextNorm || '',
      context_snippet: toStr(ev.context_snippet).trim(),
      reason: toStr(ev.preview_reason) || '',
    });
  }
  const bySource = sortEvidencePreviewItems(pool);
  const byQuality = bySource.slice().sort((a, b) => evidencePreviewQuality(b) - evidencePreviewQuality(a));
  let titleTaken = 0;
  let opTaken = 0;
  let commentTaken = 0;
  let otherTaken = 0;
  const out = [];
  for (const pv of byQuality) {
    const st = toStr(pv.source_type).trim().toLowerCase();
    if (st === 'title' && titleTaken >= 1) continue;
    if (st === 'op' && opTaken >= 1) continue;
    if (st === 'comment' && commentTaken >= 3) continue;
    if (st !== 'title' && st !== 'op' && st !== 'comment' && otherTaken >= 1) continue;
    out.push(pv);
    if (st === 'title') titleTaken += 1;
    else if (st === 'op') opTaken += 1;
    else if (st === 'comment') commentTaken += 1;
    else otherTaken += 1;
    if (out.length >= maxItems) break;
  }
  return out;
}

function countAnswerSlotScalars(detect) {
  const sources = isObject(detect?.sources) ? detect.sources : {};
  const comments = safeArray(sources.comments);
  let t1 = 0;
  let t2 = 0;
  let t3 = 0;
  let t3WithPairMatch = 0;
  let contradiction = 0;
  const samples = { TIER1: [], TIER2: [], TIER3: [], TIER3_PAIRS_ONLY: [] };
  for (const c of comments) {
    if (!isObject(c) || c.is_bot) continue;
    const tier = toStr(c.answer_tier);
    if (tier === 'TIER1') {
      t1 += 1;
      samples.TIER1.push(toStr(c.id));
    } else if (tier === 'TIER2') {
      t2 += 1;
      samples.TIER2.push(toStr(c.id));
    } else if (tier === 'TIER3') {
      t3 += 1;
      samples.TIER3.push(toStr(c.id));
      if (c.contradiction && toStr(c.contradiction.pattern) !== 'TIER3_GENERIC') {
        contradiction += 1;
        t3WithPairMatch += 1;
        samples.TIER3_PAIRS_ONLY.push(toStr(c.id));
      }
    }
  }
  const strongSupport = t1 > 0 || (t3 > 0 && t3WithPairMatch > 0);
  return {
    answer_slot_tier1_comment_count: t1,
    answer_slot_tier2_comment_count: t2,
    answer_slot_tier3_comment_count: t3,
    answer_slot_contradiction_count: contradiction,
    answer_slot_strong_support: strongSupport,
    answer_slot_comment_id_samples: samples,
  };
}

function safeRegexFromMaybeString(reMaybe, flags = 'i') {
  if (reMaybe instanceof RegExp) return reMaybe;
  const s = toStr(reMaybe).trim();
  if (!s) return null;
  try {
    return new RegExp(s, flags);
  } catch {
    return null;
  }
}

/**
 * Enrich detect.sources.comments with answer-slot signals using policyBundle.policyMeta.answer_slot_patterns.
 * Mutates detect in place. n8n semantics: only patch when comment.answer_tier is null/empty.
 * Enriches: answer_tier, answer_flags, is_answer_like, contradiction.
 */
function applyCommentSignals(detect, policyBundle) {
  const asp = isObject(policyBundle?.policyMeta?.answer_slot_patterns)
    ? policyBundle.policyMeta.answer_slot_patterns
    : null;
  if (!asp) return;

  function compilePatternList(list, flags = 'i') {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const p of list) {
      try {
        if (typeof p === 'string' && p.trim()) out.push(new RegExp(p, flags));
      } catch (_) {}
    }
    return out;
  }
  function compilePairPatterns(list, flags = 'i') {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const obj of list) {
      try {
        const label = toStr(obj?.label).trim();
        const reStr = (toStr(obj?.re) || toStr(obj?.pattern) || toStr(obj?.regex)).trim();
        if (!label || !reStr) continue;
        out.push({ label, re: new RegExp(reStr, flags) });
      } catch (_) {}
    }
    return out;
  }
  const lib = {
    tier1: compilePatternList(asp.tier1),
    tier2: compilePatternList(asp.tier2),
    tier3: compilePatternList(asp.tier3),
    tier3Pairs: compilePairPatterns(asp.tier3_pairs),
  };

  function detectAnswerTier(raw, norm) {
    const hay = `${toStr(norm)} || ${toStr(raw)}`;
    const flags = [];
    const hasT1 = (lib.tier1 || []).some((re) => re.test(hay));
    const hasT2 = (lib.tier2 || []).some((re) => re.test(hay));
    const hasT3 = (lib.tier3 || []).some((re) => re.test(hay));
    if (hasT1) flags.push('TIER1_MARKER');
    if (hasT2) flags.push('TIER2_HEDGE');
    if (hasT3) flags.push('TIER3_CORRECTION');
    let tier = null;
    if (hasT3) tier = 'TIER3';
    else if (hasT1) tier = 'TIER1';
    else if (hasT2) tier = 'TIER2';
    let contradiction = null;
    if (tier === 'TIER3') {
      for (const { label, re } of (lib.tier3Pairs || [])) {
        const m = toStr(norm).match(re);
        if (m) {
          contradiction = { pattern: label, excerpt: toStr(raw).slice(0, 180) };
          break;
        }
      }
    }
    const is_answer_like = tier === 'TIER1' || tier === 'TIER3';
    return { tier, flags, is_answer_like, contradiction };
  }

  const sources = isObject(detect?.sources) ? detect.sources : {};
  const comments = safeArray(sources.comments);
  if (!comments.length) return;

  for (const c of comments) {
    if (!c || c.is_bot) continue;
    const upstreamTier = toStr(c.answer_tier).trim() || null;
    if (upstreamTier) continue;

    const raw = toStr(c.raw || c.body);
    const norm = toStr(c.norm);
    const answer = detectAnswerTier(raw, norm);
    c.answer_tier = answer.tier;
    c.answer_flags = answer.flags;
    c.is_answer_like = Boolean(answer.is_answer_like);
    if (answer.contradiction) c.contradiction = answer.contradiction;
  }
}

function compileTier3Pairs(policyBundle) {
  const asp = isObject(policyBundle?.policyMeta?.answer_slot_patterns)
    ? policyBundle.policyMeta.answer_slot_patterns
    : null;
  const pairs = safeArray(asp?.tier3_pairs);
  const diag = { loaded_n: 0, invalid_n: 0, invalid_samples: [] };
  const out = [];
  for (const p of pairs) {
    const label = toStr(p?.label).trim();
    const reStr = toStr(p?.re || p?.pattern || p?.regex || '').trim();
    if (!label || !reStr) continue;
    const re = safeRegexFromMaybeString(reStr);
    if (!re) {
      diag.invalid_n += 1;
      if (diag.invalid_samples.length < 12) diag.invalid_samples.push({ label: label.slice(0, 80), pattern: reStr.slice(0, 220) });
      continue;
    }
    diag.loaded_n += 1;
    out.push({ label, re });
  }
  return { pairs: out, diag };
}

function normToken(s) {
  let t = toStr(s).toLowerCase();
  t = t.normalize('NFKC');
  t = t.replace(/https?:\/\/\S+/g, ' ');
  t = t.replace(/[^a-z0-9\s]/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function compressToken(s) {
  return normToken(s).replace(/\s+/g, '');
}

function buildCandidateIndex(candidates) {
  const aliasToHits = new Map();
  const aliasToHitsCompressed = new Map();
  const slugToHit = new Map();
  const slugToHitCompressed = new Map();

  for (const c of safeArray(candidates)) {
    if (!isObject(c)) continue;
    const key = stableKeyForCandidate(c);
    const cat = toStr(c.category);
    const dt = toStr(c.dictionary_entity_type);
    const slug = normToken(c.canonical_slug);
    if (slug) slugToHit.set(slug, { key, category: cat, dictionary_entity_type: dt, via: 'slug' });
    const slugC = compressToken(c.canonical_slug);
    if (slugC) slugToHitCompressed.set(slugC, { key, category: cat, dictionary_entity_type: dt, via: 'slug_compressed' });

    for (const a0 of safeArray(c.alias_norms)) {
      const a = normToken(a0);
      if (a) {
        const arr = aliasToHits.get(a) || [];
        arr.push({ key, category: cat, dictionary_entity_type: dt, via: 'alias' });
        aliasToHits.set(a, arr);
      }
      const ac = compressToken(a0);
      if (ac) {
        const arr2 = aliasToHitsCompressed.get(ac) || [];
        arr2.push({ key, category: cat, dictionary_entity_type: dt, via: 'alias_compressed' });
        aliasToHitsCompressed.set(ac, arr2);
      }
    }
  }
  return { aliasToHits, aliasToHitsCompressed, slugToHit, slugToHitCompressed };
}

function uniqueHitFromList(hits) {
  const uniqKeys = [...new Set(safeArray(hits).map((h) => h.key))];
  if (uniqKeys.length !== 1) return null;
  const k = uniqKeys[0];
  return safeArray(hits).find((h) => h.key === k) || null;
}

function matchTokenToCandidate(tokenNorm, index) {
  if (!tokenNorm) return null;
  const slugHit = index.slugToHit.get(tokenNorm);
  if (slugHit) return slugHit;
  const hits = index.aliasToHits.get(tokenNorm) || [];
  const uniq = uniqueHitFromList(hits);
  if (uniq) return uniq;
  const tc = compressToken(tokenNorm);
  if (!tc) return null;
  const slugHitC = index.slugToHitCompressed.get(tc);
  if (slugHitC) return slugHitC;
  const hitsC = index.aliasToHitsCompressed.get(tc) || [];
  return uniqueHitFromList(hitsC);
}

const TIER3_STOP_TOKENS = new Set([
  'it', 'its', "it's", 'this', 'that', 'these', 'those', 'one', 'ones', 'thing', 'things',
  'he', 'she', 'they', 'them', 'we', 'you', 'i', 'me', 'my', 'your', 'our',
  'yes', 'no', 'nah', 'yep', 'nope', 'also', 'just', 'like',
]);

function tier3TokenIsBad(t) {
  const s = normToken(t);
  if (!s) return true;
  if (s.length < 2) return true;
  if (TIER3_STOP_TOKENS.has(s)) return true;
  return false;
}

function parseTier3PairFromText(raw) {
  const t = toStr(raw);
  if (!t) return null;
  const patterns = [
    /not\s+([a-z0-9][a-z0-9\s]{0,40}?)\s+(?:it'?s|its|but)\s+([a-z0-9][a-z0-9\s]{0,40}?)(?:[\.\!\?,]|$)/i,
    /(?:isn'?t|is not)\s+([a-z0-9][a-z0-9\s]{0,40}?)\s+(?:it'?s|its)\s+([a-z0-9][a-z0-9\s]{0,40}?)(?:[\.\!\?,]|$)/i,
    /no,\s*([a-z0-9][a-z0-9\s]{0,40}?)\s*-\s*([a-z0-9][a-z0-9\s]{0,40}?)(?:[\.\!\?,]|$)/i,
    /you mean\s+([a-z0-9][a-z0-9\s]{0,40}?)\s*(?:,|;|:)?\s*(?:not|no)\s+([a-z0-9][a-z0-9\s]{0,40}?)(?:[\.\!\?,]|$)/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    const a = normToken(m[1]);
    const b = normToken(m[2]);
    if (!a || !b || a === b) continue;
    if (tier3TokenIsBad(a) || tier3TokenIsBad(b)) continue;
    return { x: a, y: b, pattern: String(re), method: 'heuristic' };
  }
  return null;
}

function tier3PackGateIsHardBlock(gate) {
  const g = toStr(gate).trim().toLowerCase();
  if (!g) return false;
  return g.includes('deny') || g.includes('block') || g.includes('reject');
}

function tier3CandidateHardBlocked(cand) {
  const pm = isObject(cand?.pack_meta) ? cand.pack_meta : null;
  if (pm?.pack_gate && tier3PackGateIsHardBlock(pm.pack_gate)) return true;
  return false;
}

function tier3TypesCompatible(xHit, yHit) {
  if (!xHit || !yHit) return false;
  if (toStr(xHit.category) !== toStr(yHit.category)) return false;
  if (toStr(xHit.dictionary_entity_type) !== toStr(yHit.dictionary_entity_type)) return false;
  return true;
}

function tier3MatchTokenToCandidate(tokenNorm, index) {
  if (!tokenNorm || tier3TokenIsBad(tokenNorm)) return null;
  return matchTokenToCandidate(tokenNorm, index);
}

function pushBoundedTier3(arr, obj, cap = 16) {
  if (arr.length < cap) arr.push(obj);
}

function runTier3BindingNoOp(contradictionCount, pairDiag) {
  return {
    tier3_binding_suppress_keys: [],
    tier3_binding_boost_keys: [],
    tier3_binding_counts: {
      tier3_comments_n: 0,
      parsed_pairs_n: 0,
      capture_pairs_n: 0,
      heuristic_pairs_n: 0,
      matched_pairs_n: 0,
      suppress_n: 0,
      boost_n: 0,
      unmatched_pairs_n: 0,
      rejected_common_word_n: 0,
      rejected_non_unique_token_n: 0,
      rejected_cross_type_n: 0,
      rejected_bad_token_n: 0,
      rejected_pack_gate_hard_block_n: 0,
      tier3_pairs_loaded_n: pairDiag.loaded_n,
      tier3_pairs_invalid_n: pairDiag.invalid_n,
      contradiction_count: contradictionCount,
      no_op: true,
    },
    tier3_binding_samples: [],
    tier3_pairs_compile_diag: pairDiag,
  };
}

function runTier3BindingFull(j, candidatesNorm, policyBundle, pairDiag, contradictionCount) {
  const detect = isObject(j?.detect) ? j.detect : {};
  const sources = isObject(detect.sources) ? detect.sources : {};
  const comments = safeArray(sources.comments);
  const itemPolicyBundle = isObject(j?.policy_bundle) ? j.policy_bundle : {};
  const asp = isObject(itemPolicyBundle?.answer_slot_patterns) ? itemPolicyBundle.answer_slot_patterns : null;
  const pairsRaw = safeArray(asp?.tier3_pairs);
  const fullPathPairDiag = { loaded_n: 0, invalid_n: 0, invalid_samples: [] };
  const tier3Pairs = [];
  for (const p of pairsRaw) {
    const label = toStr(p?.label).trim();
    const reStr = toStr(p?.re || p?.pattern || p?.regex || '').trim();
    if (!label || !reStr) continue;
    const re = safeRegexFromMaybeString(reStr);
    if (!re) {
      fullPathPairDiag.invalid_n += 1;
      if (fullPathPairDiag.invalid_samples.length < 12) {
        fullPathPairDiag.invalid_samples.push({ label: label.slice(0, 80), pattern: reStr.slice(0, 220) });
      }
      continue;
    }
    fullPathPairDiag.loaded_n += 1;
    tier3Pairs.push({ label, re });
  }
  const commonWordSet = getCommonWordSet(policyBundle);
  const index = buildCandidateIndex(candidatesNorm);
  const suppressKeys = new Set();
  const boostKeys = new Set();
  const reasonCounts = {};
  const counts = {
    tier3_comments_n: 0,
    parsed_pairs_n: 0,
    capture_pairs_n: 0,
    heuristic_pairs_n: 0,
    matched_pairs_n: 0,
    suppress_n: 0,
    boost_n: 0,
    unmatched_pairs_n: 0,
    rejected_common_word_n: 0,
    rejected_non_unique_token_n: 0,
    rejected_cross_type_n: 0,
    rejected_bad_token_n: 0,
    rejected_pack_gate_hard_block_n: 0,
    tier3_pairs_loaded_n: fullPathPairDiag.loaded_n,
    tier3_pairs_invalid_n: fullPathPairDiag.invalid_n,
  };
  const samples = [];
  const rejectedSamples = [];
  const debug = [];
  const reasonSamples = [];
  const candByKey = new Map();
  for (const c of safeArray(candidatesNorm)) {
    if (isObject(c)) candByKey.set(stableKeyForCandidate(c), c);
  }
  function incReason(k) {
    reasonCounts[k] = (reasonCounts[k] || 0) + 1;
  }
  function isCommonWordTier3(tokenNorm) {
    const t = normToken(tokenNorm);
    return t ? commonWordSet.has(t) : false;
  }
  for (const c of comments) {
    if (!isObject(c) || toStr(c.answer_tier) !== 'TIER3') continue;
    counts.tier3_comments_n += 1;
    const contr = isObject(c.contradiction) ? c.contradiction : null;
    const excerpt = toStr(contr?.excerpt || c.raw || '').slice(0, 240);
    const rawText = toStr(c.raw || excerpt);
    const normText = toStr(c.norm || '');
    let parsed = null;
    for (const rec of tier3Pairs) {
      const m1 = normText ? normText.match(rec.re) : null;
      const m2 = !m1 && rawText ? rawText.match(rec.re) : null;
      const m = m1 || m2;
      if (!m) continue;
      const x = normToken(m[1] || '');
      const y = normToken(m[2] || '');
      if (!x || !y || x === y) continue;
      parsed = { x, y, pattern: rec.label, method: 'capture' };
      break;
    }
    if (!parsed) parsed = parseTier3PairFromText(excerpt);
    if (!parsed) continue;
    counts.parsed_pairs_n += 1;
    if (parsed.method === 'capture') counts.capture_pairs_n += 1;
    else counts.heuristic_pairs_n += 1;
    if (tier3TokenIsBad(parsed.x) || tier3TokenIsBad(parsed.y)) {
      counts.rejected_bad_token_n += 1;
      incReason('tier3_pair:reject_bad_token');
      pushBoundedTier3(rejectedSamples, { comment_id: toStr(c.id || ''), reason: 'reject:bad_token', x_norm: parsed.x, y_norm: parsed.y, method: parsed.method, excerpt });
      continue;
    }
    if (isCommonWordTier3(parsed.x) || isCommonWordTier3(parsed.y)) {
      counts.rejected_common_word_n += 1;
      incReason('tier3_pair:reject_common_word_token');
      pushBoundedTier3(rejectedSamples, { comment_id: toStr(c.id || ''), reason: 'reject:common_word_token', x_norm: parsed.x, y_norm: parsed.y, method: parsed.method, excerpt });
      continue;
    }
    const xHit = tier3MatchTokenToCandidate(parsed.x, index);
    const yHit = tier3MatchTokenToCandidate(parsed.y, index);
    if (!xHit || !yHit || xHit.key === yHit.key) {
      counts.unmatched_pairs_n += 1;
      incReason('tier3_pair:unmatched_or_non_unique');
      const xAmb = !xHit && (index.aliasToHits.get(parsed.x) || []).length > 1;
      const yAmb = !yHit && (index.aliasToHits.get(parsed.y) || []).length > 1;
      if (xAmb || yAmb) counts.rejected_non_unique_token_n += 1;
      pushBoundedTier3(debug, { comment_id: toStr(c.id || ''), x_norm: parsed.x, y_norm: parsed.y, x_key: xHit ? xHit.key : null, y_key: yHit ? yHit.key : null, x_via: xHit ? xHit.via : null, y_via: yHit ? yHit.via : null, method: parsed.method, excerpt });
      continue;
    }
    if (!tier3TypesCompatible(xHit, yHit)) {
      counts.rejected_cross_type_n += 1;
      incReason('tier3_pair:reject_cross_type_or_category');
      pushBoundedTier3(rejectedSamples, { comment_id: toStr(c.id || ''), reason: 'reject:cross_type_or_category', x_norm: parsed.x, y_norm: parsed.y, x_key: xHit.key, y_key: yHit.key, x_cat: xHit.category, y_cat: yHit.category, x_type: xHit.dictionary_entity_type, y_type: yHit.dictionary_entity_type, method: parsed.method, excerpt });
      continue;
    }
    const xCand = candByKey.get(xHit.key);
    const yCand = candByKey.get(yHit.key);
    if (tier3CandidateHardBlocked(xCand) || tier3CandidateHardBlocked(yCand)) {
      counts.rejected_pack_gate_hard_block_n += 1;
      incReason('tier3_pair:reject_pack_gate_hard_block');
      pushBoundedTier3(rejectedSamples, { comment_id: toStr(c.id || ''), reason: 'reject:pack_gate_hard_block', x_key: xHit.key, y_key: yHit.key, method: parsed.method, excerpt });
      continue;
    }
    if (!candByKey.has(xHit.key) || !candByKey.has(yHit.key)) {
      incReason('tier3_pair:reject_key_not_in_candidates');
      pushBoundedTier3(rejectedSamples, { comment_id: toStr(c.id || ''), reason: 'reject:key_not_in_candidates', x_key: xHit.key, y_key: yHit.key, method: parsed.method });
      continue;
    }
    counts.matched_pairs_n += 1;
    incReason(parsed.method === 'capture' ? 'tier3_pair:matched_capture' : 'tier3_pair:matched_heuristic');
    suppressKeys.add(xHit.key);
    boostKeys.add(yHit.key);
    pushBoundedTier3(samples, { comment_id: toStr(c.id || ''), method: parsed.method, pattern: parsed.pattern, x_norm: parsed.x, y_norm: parsed.y, suppress_key: xHit.key, boost_key: yHit.key, x_via: xHit.via, y_via: yHit.via, category: xHit.category, dictionary_entity_type: xHit.dictionary_entity_type, excerpt });
    if (reasonSamples.length < 12) {
      reasonSamples.push({ comment_id: toStr(c.id || ''), reason: parsed.method === 'capture' ? 'tier3_pair:matched_capture' : 'tier3_pair:matched_heuristic', suppress_key: xHit.key, boost_key: yHit.key, x_via: xHit.via, y_via: yHit.via });
    }
  }
  counts.suppress_n = suppressKeys.size;
  counts.boost_n = boostKeys.size;
  return {
    tier3_binding_suppress_keys: [...suppressKeys],
    tier3_binding_boost_keys: [...boostKeys],
    tier3_binding_counts: { ...counts, contradiction_count: contradictionCount, no_op: false },
    tier3_binding_samples: samples,
    tier3_binding_rejected_samples: rejectedSamples,
    tier3_binding_debug: debug,
    tier3_binding_reason_counts: reasonCounts,
    tier3_binding_reason_samples: reasonSamples,
    tier3_pairs_compile_diag: fullPathPairDiag,
  };
}

function getCollisionsView(policyBundle) {
  const pm = isObject(policyBundle?.policyMeta) ? policyBundle.policyMeta : {};
  return isObject(pm.alias_collision_registry) ? pm.alias_collision_registry : {};
}

function getCommonWordSet(policyBundle) {
  return new Set(safeArray(policyBundle?.policyMeta?.common_word_alias_norms).map((x) => normToken(x)).filter(Boolean));
}

function isCollisionAlias(collisions, cand) {
  const et = toStr(cand.dictionary_entity_type);
  const aliasNorms = safeArray(cand.alias_norms).map(toStr).filter(Boolean);
  if (!aliasNorms.length) return false;
  for (const an of aliasNorms) {
    if (et && isObject(collisions[et]) && collisions[et][an]) return true;
    if (collisions[an]) return true;
  }
  return false;
}

function deriveMatchKind(origins, aliasNorms, fuzzySim) {
  const os = new Set(safeArray(origins).map(toStr));
  const hasExact = os.has('exact');
  const hasFuzzy = os.has('fuzzy');
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

function applyCanonicalAliasResolution(candidatesNorm, ctx) {
  const {
    policyBundle,
    answerSlotStrongSupport,
    answerSlotContradictionCount,
  } = ctx;
  const commonWordSet = getCommonWordSet(policyBundle);
  const collisions = getCollisionsView(policyBundle);

  const suppressKeys = new Set();
  const laneCaps = {};
  const directives = {};

  const counts = {
    candidates_in: candidatesNorm.length,
    hero_alias_lane_capped_n: 0,
    prefer_canonical_policy_n: 0,
    alias_only_weak_suppressed_n: 0,
    fuzzy_near_exact_n: 0,
    t2_alias_requires_signal_n: 0,
    t3_alias_requires_signals_n: 0,
    common_word_alias_directive_n: 0,
    collision_alias_directive_n: 0,
    alias_only_common_word_suppressed_n: 0,
    alias_only_collision_suppressed_n: 0,
    pack_escape_directive_n: 0,
  };

  const patched = candidatesNorm.map((c0) => {
    const c = { ...c0 };
    const key = stableKeyForCandidate(c);
    const policy = isObject(c.policy) ? c.policy : null;
    const es = isObject(c.evidence_summary) ? c.evidence_summary : {};

    let hasTitleOp = es.has_title_op === true;
    let hasComment = es.has_comment === true;
    let commentOnly = es.comment_only === true;
    if (!es || Object.keys(es).length === 0) {
      const f = { hasTitleOp: false, hasComment: false, commentOnly: true };
      for (const ev of safeArray(c.evidence)) {
        const st = toStr(ev.source_type).toLowerCase();
        if (st === 'title' || st === 'op') f.hasTitleOp = true;
        if (st === 'comment') f.hasComment = true;
      }
      hasTitleOp = f.hasTitleOp;
      hasComment = f.hasComment;
      commentOnly = !hasTitleOp && hasComment;
    }

    const origins = safeArray(c.origins);
    const aliasNorms = safeArray(c.alias_norms);
    const fuzzySim = isObject(c.fuzzy_meta) && Number.isFinite(c.fuzzy_meta.sim) ? c.fuzzy_meta.sim : null;
    const det_fuzzy_near_exact = Number.isFinite(fuzzySim) && fuzzySim >= 0.9995;
    const det_match_kind = deriveMatchKind(origins, aliasNorms, fuzzySim);

    if (det_fuzzy_near_exact) counts.fuzzy_near_exact_n += 1;

    const det_alias_only_signal = aliasNorms.length > 0 && commentOnly && !hasTitleOp;
    const corroborated = isCorroborated(es, answerSlotStrongSupport, answerSlotContradictionCount);

    const d = {
      match_kind: det_match_kind,
      alias_only_signal: det_alias_only_signal,
      fuzzy_near_exact: det_fuzzy_near_exact,
      prefer_canonical: policy?.prefer_canonical_over_alias === true,
      corroborated: corroborated === true,
      has_title_op: hasTitleOp,
      comment_only: commentOnly,
      alias_tier: toStr(policy?.tier || ''),
      requires_min_signals: 0,
      block_rag: false,
      lane_cap: null,
      is_common_word_alias: false,
      is_collision_alias: false,
      is_pack_escape: false,
      directive_reasons: [],
    };

    const categoryLc = toStr(c.category).toLowerCase();
    const isHero = categoryLc === 'hero';
    const isAliasish = det_match_kind.endsWith('_ALIAS') || aliasNorms.length > 0;
    if (isHero && isAliasish) {
      const prev = laneCaps[key];
      laneCaps[key] = prev ? minLane(prev, 'HIGH') : 'HIGH';
      d.lane_cap = laneCaps[key];
      d.block_rag = true;
      d.directive_reasons.push('directive:hero_alias_never_hard');
      counts.hero_alias_lane_capped_n += 1;
    }

    const tier = toStr(policy?.tier || '').toUpperCase();
    if (isAliasish && !hasTitleOp) {
      if (tier === 'TIER_2') {
        d.requires_min_signals = Math.max(d.requires_min_signals, 1);
        d.directive_reasons.push('directive:t2_alias_requires_1_signal');
        counts.t2_alias_requires_signal_n += 1;
      }
      if (tier === 'TIER_3') {
        d.requires_min_signals = Math.max(d.requires_min_signals, 2);
        d.directive_reasons.push('directive:t3_alias_requires_2_signals');
        counts.t3_alias_requires_signals_n += 1;
      }
    }

    const primaryAliasNorm = toStr(aliasNorms[0] || '');
    const isCommonWord = primaryAliasNorm && commonWordSet.has(normToken(primaryAliasNorm));
    const isCollision = isCollisionAlias(collisions, c);

    if (isCommonWord && isAliasish) {
      d.is_common_word_alias = true;
      d.block_rag = true;
      const prev = laneCaps[key];
      laneCaps[key] = prev ? minLane(prev, 'HIGH') : 'HIGH';
      d.lane_cap = laneCaps[key];
      d.directive_reasons.push('directive:common_word_alias_cap_high');
      counts.common_word_alias_directive_n += 1;
      if (det_alias_only_signal && !corroborated) {
        suppressKeys.add(key);
        counts.alias_only_common_word_suppressed_n += 1;
      }
    }

    if (isCollision && isAliasish) {
      d.is_collision_alias = true;
      d.block_rag = true;
      const prev = laneCaps[key];
      laneCaps[key] = prev ? minLane(prev, 'HIGH') : 'HIGH';
      d.lane_cap = laneCaps[key];
      d.directive_reasons.push('directive:collision_alias_cap_high');
      counts.collision_alias_directive_n += 1;
      if (det_alias_only_signal && !corroborated) {
        suppressKeys.add(key);
        counts.alias_only_collision_suppressed_n += 1;
      }
    }

    const pm = isObject(c.pack_meta) ? c.pack_meta : null;
    if (pm?.pack_risky_alias_escaped === true) {
      d.is_pack_escape = true;
      d.block_rag = true;
      const prev = laneCaps[key];
      laneCaps[key] = prev ? minLane(prev, 'HIGH') : 'HIGH';
      d.lane_cap = laneCaps[key];
      d.directive_reasons.push('directive:pack_escape_cap_high_block_rag');
      counts.pack_escape_directive_n += 1;
    }

    if (policy?.prefer_canonical_over_alias === true) {
      counts.prefer_canonical_policy_n += 1;
      if (det_alias_only_signal && !corroborated) {
        suppressKeys.add(key);
        counts.alias_only_weak_suppressed_n += 1;
      }
    }

    directives[key] = d;

    const resolver = {
      match_kind: det_match_kind,
      alias_only_signal: det_alias_only_signal,
      fuzzy_near_exact: det_fuzzy_near_exact,
      prefer_canonical: policy?.prefer_canonical_over_alias === true,
      corroborated: corroborated === true,
      has_title_op: hasTitleOp,
      comment_only: commentOnly,
      alias_tier: d.alias_tier || null,
      requires_min_signals: d.requires_min_signals || 0,
      block_rag: d.block_rag === true,
      is_common_word_alias: d.is_common_word_alias === true,
      is_collision_alias: d.is_collision_alias === true,
      is_pack_escape: d.is_pack_escape === true,
      directive_reasons: d.directive_reasons.slice(0, 8),
    };

    return {
      ...c,
      det_match_kind,
      det_alias_only_signal,
      det_fuzzy_near_exact,
      canonical_alias_resolver: resolver,
    };
  });

  return {
    candidates: patched,
    canonical_alias_suppress_keys: [...suppressKeys],
    canonical_alias_lane_caps: laneCaps,
    canonical_alias_directives: directives,
    canonical_alias_counts: counts,
  };
}

/**
 * @param {object} expandOutput - one expandFuzzyCandidates() result item
 * @param {object} policyBundle - loadPolicyBundle() / composePolicyBundle() result
 */
function normalizeAndResolveCandidates(expandOutput, policyBundle) {
  const j = expandOutput || {};
  if (!isObject(j.detect) || !toStr(j.post_id)) {
    throw new Error('normalizeAndResolveCandidates: expected expandFuzzyCandidates output with post_id and detect.');
  }

  applyCommentSignals(j.detect, policyBundle);

  const dictRows = safeArray(policyBundle?.dictionaries?.rows);
  const policyMeta = isObject(policyBundle?.policyMeta) ? policyBundle.policyMeta : {};
  const exactIn = safeArray(j.entity_candidates_exact);
  const fuzzyIn = safeArray(j.entity_candidates_fuzzy);

  const normAll = [];
  for (const c of exactIn) normAll.push(normalizeRawCandidate(c, 'exact'));
  for (const c of fuzzyIn) normAll.push(normalizeRawCandidate(c, 'fuzzy'));

  const filtered = normAll.filter((c) => toStr(c.category) && toStr(c.canonical_slug) && toStr(c.dictionary_entity_type));

  const map = new Map();
  let mergedDuplicates = 0;

  for (const c of filtered) {
    const key = stableKeyForCandidate(c);
    if (!map.has(key)) {
      map.set(key, {
        category: c.category,
        canonical_slug: c.canonical_slug,
        dictionary_entity_type: c.dictionary_entity_type,
        hero_slug: null,
        hero_slugs: [],
        hero_slug_conflict: false,
        origins: [],
        alias_texts: [],
        alias_norms: [],
        promotion_risk: null,
        fuzzy_meta: null,
        pack_meta: null,
        evidence: [],
        candidate_ids: [],
        _seenEvidenceKeys: new Set(),
      });
    } else {
      mergedDuplicates += 1;
    }
    const bucket = map.get(key);
    if (c.candidate_id) {
      bucket.candidate_ids = stableUniqStrings([...(bucket.candidate_ids || []), c.candidate_id]);
    }
    mergeIntoBucket(bucket, c);
  }

  const ow_context_present = computeOwContextPresent(j);
  const slotScalars = countAnswerSlotScalars(j.detect);
  const { pairs: tier3PairLib, diag: tier3PairCompileDiag } = compileTier3Pairs(policyBundle);

  let candidates_norm = Array.from(map.values()).map((bucket) => {
    const out = { ...bucket };
    delete out._seenEvidenceKeys;
    out.evidence = stableSortEvidence(out.evidence);
    out.evidence_preview = buildEvidencePreviewItems(out.evidence, 5);
    out.candidate_ids = stableUniqStrings(out.candidate_ids || []);
    out.evidence_summary = buildEvidenceSummary(out.evidence);
    out.evidence_summary.preview_n = safeArray(out.evidence_preview).length;

    out.evidence_summary.exact_context_signals = deriveExactContextSignals(j, out);

    out.evidence_summary.topicality_strong = deriveTopicalityStrong(out.evidence_summary);
    const rel = deriveCommentExactRelevance(out.evidence_summary, out);
    if (rel) {
      out.evidence_summary.comment_exact_relevance_bucket = rel.bucket;
      out.evidence_summary.comment_exact_relevance_reasons = rel.reasons;
    }

    const policy = lookupPolicy(dictRows, out.dictionary_entity_type, out.canonical_slug, out.alias_norms);
    if (policy) {
      out.policy = policy;
      if (!out.promotion_risk && policy.promotion_risk) out.promotion_risk = policy.promotion_risk;
    } else if (!out.policy) {
      out.policy = null;
    }
    // Preserve out.policy from merged candidate when lookupPolicy returns null (e.g. ability/perk from pack)
    // For intent derivation: prefer pack's requires_anchor when stricter (alias row vs canonical)
    const effectivePolicy =
      bucket.policy?.requires_anchor === true && (out.policy?.requires_anchor === null || out.policy?.requires_anchor === undefined)
        ? { ...out.policy, requires_anchor: true }
        : out.policy;

    const intent = deriveIntentEvidence(j, out, effectivePolicy, policyMeta, ow_context_present);
    if (intent) {
      out.evidence_summary.intent_evidence = intent;
      // When intent derived via ability/perk + ow_context (policy had null), align policy for fixture parity
      if (intent.requires_ow_context === true && isObject(out.policy) && out.policy.requires_ow_context !== true) {
        out.policy = { ...out.policy, requires_ow_context: true };
      }
    }

    if (isOwnerScopeCategory(out.category)) {
      out.evidence_summary.owner_evidence = deriveOwnerEvidence(out, out.policy);
    }

    out.evidence_summary.protected_context = deriveProtectedContext(
      out,
      out.evidence_summary.intent_evidence,
      out.evidence_summary.owner_evidence,
    );
    out.protected_context = out.evidence_summary.protected_context;

    return out;
  });

  const tier3Out =
    slotScalars.answer_slot_contradiction_count <= 0
      ? runTier3BindingNoOp(slotScalars.answer_slot_contradiction_count, tier3PairCompileDiag)
      : runTier3BindingFull(j, candidates_norm, policyBundle, tier3PairCompileDiag, slotScalars.answer_slot_contradiction_count);

  const canonCtx = {
    policyBundle,
    answerSlotStrongSupport: slotScalars.answer_slot_strong_support,
    answerSlotContradictionCount: slotScalars.answer_slot_contradiction_count,
  };
  const resolved = applyCanonicalAliasResolution(candidates_norm, canonCtx);
  candidates_norm = resolved.candidates;

  const byCat = {};
  for (const c of candidates_norm) {
    byCat[c.category] = (byCat[c.category] || 0) + 1;
  }

  const traceSample = candidates_norm.slice(0, 16).map((c) => ({
    key: stableKeyForCandidate(c),
    origins: c.origins,
    ev_n: c.evidence.length,
    has_title_op: c.evidence_summary?.has_title_op === true,
    independent_evidence_n: c.evidence_summary?.independent_evidence_n ?? null,
    comment_rank_bucket: c.evidence_summary?.comment_rank_bucket ?? null,
    policy_tier: c.policy?.tier || null,
    policy_src: c.policy?._policy_source || null,
    fuzzy_sim: c.fuzzy_meta?.sim ?? null,
  }));

  const normalization_resolution_meta = {
    stage_version: 'normalize_resolve_v1',
    ow_context_present,
    answer_slot: slotScalars,
    merge: {
      exact_in: exactIn.length,
      fuzzy_in: fuzzyIn.length,
      total_in: exactIn.length + fuzzyIn.length,
      valid_in: filtered.length,
      merged_duplicates: mergedDuplicates,
      out: candidates_norm.length,
      by_category: byCat,
    },
    tier3: {
      suppress_keys: tier3Out.tier3_binding_suppress_keys,
      boost_keys: tier3Out.tier3_binding_boost_keys,
      counts: tier3Out.tier3_binding_counts,
      pairs_compile_diag: tier3Out.tier3_pairs_compile_diag,
    },
    canonical_alias: {
      suppress_keys: resolved.canonical_alias_suppress_keys,
      lane_caps: resolved.canonical_alias_lane_caps,
      directives: resolved.canonical_alias_directives,
      counts: resolved.canonical_alias_counts,
    },
    trace: { sample: traceSample },
  };

  const out = {
    ...j,
    entity_candidates_resolved: candidates_norm,
    normalization_resolution_meta,
  };
  if (Object.prototype.hasOwnProperty.call(tier3Out, 'tier3_binding_debug')) {
    out.tier3_binding_debug = safeArray(tier3Out.tier3_binding_debug);
  }
  return out;
}

module.exports = {
  normalizeAndResolveCandidates,
};

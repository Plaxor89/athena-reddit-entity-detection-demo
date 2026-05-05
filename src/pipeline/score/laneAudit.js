// laneAudit.js - private helper for scoreSuppressLane stage.
// Lane decision/blocker derivation and audit annotations only.

function toStr(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

function safeArray(x) {
  return Array.isArray(x) ? x : [];
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

/** Fallback row-audit tokens when no storage_reason_primary / suppression string exists yet (storage-first wording; not implementation lane). */
const STORAGE_DECISION_FALLBACK_RAG_OK = 'storage_decision:rag_ok';
const STORAGE_DECISION_FALLBACK_CONTEXT_ONLY = 'storage_decision:context_only';
const STORAGE_DECISION_FALLBACK_SHADOW_NONE = 'storage_decision:shadow_none';

function deriveLaneDecisionPrimary(target) {
  const si = toStr(target?.storage_intent).trim().toUpperCase();
  if (si === 'RAG_OK' || si === 'CONTEXT_ONLY') {
    return toStr(target?.storage_reason_primary).trim() || (si === 'RAG_OK' ? STORAGE_DECISION_FALLBACK_RAG_OK : STORAGE_DECISION_FALLBACK_CONTEXT_ONLY);
  }
  return toStr(target?.suppression_reason_primary || target?.drop_reason_primary || target?.det_suppressed_reason || target?.storage_reason_primary).trim() || STORAGE_DECISION_FALLBACK_SHADOW_NONE;
}

function deriveLaneDecisionFamily(primary, target) {
  const p = toStr(primary).trim();
  if (!p) return null;
  if (p === STORAGE_DECISION_FALLBACK_RAG_OK) return 'rag_ok';
  if (p === STORAGE_DECISION_FALLBACK_CONTEXT_ONLY) return 'context_only';
  if (p === STORAGE_DECISION_FALLBACK_SHADOW_NONE) return 'shadow';
  if (p.startsWith('storage:rag_ok')) return 'rag_ok';
  if (p.startsWith('storage:context_only')) return 'context_only';
  if (p.startsWith('storage:none')) return 'shadow';
  if (p.startsWith('storage:block_')) return 'storage_block';
  if (p.startsWith('suppress:')) return 'suppression';
  if (p.startsWith('same_canonical_selected_elsewhere:')) return 'selection_competition';
  if (p.startsWith('shadow:')) return 'shadow';
  return prefixOf(p);
}

function deriveLaneBlockerPrimary(target) {
  const blockers = safeArray(target?.storage_blockers).map(toStr).filter(Boolean);
  if (blockers.length) return blockers[0];
  return toStr(target?.suppression_reason_primary || target?.drop_reason_primary || target?.selection_competition_reason || '').trim() || null;
}

function deriveLaneBlockerFamily(primary) {
  const p = toStr(primary).trim();
  if (!p) return null;
  if (p.startsWith('storage:block_')) return 'storage_block';
  if (p.startsWith('suppress:')) return 'suppression';
  if (p.startsWith('same_canonical_selected_elsewhere:')) return 'selection_competition';
  if (p.startsWith('shadow:')) return 'shadow';
  return prefixOf(p);
}

function buildLaneSupportSignals(target) {
  const out = [];
  const add = (s) => { if (s && !out.includes(s) && out.length < 12) out.push(s); };
  const mk = toStr(target?.det_match_kind).toUpperCase();
  const ek = toStr(target?.det_equivalence_kind).toUpperCase();
  if (mk === 'EXACT_CANONICAL') add('support:exact_canonical');
  else if (mk === 'EXACT_ALIAS') add('support:exact_alias');
  else if (mk === 'FUZZY_CANONICAL') add('support:fuzzy_canonical');
  else if (mk === 'FUZZY_ALIAS') add('support:fuzzy_alias');
  if (ek === 'NORM_EQ') add('support:fuzzy_norm_equivalence');
  if (ek === 'EDITDIST_EQ') add('support:fuzzy_editdist_equivalence');
  if (ek === 'DISAMBIGUATOR_EQ') add('support:fuzzy_disambiguator_equivalence');
  if (target?.det_topicality_strong === true) add('support:topicality_strong');
  if (target?.evidence_summary?.has_title_op === true || hasTitleOrOpEvidence(target?.evidence)) add('support:title_op');
  if (target?.evidence_summary?.has_comment === true || hasCommentEvidence(target?.evidence)) add('support:comment');
  if (target?.owner_evidence?.owner_title_op_support === true || target?.owner_evidence?.owner_exact_title_op_support === true) add('support:owner_title_op');
  if (target?.owner_evidence?.same_hero_context_unlock === true) add('support:same_hero_unlock');
  if (target?.protected_context?.pass_protected_context === true || target?.protected_context?.protected_context === true || target?.protected_context?.protected_primary === true) add('support:protected_context');
  if (safeArray(target?.det_safe_tags).length) add('support:det_safe_bypass');
  if (toStr(target?.storage_reason_primary).startsWith('storage:rag_ok:protected_')) add('support:protected_exact_primary');
  if (toStr(target?.storage_reason_primary).startsWith('storage:rag_ok:owner_')) add('support:owner_safe_rag_ok');
  return out;
}

function buildLaneBlockSignals(target) {
  const out = [];
  const add = (s) => { if (s && !out.includes(s) && out.length < 12) out.push(s); };
  for (const b of safeArray(target?.storage_blockers).map(toStr).filter(Boolean)) add(b);
  const srp = toStr(target?.suppression_reason_primary || target?.det_suppressed_reason).trim();
  if (srp) add(srp);
  const drp = toStr(target?.drop_reason_primary).trim();
  if (drp) add(drp);
  if (target?.det_alias_directive_block_rag === true) add('block:alias_directive_block_rag');
  if (target?.det_off_domain_collision === true) add('block:off_domain_collision');
  if (target?.det_owner_scope_required === true && toStr(target?.det_owner_status).toUpperCase() !== 'KNOWN') add('block:missing_owner_scope');
  if (Number(target?.det_intent_neg_anchor_hits_n || 0) > 0) add('block:negative_anchor');
  if (toStr(target?.det_comment_exact_relevance_bucket).toUpperCase() === 'LOW') add('block:comment_exact_low_relevance');
  return out;
}

function buildLanePromotionPath(target) {
  const out = [];
  const add = (s) => { if (s && !out.includes(s) && out.length < 12) out.push(s); };
  const mk = toStr(target?.det_match_kind).toUpperCase();
  const ek = toStr(target?.det_equivalence_kind).toUpperCase();
  if (mk === 'EXACT_CANONICAL') add('exact_canonical');
  else if (mk === 'EXACT_ALIAS') add(`exact_alias_t${toStr(target?.policy?.tier || '').trim() || 'x'}`);
  else if (ek === 'NORM_EQ') add('fuzzy_norm_equivalence');
  else if (ek === 'EDITDIST_EQ') add('fuzzy_editdist_equivalence');
  else if (ek === 'DISAMBIGUATOR_EQ') add('fuzzy_disambiguator_equivalence');
  if (target?.owner_evidence?.owner_title_op_support === true || target?.owner_evidence?.owner_exact_title_op_support === true) add('owner_title_context');
  if (target?.owner_evidence?.same_hero_context_unlock === true) add('same_hero_unlock');
  if (safeArray(target?.det_safe_tags).length) add(toStr(safeArray(target.det_safe_tags)[0]));
  const rr = toStr(target?.selection_reason_primary || target?.det_selected_reason).trim();
  if (rr) add(rr);
  const sr = toStr(target?.storage_reason_primary).trim();
  if (sr) add(sr);
  return out;
}

function annotateLaneAuditBundle(target) {
  if (!target || typeof target !== 'object') return;
  const primary = deriveLaneDecisionPrimary(target);
  const family = deriveLaneDecisionFamily(primary, target);
  const blockerPrimary = deriveLaneBlockerPrimary(target);
  const blockerFamily = deriveLaneBlockerFamily(blockerPrimary);
  target.storage_decision_primary = primary || null;
  target.storage_decision_family = family || null;
  target.storage_blocker_primary = blockerPrimary || null;
  target.storage_blocker_family = blockerFamily || null;
  target.storage_support_signals_dbg = uniqueBoundedStrings(buildLaneSupportSignals(target), 12);
  target.storage_block_signals_dbg = uniqueBoundedStrings(buildLaneBlockSignals(target), 12);
  target.storage_promotion_path_dbg = uniqueBoundedStrings(buildLanePromotionPath(target), 12);
}

module.exports = {
  deriveLaneDecisionPrimary,
  deriveLaneDecisionFamily,
  deriveLaneBlockerPrimary,
  deriveLaneBlockerFamily,
  buildLaneSupportSignals,
  buildLaneBlockSignals,
  buildLanePromotionPath,
  annotateLaneAuditBundle,
  hasTitleOrOpEvidence,
};

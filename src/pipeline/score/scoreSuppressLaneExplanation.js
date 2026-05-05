// scoreSuppressLaneExplanation.js — deterministic_item_explanation builder (read-only summary).
// Extracted from scoreSuppressLane.js (structure only; behavior frozen).

const { isObject, toStr } = require('./scoreSuppressLanePolicy');

const DETERMINISTIC_ITEM_EXPLANATION_VERSION = '2026-03-26.item-v1';

/**
 * Read-only summary for DB/review/debug: derived only from counts and reason tallies
 * already computed in this stage (no parallel scoring or alternate lane authority).
 */
function topReasonEntriesFromCounts(counts, cap) {
  const lim = cap != null ? cap : 4;
  if (!isObject(counts)) return [];
  return Object.entries(counts)
    .filter(([k]) => toStr(k).trim())
    .sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0))
    .slice(0, lim)
    .map(([reason, n]) => ({ reason: toStr(reason), n: Number(n) || 0 }));
}

/** Posture-first wording; additive companion to legacy summary_line (lane/storage ordering). */
function buildSummaryLinePostureFirst(
  outcome_path,
  deterministic_lane,
  deterministic_storage_intent,
  topSel,
  topSup,
) {
  let line = `[${outcome_path}]`;
  if (deterministic_storage_intent != null) {
    line += ` posture=${deterministic_storage_intent}`;
    if (deterministic_lane != null) line += ` (implementation_class=${deterministic_lane})`;
  } else if (deterministic_lane != null) {
    line += ` implementation_class=${deterministic_lane} (posture unresolved)`;
  } else {
    line += ' posture unresolved';
  }
  if (outcome_path === 'suppressed_only' && topSup.length) {
    line += ` | top_suppress: ${topSup[0].reason} (n=${topSup[0].n})`;
  } else if (outcome_path === 'selected_promoted' && topSel.length) {
    line += ` | top_select: ${topSel[0].reason} (n=${topSel[0].n})`;
  } else if (outcome_path === 'ambiguous_posture') {
    line +=
      ' — unexpected null policy with candidates>0; see deterministic_policy_invariant_violation or partition guard.';
  }
  return line;
}

function buildDeterministicItemExplanation(opts) {
  const post_id = opts.post_id;
  const candidates_norm_n = Number(opts.candidates_norm_n) || 0;
  const det_selected_pre_n = Number(opts.det_selected_pre_n) || 0;
  const det_suppressed_pre_n = Number(opts.det_suppressed_pre_n) || 0;
  const deterministic_lane = opts.deterministic_lane;
  const deterministic_storage_intent = opts.deterministic_storage_intent;
  const inv = opts.deterministic_policy_invariant_violation;
  const selected_reason_counts = opts.selected_reason_counts;
  const suppressed_reason_counts = opts.suppressed_reason_counts;

  const pid = post_id != null ? toStr(post_id) : null;
  const base = {
    explanation_version: DETERMINISTIC_ITEM_EXPLANATION_VERSION,
    post_id: pid,
    counts: {
      candidates_norm_n,
      det_selected_pre_n,
      det_suppressed_pre_n,
    },
  };

  if (inv != null && typeof inv === 'object') {
    const topSel = topReasonEntriesFromCounts(selected_reason_counts, 3);
    const topSup = topReasonEntriesFromCounts(suppressed_reason_counts, 3);
    const code = toStr(inv.code);
    const msg = toStr(inv.message);
    const summary_line = `[invariant_failed] ${code}: ${msg.slice(0, 280)}${msg.length > 280 ? '…' : ''}`;
    return {
      ...base,
      outcome_path: 'invariant_failed',
      policy_posture: null,
      policy_lane: null,
      policy_storage_intent: null,
      summary_line,
      // Posture-first / neutral aliases (see docs/CONTRACTS.md §3 — canonical item posture vocabulary).
      item_posture: null,
      implementation_class: null,
      implementation_plus_posture_label: null,
      summary_line_posture_first: summary_line,
      top_selected_reasons: topSel,
      top_suppressed_reasons: topSup,
      invariant_outline: {
        code: inv.code ?? null,
        row_count: Array.isArray(inv.rows) ? inv.rows.length : 0,
      },
    };
  }

  if (candidates_norm_n === 0) {
    const summary_line = 'No deterministic candidates were detected for this item.';
    return {
      explanation_version: DETERMINISTIC_ITEM_EXPLANATION_VERSION,
      post_id: pid,
      outcome_path: 'zero_candidates',
      policy_posture: null,
      policy_lane: null,
      policy_storage_intent: null,
      summary_line,
      item_posture: null,
      implementation_class: null,
      implementation_plus_posture_label: null,
      summary_line_posture_first: summary_line,
      counts: {
        total_candidates: 0,
        selected: 0,
        suppressed: 0,
      },
      top_selected_reasons: [],
      top_suppressed_reasons: [],
    };
  }

  const posture =
    deterministic_lane != null && deterministic_storage_intent != null
      ? `${deterministic_lane}+${deterministic_storage_intent}`
      : null;

  let outcome_path = 'ambiguous_posture';
  if (det_selected_pre_n > 0 && posture) outcome_path = 'selected_promoted';
  else if (det_selected_pre_n === 0 && det_suppressed_pre_n > 0 && posture)
    outcome_path = 'suppressed_only';

  const topSel = topReasonEntriesFromCounts(selected_reason_counts, 4);
  const topSup = topReasonEntriesFromCounts(suppressed_reason_counts, 4);

  let summary_line = `[${outcome_path}] ${posture || 'lane/storage unresolved'}`;
  if (outcome_path === 'suppressed_only' && topSup.length) {
    summary_line += ` | top_suppress: ${topSup[0].reason} (n=${topSup[0].n})`;
  } else if (outcome_path === 'selected_promoted' && topSel.length) {
    summary_line += ` | top_select: ${topSel[0].reason} (n=${topSel[0].n})`;
  } else if (outcome_path === 'ambiguous_posture') {
    summary_line +=
      ' — unexpected null policy with candidates>0; see deterministic_policy_invariant_violation or partition guard.';
  }

  const summary_line_posture_first = buildSummaryLinePostureFirst(
    outcome_path,
    deterministic_lane,
    deterministic_storage_intent,
    topSel,
    topSup,
  );

  return {
    ...base,
    outcome_path,
    policy_posture: posture,
    policy_lane: deterministic_lane ?? null,
    policy_storage_intent: deterministic_storage_intent ?? null,
    summary_line,
    item_posture: deterministic_storage_intent ?? null,
    implementation_class: deterministic_lane ?? null,
    implementation_plus_posture_label: posture,
    summary_line_posture_first,
    top_selected_reasons: topSel,
    top_suppressed_reasons: topSup,
  };
}

module.exports = {
  DETERMINISTIC_ITEM_EXPLANATION_VERSION,
  topReasonEntriesFromCounts,
  buildDeterministicItemExplanation,
};

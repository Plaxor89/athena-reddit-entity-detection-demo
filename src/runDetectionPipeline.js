// runDetectionPipeline.js
//
// Service entrypoint. Implements: request → buildDetectionInput → loadPolicyBundle
// → packCandidates → expandFuzzyCandidates → normalizeAndResolveCandidates → scoreSuppressLane
// → buildReviewDecision → buildDownstreamContract.
//
// Stage modules are scalar; orchestration is batch-aware.
// Optional options.policyBundle for testing (otherwise loads via loadPolicyBundle).

const { buildDetectionInput } = require('./pipeline/buildDetectionInput');
const { loadPolicyBundle } = require('./pipeline/loadPolicyBundle');
const { packCandidates } = require('./pipeline/packCandidates');
const { expandFuzzyCandidates } = require('./pipeline/expandFuzzyCandidates');
const { normalizeAndResolveCandidates } = require('./pipeline/normalizeAndResolveCandidates');
const { scoreSuppressLane } = require('./pipeline/scoreSuppressLane');
const { buildReviewDecision } = require('./pipeline/buildReviewDecision');
const { buildDownstreamContract } = require('./pipeline/buildDownstreamContract');

/**
 * @param {object|object[]} upstreamRequestItemOrItems - Request item(s).
 * @param {object} [options] - Optional. policyBundle: preloaded bundle (skips loadPolicyBundle).
 * @returns {object} stageOutputs through buildDownstreamContract; downstreamHandoff includes score, review, downstreamContract
 */
async function runDetectionPipeline(upstreamRequestItemOrItems, options = {}) {
  const isBatch = Array.isArray(upstreamRequestItemOrItems);
  const items = isBatch ? (upstreamRequestItemOrItems || []) : [upstreamRequestItemOrItems];

  const buildOutputs = items.map((item) => buildDetectionInput(item));
  const policyBundle = options.policyBundle ?? await loadPolicyBundle();

  const packOutputs = buildOutputs.map((build) => packCandidates(build, policyBundle));
  const expandOutputs = packOutputs.map((pack) => expandFuzzyCandidates(pack, policyBundle));
  const normalizeOutputs = expandOutputs.map((expand) => normalizeAndResolveCandidates(expand, policyBundle));
  const scoreOutputs = normalizeOutputs.map((normalize) => scoreSuppressLane(normalize, policyBundle));
  const reviewOutputs = scoreOutputs.map((score) => buildReviewDecision(score, policyBundle));

  const scoreHandoff = isBatch ? scoreOutputs : scoreOutputs[0];
  const reviewHandoff = isBatch ? reviewOutputs : reviewOutputs[0];

  const authorityHandoff = {
    scoreSuppressLane: scoreHandoff,
    buildReviewDecision: reviewHandoff,
  };
  const downstreamContract = buildDownstreamContract(authorityHandoff);

  return {
    stageOutputs: {
      buildDetectionInput: isBatch ? buildOutputs : buildOutputs[0],
      loadPolicyBundle: policyBundle,
      packCandidates: isBatch ? packOutputs : packOutputs[0],
      expandFuzzyCandidates: isBatch ? expandOutputs : expandOutputs[0],
      normalizeAndResolveCandidates: isBatch ? normalizeOutputs : normalizeOutputs[0],
      scoreSuppressLane: scoreHandoff,
      buildReviewDecision: reviewHandoff,
      buildDownstreamContract: downstreamContract,
    },
    downstreamHandoff: {
      ...authorityHandoff,
      downstreamContract,
    },
  };
}

module.exports = {
  runDetectionPipeline,
};


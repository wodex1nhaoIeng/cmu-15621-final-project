pragma circom 2.0.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/mux1.circom";

/**
 * VickreyAuction ZKP Circuit
 *
 * Proves that the seller correctly determined the winner and second price
 * from the committed bids, WITHOUT revealing individual bid values.
 *
 * Public inputs:
 *   - commitHashes[n]: Poseidon hashes from the commit phase (on-chain)
 *   - numActiveBidders: how many slots are actually used
 *   - declaredWinnerIdx: index of the winner
 *   - declaredSecondPrice: the second-highest bid value
 *   - reservePrice: minimum bid
 *
 * Private inputs (witness):
 *   - bidValues[n]: actual bid values
 *   - nonces[n]: random nonces
 */
template VickreyAuction(n) {
    // Public inputs
    signal input commitHashes[n];
    signal input numActiveBidders;
    signal input declaredWinnerIdx;
    signal input declaredSecondPrice;
    signal input reservePrice;

    // Private inputs
    signal input bidValues[n];
    signal input nonces[n];

    // ═══════════════ 1. Verify commit hashes ═══════════════
    component hashers[n];
    component activeCheck[n];
    signal hashDiff[n];
    signal hashConstraint[n];

    for (var i = 0; i < n; i++) {
        activeCheck[i] = LessThan(8);
        activeCheck[i].in[0] <== i;
        activeCheck[i].in[1] <== numActiveBidders;

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== bidValues[i];
        hashers[i].inputs[1] <== nonces[i];

        hashDiff[i] <== hashers[i].out - commitHashes[i];
        hashConstraint[i] <== activeCheck[i].out * hashDiff[i];
        hashConstraint[i] === 0;
    }

    // ═══════════════ 2. Find highest and second highest ═══════════════
    signal highest[n + 1];
    signal secondHighest[n + 1];

    highest[0] <== 0;
    secondHighest[0] <== 0;

    component gtHighest[n];
    component gtSecond[n];
    component muxH[n];
    component muxS[n];
    component muxS2[n];

    signal candidateBase[n];
    signal notGtHighest[n];
    signal shouldUpdateSecond[n];

    for (var i = 0; i < n; i++) {
        gtHighest[i] = GreaterThan(252);
        gtHighest[i].in[0] <== bidValues[i];
        gtHighest[i].in[1] <== highest[i];

        muxH[i] = Mux1();
        muxH[i].c[0] <== highest[i];
        muxH[i].c[1] <== bidValues[i];
        muxH[i].s <== gtHighest[i].out;
        highest[i + 1] <== muxH[i].out;

        gtSecond[i] = GreaterThan(252);
        gtSecond[i].in[0] <== bidValues[i];
        gtSecond[i].in[1] <== secondHighest[i];

        muxS[i] = Mux1();
        muxS[i].c[0] <== secondHighest[i];
        muxS[i].c[1] <== highest[i];
        muxS[i].s <== gtHighest[i].out;
        candidateBase[i] <== muxS[i].out;

        notGtHighest[i] <== 1 - gtHighest[i].out;
        shouldUpdateSecond[i] <== notGtHighest[i] * gtSecond[i].out;

        muxS2[i] = Mux1();
        muxS2[i].c[0] <== candidateBase[i];
        muxS2[i].c[1] <== bidValues[i];
        muxS2[i].s <== shouldUpdateSecond[i];
        secondHighest[i + 1] <== muxS2[i].out;
    }

    // ═══════════════ 3. Verify winner index ═══════════════
    signal winnerBidCheck[n];
    signal isWinnerIdx[n];
    component winnerIdxCheck[n];
    signal partialSum[n + 1];
    partialSum[0] <== 0;

    for (var i = 0; i < n; i++) {
        winnerIdxCheck[i] = IsEqual();
        winnerIdxCheck[i].in[0] <== i;
        winnerIdxCheck[i].in[1] <== declaredWinnerIdx;
        isWinnerIdx[i] <== winnerIdxCheck[i].out;
        winnerBidCheck[i] <== isWinnerIdx[i] * bidValues[i];
        partialSum[i + 1] <== partialSum[i] + winnerBidCheck[i];
    }

    partialSum[n] === highest[n];

    // ═══════════════ 4. Verify second price ═══════════════
    component isZeroSecond = IsZero();
    isZeroSecond.in <== secondHighest[n];

    component muxFinalSecond = Mux1();
    muxFinalSecond.c[0] <== secondHighest[n];
    muxFinalSecond.c[1] <== reservePrice;
    muxFinalSecond.s <== isZeroSecond.out;

    signal computedSecondPrice;
    computedSecondPrice <== muxFinalSecond.out;

    declaredSecondPrice === computedSecondPrice;
}

component main {public [commitHashes, numActiveBidders, declaredWinnerIdx, declaredSecondPrice, reservePrice]} = VickreyAuction(4);

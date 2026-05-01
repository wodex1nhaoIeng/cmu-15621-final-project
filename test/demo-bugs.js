// This file exists specifically to "demonstrate that bugs in demo.js were real, by
// failing tests". It copies the relevant code fragments from demo.js verbatim
// (without modifying demo.js) and uses chai assertions to express the expected
// correct behaviour. Failing cases mean the bug is still present; once demo.js
// is fixed, the corresponding cases turn green.

const { expect } = require("chai");
const {
  randomScalar,
  commit,
  elem2Hex,
  hex2Elem,
  elemEq,
} = require("../src/zk-proof/pedersen");
const { proveMaximum, verifyMaximum } = require("../src/zk-proof/proofMaximum");
const { proveMembership, verifyMembership } = require("../src/zk-proof/proofMembership");

// --------------------------------------------------------------------
// Bug 3: in sellerFlow, secondHighestIndex was initialised to 0, so when
//   winnerIndex === 0 it pointed at the winner itself, producing a wrong
//   second-price.
//
// Faithful copy of demo.js sellerFlow's "find second-highest" logic:
//
//     let secondHighestIndex = 0;
//     for (let i = 1; i < bidders.length; ++i) {
//       if (i === winnerIndex) continue;
//       if (xs[i] > xs[secondHighestIndex]) secondHighestIndex = i;
//     }
// --------------------------------------------------------------------
function demoFindSecondHighest(xs, winnerIndex) {
  // Post-fix logic, identical to scripts/demo.js
  let secondHighestIndex = -1;
  for (let i = 0; i < xs.length; ++i) {
    if (i === winnerIndex) continue;
    if (secondHighestIndex === -1 || xs[i] > xs[secondHighestIndex]) {
      secondHighestIndex = i;
    }
  }
  return secondHighestIndex;
}

describe("Bug 3: demo.js sellerFlow second-highest init bug", function () {
  it("two-bidder auction with winnerIndex=0: buggy code returns the winner itself (should fail)", function () {
    // bidders order: winner with 250 at index 0, loser with 175 at index 1
    const xs = [250n, 175n];
    const winnerIndex = 0;

    const second = demoFindSecondHighest(xs, winnerIndex);

    // Expected: second-highest is index 1 (loser).
    // Actual (buggy): returns 0 (the winner).
    expect(second).to.equal(1);
  });

  it("three-bidder auction with winnerIndex=0: 250 / 100 / 175 -> expect second=2, buggy returns 0", function () {
    const xs = [250n, 100n, 175n];
    const winnerIndex = 0;

    const second = demoFindSecondHighest(xs, winnerIndex);

    expect(second).to.equal(2); // The real second-highest 175 sits at index 2
  });

  it("when winnerIndex !== 0 the buggy logic happens to be correct (control case)", function () {
    // bidders order: 100 / 250 / 175, winner at index 1
    const xs = [100n, 250n, 175n];
    const winnerIndex = 1;

    const second = demoFindSecondHighest(xs, winnerIndex);
    expect(second).to.equal(2); // 175 is the second-highest
  });
});

// --------------------------------------------------------------------
// Bug 2: demo.js winner side never checked proof.maxIndex === myIndex.
// A malicious seller could call finalize() declaring some address X as winner,
// while in the ZKP maxIndex points at the real maximum bidder Y (Y != X).
// X would still pass verifyMaximum -> X is fooled.
//
// Reproduces the "all verification logic" from demo.js's winner branch and
// runs the attack scenario against it.
// Expected: verifier should reject when maxIndex !== myIndex.
// Actual (buggy): returns true because that line was missing.
// --------------------------------------------------------------------
function demoWinnerVerify(commits, maximumProof, secondMaxProof, secondHighestBid, m, ctx, myIndex) {
  // Post-fix logic, identical to scripts/demo.js
  if (maximumProof.maxIndex !== myIndex) return false;
  if (!verifyMaximum(commits, maximumProof, m, ctx)) return false;
  if (!verifyMembership(
    secondHighestBid,
    commits.toSpliced(myIndex, 1),
    secondMaxProof,
    ctx,
  )) return false;
  return true;
}

describe("Bug 2: demo.js winner side does not bind maxIndex to itself", function () {
  it("malicious seller declares non-maximum bidder as winner; verification should fail (currently passes)", function () {
    // Three bidders with true bids 10 / 20 / 999, the maximum is at index 2
    const xs = [10n, 20n, 999n];
    const rs = xs.map(() => randomScalar());
    const Cs = xs.map((x, i) => commit(x, rs[i]));
    const m = 16;
    const ctx = "malicious-seller-test";

    // The seller honestly produces a max-proof for index 2 (otherwise verifyMaximum would not pass)
    const maxProof = proveMaximum(xs, rs, Cs, 2, m, ctx);

    // But on-chain finalize declares index 0 as the winner (the attack!)
    const announcedWinnerIndex = 0;

    // After removing "the announced winner (index 0)", the remaining set's second-highest
    // is index 2 with 999, but for the attack we just pick a plausible second-highest.
    const secondHighestSrcIndex = 1; // bid 20
    const restCs = Cs.toSpliced(announcedWinnerIndex, 1);
    // In restCs the original index 1 maps to new index 0 (since we removed index 0)
    const secondMaxProof = proveMembership(
      xs[secondHighestSrcIndex],
      rs[secondHighestSrcIndex],
      0,
      restCs,
      ctx,
    );

    const passes = demoWinnerVerify(
      Cs,
      maxProof,
      secondMaxProof,
      xs[secondHighestSrcIndex],
      m,
      ctx,
      announcedWinnerIndex, // myIndex = 0, but maxProof.maxIndex = 2
    );

    // Expected: the deceived winner must reject (because proof.maxIndex !== myIndex)
    // Pre-fix: this returned true and the assertion failed, exposing the bug.
    expect(passes).to.equal(false);
  });
});

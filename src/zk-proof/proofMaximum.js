const {
  G,
  modQ,
  elemSub,
  elemScalarMul,
} = require("./pedersen");

const {
  proveDlog,
  verifyDlog,
  proveRange,
  verifyRange,
} = require("./sigma");

/**
 * Given a list of `C`'s and a special index j, proof of knowledge of a list of
 * `x`'s and `r`'s s.t. `x_j` is the greatest one among `x`'s,
 * and for each index `i`:
 * - `C_i = commit(x_i, r_i)`, i.e., `x_i G + r_i H`;
 * - `x_i < 2^m`.
 *
 * Equivalently, we prove the knowledge of `x_j` and `r_j`;
 * for other index `i`, we prove the knowledge of `y_i` and `s_i` s.t.
 * `C_j - C_i = y_i G + s_i H` where `0 <= y_i < 2^m`.
 * 
 * @param {Array<BigInt>} xs a list of `x`'s
 * @param {Array<BigInt>} rs a list of `r`'s
 * @param {Array<*>} Cs a list of `C`'s
 * @param {number} maxIndex 
 * @param {number} m 
 * @param {string} ctx 
 * @returns 
 */
function proveMaximum(xs, rs, Cs, maxIndex, m, ctx) {
  const xMax = xs[maxIndex];
  const rMax = rs[maxIndex];

  // Prove C_j - x_j G = r_j H.
  const Y = elemSub(Cs[maxIndex], elemScalarMul(G, xMax));
  const openProof = proveDlog(Y, rMax, `${ctx}:open-max`);

  const rangeProofs = [];

  for (let i = 0; i < Cs.length; i++) {
    if (i === maxIndex) continue;

    const d = BigInt(xs[maxIndex]) - BigInt(xs[i]);
    if (d < 0n) {
      throw new Error("chosen index is not maximum");
    }

    const s = modQ(rs[maxIndex] - rs[i]);

    // D_i = C_max - C_i = yG + sH.
    const D = elemSub(Cs[maxIndex], Cs[i]);

    rangeProofs.push({index: i, proof: proveRange(D, d, s, m, `${ctx}:max:${i}`)});
  }

  return {
    xMax,
    maxIndex,
    openProof,
    rangeProofs,
  };
}

function verifyMaximum(Cs, proof, m, ctx) {
  const { xMax, maxIndex, openProof, rangeProofs } = proof;

  const Y = elemSub(Cs[maxIndex], elemScalarMul(G, xMax)); 

  if (!verifyDlog(Y, openProof, `${ctx}:open-max`)) {
    return false;
  }

  const seen = new Set();

  for (const item of rangeProofs) {
    const i = item.index;

    if (i === maxIndex) return false;
    if (i < 0 || i >= Cs.length) return false;
    if (seen.has(i)) return false;

    seen.add(i);

    const D = elemSub(Cs[maxIndex], Cs[i]);

    if (!verifyRange(D, item.proof, m, `${ctx}:max:${i}`)) {
      return false;
    }
  }

  return seen.size === Cs.length - 1;
}

module.exports = {
  proveMaximum,
  verifyMaximum,
};
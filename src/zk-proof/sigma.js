const {
  H,
  G,
  ZERO,
  modQ,
  commit,
  randomScalar,
  hashToScalar,
  elemScalarMul,
  elemAdd,
  elemEq,
  elemSub,
  q,
} = require("./pedersen");

function dlogHash(Y, A, ctx) {
  return hashToScalar("dlog", ctx, Y, A);
}

/**
 * Schnorr proof of knowledge of w such that Y = wH. Non-interactive version.
 * 
 * Prover chooses random scalar `a` from the group, and computes `A=aH`.
 * Prover creates a "random" challenge `c` themselves,
 * and computes `z=a+cw mod q`.
 * 
 * `zH = (a+cw)H = aH + cwH = A + cY`.
 * Without knowing `w`, it is impossible to calculate `x` s.t. `xH = A+cY`,
 * as `x` is the log base `H` of `A+cY` in the group.
 * 
 * @param {*} Y Power
 * @param {bigint} w Witness
 * @param {string} ctx 
 * @returns `A` and `z` as the proof
 */
function proveDlog(Y, w, ctx = "") {
  const a = randomScalar();
  const A = elemScalarMul(H, a);

  const c = dlogHash(Y, A, ctx);
  const z = modQ(a + c * w);

  return { A, z };
}

function verifyDlog(Y, proof, ctx = "") {
  const { A, z } = proof;
  const c = dlogHash(Y, A, ctx);

  const lhs = elemScalarMul(H, z);
  const rhs = elemAdd(A, elemScalarMul(Y, c));

  return elemEq(lhs, rhs);
}

function orDlogHash(Ys, As, ctx) {
  return hashToScalar("or-dlog", ctx, ...Ys, ...As);
}

/**
 * Given Y_1, Y_2, ... Y_k, prove knowledge of w for one Y_i = wH.
 * 
 * Assume that the real index is `j`.
 * For the real branch, the prover randomly chooses `a` from the group,
 * and calculates `A_j=aH`.
 * For each fake branch `i`, the prover randomly chooses `c_i` and `z_i`
 * from the group, and calculate `A_i = z_i H - c_i Y_i`.
 * 
 * Prover creates a "random" challenge `c` themselves. Here,
 * `c_j = c - (c_1 + c_2 + ... + c_k)`, and `z_j = a + c_j w`.
 * The proof is all `A`'s, `c`'s and `z`'s.
 * 
 * For the real branch, `z_j H = (a + c_j w) H = a H + c_j w H = A_j + c_j Y`.
 * 
 * @param {Array<*>} Ys 
 * @param {number} realIndex 
 * @param {bigint} w 
 * @param {string} ctx 
 * @returns 
 */
function proveOrDlog(Ys, realIndex, w, ctx = "") {
  realIndex = Number(realIndex);
  if (!Number.isInteger(realIndex) || realIndex < 0 || realIndex >= Ys.length) {
    throw new Error("invalid realIndex");
  }

  const k = Ys.length;

  const As = new Array(k);
  const c = new Array(k);
  const z = new Array(k);

  let cSum = 0n;

  for (let i = 0; i < k; i++) {
    if (i === realIndex) continue;

    c[i] = randomScalar();
    z[i] = randomScalar();

    // A_i = z_i H - c_i Y_i
    As[i] = elemSub(elemScalarMul(H, z[i]), elemScalarMul(Ys[i], c[i]));

    cSum = modQ(cSum + c[i]);
  }

  const a = randomScalar();
  As[realIndex] = elemScalarMul(H, a);

  const globalC = orDlogHash(Ys, As, ctx);

  c[realIndex] = modQ(globalC - cSum);
  z[realIndex] = modQ(a + c[realIndex] * w);

  return { As, c, z };
}

function verifyOrDlog(Ys, proof, ctx = "") {
  const { As, c, z } = proof;

  const globalC = orDlogHash(Ys, As, ctx);

  let cSum = 0n;

  for (let i = 0; i < Ys.length; i++) {
    cSum = modQ(cSum + c[i]);

    const lhs = elemScalarMul(H, z[i]);
    const rhs = elemAdd(As[i], elemScalarMul(Ys[i], c[i]));

    if (!elemEq(lhs, rhs)) {
      return false;
    }
  }

  return cSum === globalC;
}

/**
 * Given `B`, proof of knowledge of `w` such that `B = wH` or `B = G + wH`.
 * 
 * Equivalently, proof of knowledge of `b` in {0, 1} 
 * and `w` s.t. `B = bG + wH`.
 */
function proveBit(B, b, w, ctx = "") {
  const Y0 = B;
  const Y1 = elemSub(B, G);

  return proveOrDlog([Y0, Y1], (b), w, ctx);
}

function verifyBit(B, proof, ctx = "") {
  const Y0 = B;
  const Y1 = elemSub(B, G);

  return verifyOrDlog([Y0, Y1], proof, ctx);
}

/**
 * Given `D`, proof of knowledge of `d` in [0, 2^m) and `w` s.t. `D = dG + wH`.
 * 
 * We do not need to run the OR proof in 2^m numbers. Just prove bits of `d`.
 * 
 * Assume that `d = b_0 + b_1 * 2 + b_2 * 4 + ... + b_{m-1} * 2 ^ {m-1}`.
 * Prover randomly chooses `t_0`, `t_1`, and `t_{m-1}`, and shows proof of
 * knowledge of
 * - `b` in {0, 1} and `t` s.t. `B_i = bG + tH`, where `B_i` is `b_i G + t_i H`;
 * - `x` s.t. D - (B_0 + B_1 * 2 + ... + B_{m-1} * 2 ^ {m-1}) = x H.
 * 
 * @param {*} D
 * @param {*} d
 * @param {*} w 
 * @param {number} m 
 * @param {string} ctx 
 * @returns 
 */
function proveRange(D, d, w, m, ctx = "") {
  if (1n << BigInt(m) >= q) {
    throw Error(`m = ${m} is too large.`);
  }
  const Bs = [];
  const bitProofs = [];

  let weightedCommitment = ZERO;
  let weightedBlind = 0n;

  for (let j = 0; j < m; j++) {
    const bit = (BigInt(d) >> BigInt(j)) & 1n;
    const t = randomScalar();

    const B = commit(bit, t);
    Bs.push(B);

    bitProofs.push(proveBit(B, bit, t, `${ctx}:bit:${j}`));

    const weight = 1n << BigInt(j);

    weightedCommitment = elemAdd(weightedCommitment, elemScalarMul(B, weight));
    weightedBlind = modQ(weightedBlind + weight * t);
  }

  // E = D - sum 2^j B_j = (w - sum 2^j t_j)H
  const E = elemSub(D, weightedCommitment);
  const u = modQ(w - weightedBlind);

  const eqProof = proveDlog(E, u, `${ctx}:eq`);

  return { Bs, bitProofs, eqProof };
}

function verifyRange(D, proof, m, ctx = "") {
  const { Bs, bitProofs, eqProof } = proof;

  if (Bs.length !== m || bitProofs.length !== m) return false;

  let weightedCommitment = ZERO;

  for (let j = 0; j < m; j++) {
    if (!verifyBit(Bs[j], bitProofs[j], `${ctx}:bit:${j}`)) {
      return false;
    }

    const weight = 1n << BigInt(j);
    weightedCommitment = elemAdd(
      weightedCommitment, 
      elemScalarMul(Bs[j], weight)
    );
  }

  const E = elemSub(D, weightedCommitment);

  return verifyDlog(E, eqProof, `${ctx}:eq`);
}

module.exports = {
  proveDlog,
  verifyDlog,
  proveOrDlog,
  verifyOrDlog,
  proveBit,
  verifyBit,
  proveRange,
  verifyRange,
};
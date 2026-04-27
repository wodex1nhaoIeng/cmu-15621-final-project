const {
  G,
  elemSub,
  elemScalarMul,
} = require("./pedersen");

const {
  proveOrDlog,
  verifyOrDlog,
} = require("./sigma");

// Prove public x is one of the committed values,
// without revealing which index.
/**
 * Given a list of `C`'s, proof of knowledge of `x`, `r`
 * and a special index `i` s.t.`C_i = commit(x, r)`.
 * 
 * @param {bigint} x
 * @param {bigint} r
 * @param {number} index
 * @param {Array<*>} Cs 
 */
function proveMembership(x, r, index, Cs, ctx) {
  // Y_i = C_i - xG.
  // If x_i = x, then Y_i = r_i H.
  const Ys = Cs.map(C => elemSub(C, elemScalarMul(G, x)));

  return proveOrDlog(Ys, index, r, `${ctx}:membership`);
}

function verifyMembership(x, Cs, membershipProof, ctx) {
  const Ys = Cs.map(C => elemSub(C, elemScalarMul(G, x)));

  return verifyOrDlog(Ys, membershipProof, `${ctx}:membership`);
}

module.exports = {
  proveMembership,
  verifyMembership,
};
const { expect } = require("chai");
const {
  elemEq, elemAdd, randomScalar, commit, modQ
} = require("../../src/zk-proof/pedersen");

describe("Pedersen Commitment", function () {
  it("Pedersen commitments should be homomorphism", function () {
    const x1 = 10n;
    const x2 = 7n;
    const r1 = randomScalar();
    const r2 = randomScalar();

    const C1 = commit(x1, r1);
    const C2 = commit(x2, r2);

    const lhs = elemAdd(C1, C2);
    const rhs = commit(x1 + x2, r1 + r2);
    const rhs2 = commit(x1 + x2 + 1n, r1 + r2);

    expect(elemEq(lhs, rhs)).to.be.true;
    expect(elemEq(lhs, rhs2)).to.be.false;
  })
})
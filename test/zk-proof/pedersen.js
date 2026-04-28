const { expect } = require("chai");
const {
  elemEq, elemAdd, randomScalar, commit, G,
  elem2Hex,
  hex2Elem,
  elemScalarMul
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
  });

  it("Conversion between group elements and hex strings", function () {
    const x = elemScalarMul(G, randomScalar());
    const y = elemAdd(G, x);
    const h = elem2Hex(x);
    console.log(`h: 0x${h.substring(0, 16)}...`);

    expect(elemEq(x, hex2Elem(h))).to.be.true;
    expect(elemEq(y, hex2Elem(h))).to.be.false;
  });
})
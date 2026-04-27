const { expect } = require("chai");
const { randomScalar, commit } = require("../../src/zk-proof/pedersen");
const { proveMaximum, verifyMaximum } = require("../../src/zk-proof/proofMaximum");

describe("Proof a secret number is the maximum one", function () {
  const num = 5;
  const m = 16;
  const xs = [];
  const rs = [];
  const Cs = [];
  let maxIndex = 0;
  for (let i = 0; i < num; ++i) {
    const x = randomScalar() % BigInt(1 << m);
    const r = randomScalar();
    const c = commit(x, r);
    xs.push(x);
    rs.push(r);
    Cs.push(c);

    if (x > xs[maxIndex]) {
      maxIndex = i;
    }
  }
  const ctx = "max-test";

  it ("Correct Proof", function() {
    const proof = proveMaximum(xs, rs, Cs, maxIndex, m, ctx);

    expect(verifyMaximum(Cs, proof, m, ctx)).to.be.true;
  });

  it ("Incorrect Proof", function() {
    const proof = proveMaximum(Array(num).fill(0n), rs, Cs, maxIndex, m, ctx);

    expect(verifyMaximum(Cs, proof, m, ctx)).to.be.false;
  });
});
const { expect } = require("chai");
const { randomScalar, commit } = require("../../src/zk-proof/pedersen");
const { proveMembership, verifyMembership } = require("../../src/zk-proof/proofMembership");

describe("Proof membership of a secret number", function () {
  const num = 7;
  const xs = [];
  const rs = [];
  const Cs = [];
  let index = 0;
  for (let i = 0; i < num; ++i) {
    const x = randomScalar();
    const r = randomScalar();
    const c = commit(x, r);
    xs.push(x);
    rs.push(r);
    Cs.push(c);
  }
  const ctx = "membership-test";

  it ("Correct Proof", function() {
    const proof = proveMembership(xs[index], rs[index], index, Cs, ctx);

    expect(verifyMembership(xs[index], Cs, proof, ctx)).to.be.true;
  });

  it ("Incorrect Proof", function() {
    const proof = proveMembership(1n, rs[index], index, Cs, ctx);

    expect(verifyMembership(xs[index], Cs, proof, ctx)).to.be.false;
  });
});
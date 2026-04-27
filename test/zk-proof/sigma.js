const { expect } = require("chai");
const { randomScalar, H, elemScalarMul, commit } = require("../../src/zk-proof/pedersen");
const {
  proveDlog,
  verifyDlog,
  proveOrDlog,
  verifyOrDlog,
  proveBit,
  verifyBit,
  proveRange,
  verifyRange
} = require("../../src/zk-proof/sigma");

describe("Descret Log Proof of Knowledge of Witness", function () {
  const w = randomScalar();
  const Y = elemScalarMul(H, w);
  const ctx = "test-dlog";

  it("Correct Proof", function () {
    const proof = proveDlog(Y, w, ctx);
    expect(verifyDlog(Y, proof, ctx)).to.be.true;
  });

  it("Incorrect Proof", function () {
    const proof = proveDlog(Y, randomScalar(), ctx);
    expect(verifyDlog(Y, proof, ctx)).to.be.false;
  });
});

describe("Proof of Or", function () {
  const secrets = [
    randomScalar(),
    randomScalar(),
    randomScalar(),
  ];
  const ctx = "test-or";
  const Ys = secrets.map(w => elemScalarMul(H, w));
  const realIndex = 1;

  it("Correct Proof", function () {
    const proof = proveOrDlog(Ys, realIndex, secrets[realIndex], ctx);

    expect(
      verifyOrDlog(Ys, proof, ctx)
    ).to.be.true;
  });

  it("Incorrect Proof", function () {
    const proof = proveOrDlog(Ys, realIndex, 0n, ctx);

    expect(
      verifyOrDlog(Ys, proof, ctx)
    ).to.be.false;
  });
});

describe("Proof of 0 or 1", function () {
  for (const b of [0n, 1n]) {
    const w = randomScalar();
    const B = commit(b, w);
    const ctx = `bit-${b}`;

    it(`Correct Proof of ${b}`, function () {
      const proof = proveBit(B, b, w, ctx);

      expect(
        verifyBit(B, proof, ctx)
      ).to.be.true;
    });

    it(`Incorrect Proof of ${b}`, function () {
      const proof = proveBit(B, b, 0n, ctx);

      expect(
        verifyBit(B, proof, ctx)
      ).to.be.false;
    });
  }
})

describe("Proof of Range", function () {
  const m = 16;
  const d = 12345n;
  const w = randomScalar();
  const D = commit(d, w);

  it("Correct Proof", function () {
    const proof = proveRange(D, d, w, m, "range-test");

    expect(verifyRange(D, proof, m, "range-test")).to.be.true;
  });

  it("Incorrect Proof", function () {
    const proof = proveRange(D, d, 0n, m, "range-test");

    expect(verifyRange(D, proof, m, "range-test")).to.be.false;
  });
});
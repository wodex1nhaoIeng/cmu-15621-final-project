const crypto = require("crypto");
const { secp256k1 } = require("@noble/curves/secp256k1");

/**
 * Generate a random `bigint` between 0 and `q`, exclusive.
 */
function randomScalar() {
  while (true) {
    const x = modQ("0x" + crypto.randomBytes(32).toString("hex"));
    if (x !== 0n) return x;
  }
}

const Point = secp256k1.ProjectivePoint;

/**
 * Generator of the group
 */
const G = Point.BASE;

/**
 * Identity of the group.
 */
const ZERO = Point.ZERO;

/**
 * Order of the group
 */
const q = secp256k1.CURVE.n;

// Derive H from G using hash-to-scalar.
// For production, prefer a standard hash-to-curve method.
const H_SCALAR = hashToScalar("internal-pedersen-generator-H");
/**
 * A pseudo-random element in the group
 */
const H = G.multiply(H_SCALAR);


function modQ(x) {
  const r = BigInt(x) % q;
  return r >= 0n ? r : r + q;
}

/**
 * Add 2 element in the group generated from G.
 */
function elemAdd(A, B) {
  return A.add(B);
}

function elemSub(A, B) {
  return A.add(B.negate());
}

function elemScalarMul(P, s) {
  if (modQ(s) === 0n) {
    return Point.ZERO;
  }
  return P.multiply(modQ(s));
}

function elemEq(A, B) {
  return A.equals(B);
}

/**
 * Compute hash value in the group of a list of items
 */
function hashToScalar(...items) {
  const h = crypto.createHash("sha256");
  for (const item of items) {
    if (typeof item === "bigint") {
      h.update(item.toString(16));
    } else if (item && typeof item.toHex === "function") {
      h.update(item.toHex());
    } else {
      h.update(String(item));
    }
    h.update(Buffer.from([0]));
  }
  return modQ(BigInt("0x" + h.digest("hex")));
}

function commit(x, r) {
  return elemAdd(elemScalarMul(G, x), elemScalarMul(H, r));
}

module.exports = {
  Point,
  G,
  H,
  q,
  ZERO,
  modQ,
  randomScalar,
  hashToScalar,
  commit,
  elemAdd,
  elemSub,
  elemScalarMul,
  elemEq,
};
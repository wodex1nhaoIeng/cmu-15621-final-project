// ============================================================
// Vickrey auction end-to-end demo: 4 actors on a single Hardhat node
//   3 bidders (bids: 100 / 250 / 175) + 1 seller
// On-chain : contract commit / finalize / read commits[] / bidders[]
// Off-chain (simulated): reveal, ZKP delivery, ZKP verification
//                        all routed through an in-process EventEmitter
// ============================================================

const { ethers } = require("hardhat");

// In-house zero-knowledge tooling:
//   pedersen.js        — secp256k1 wrapper + Pedersen commitment c = v*G + r*H
//   proofMaximum.js    — proves "my commitment opens to the largest value in this set"
//   proofMembership.js — proves "public x equals the opening of some commitment in this set"
//                        (without revealing which one)
const {
  elemEq, elemAdd, randomScalar, commit, G,
  elem2Hex,   // serialize a curve point to a compressed hex string (contract stores it as `string`)
  hex2Elem,   // deserialize hex back to a curve point
  elemScalarMul
} = require("../src/zk-proof/pedersen");
const { proveMaximum, verifyMaximum } = require("../src/zk-proof/proofMaximum");
const { proveMembership, verifyMembership } = require("../src/zk-proof/proofMembership");

// Node's built-in event bus.
// We use it as an "off-chain private channel" to simulate:
//   - bidder -> seller : reveal of (bidAmount, nonce)
//   - seller -> winner : the two ZK proofs and the second-price
// In production this would be replaced by:
//   - bidders encrypting their reveal under the seller's public key and posting on-chain (Phase 2)
//   - ZK proofs being submitted to the contract and verified on-chain
const EventEmitter = require('events');
const offchainBus = new EventEmitter();

// ------------------------------------------------------------
// EVM time-travel helpers (Hardhat-only)
//   On a real chain we cannot fast-forward; here we use RPCs to
//   advance the local node's block.timestamp.
// ------------------------------------------------------------
async function mineBlock(seconds = 5) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine");
}

// Repeatedly bump the chain clock by 10s until the contract reports
// that the commit phase is over.
async function waitUntilCommitDue(auction, name) {
  while (!(await auction.commitDue())) {
    console.log(`${name}: deadline not due yet; waiting...`);
    await mineBlock(10);
  }

  console.log(`${name}: deadline is due;`);
}

// ------------------------------------------------------------
// "wait-for-X" helpers: each returns a Promise that the caller awaits.
// ------------------------------------------------------------

// seller side: wait until `num` reveals have arrived on the off-chain bus.
async function waitForAllReveals(num) {
  if (num <= 0) {
    return [];
  }

  return new Promise((resolve) => {
    const reveals = [];

    function handler(reveal) {
      reveals.push(reveal);
      if (reveals.length === num) {
        offchainBus.off("seller:reveal", handler);
        resolve(reveals);   // resolve only after collecting `num` of them
      }
    }

    offchainBus.on("seller:reveal", handler);
  });
}

// winner-side: wait for the seller's private message containing the two ZK proofs and second-price.
function waitForSellerMessage(bidder, name) {
  return new Promise((resolve) => {
    offchainBus.once(`message:${bidder.address}`, (message) => {
      console.log(`${name}: received private seller message`);
      resolve(message);
    });
  });
}

// every bidder: wait for the on-chain `AuctionFinalized` event to learn the winner's address.
async function waitForAuctionFinalized(auction) {
  return new Promise((resolve) => {
    auction.once("AuctionFinalized", (winnerAddress) => {
      resolve(winnerAddress);
    });
  });
}

// bidder -> seller : push (bidAmount, nonce) onto the off-chain bus.
function sendRevealToSeller(reveal) {
  offchainBus.emit("seller:reveal", reveal);
}

// seller -> winner : deliver the ZKP bundle to a specific address.
async function sellerSendMessageToWinner(winnerAddress, message) {
  offchainBus.emit(`message:${winnerAddress}`, message);
}

// ============================================================
// Full lifecycle of one bidder: commit -> wait for deadline -> reveal -> wait for result -> verify ZKP
// Args:
//   auction   — contract instance
//   bidder    — ethers signer (carries address / private key)
//   name      — display name, e.g. "Bidder 2"
//   bidAmount — the bidder's true bid (plaintext integer)
// ============================================================
async function bidderFlow(auction, bidder, name, bidAmount) {
  // !!! Subscribe to the seller's private message UP FRONT.
  //     EventEmitter.once only catches FUTURE events; if we subscribed
  //     after the "I won" branch the seller may have already emitted,
  //     and we would hang forever. So we register the listener before
  //     any await and only consume the Promise later.
  const sellerMessagePromise = waitForSellerMessage(bidder, name);

  // (1) Build the commitment.
  //     `nonce` is the blinding factor r (uniform on secp256k1 group order q).
  //     commitment = bidAmount * G + nonce * H is a curve point.
  const nonce = randomScalar();
  const commitment = commit(bidAmount, nonce);

  // (2) On-chain commit: serialize to compressed hex and write into commits[bidder].
  //     This is a real transaction, real gas.
  await auction.connect(bidder).commitBid(elem2Hex(commitment));
  console.log(`${name}: committed`);

  // (3) Wait until the commit phase has expired (advance Hardhat clock).
  await waitUntilCommitDue(auction, name);

  // (4) Off-chain reveal: send the plaintext (bidAmount, nonce) to the seller.
  //     NOTE: the design in the paper has bidders post a reveal encrypted under
  //     the seller's public key on-chain. We replace that with EventEmitter for the demo.
  sendRevealToSeller({
    address: bidder.address,
    bidAmount,
    nonce,
  });

  console.log(`${name}: waiting for AuctionFinalized...`);

  // (5) Wait for the on-chain finalize event and learn the winner address.
  const winnerAddress = await waitForAuctionFinalized(auction);

  if (winnerAddress === bidder.address) {
    // --- winner branch -------------------------------------------------
    console.log(`${name}: I won`);

    // (6a) Consume the previously-registered Promise (the seller may have already emitted).
    const { maximumProof, secondMaxProof, secondHighestBid } = await sellerMessagePromise;

    // (6b) Re-pull every bidder's commitment from the contract and rebuild the
    //      `commits[]` array in canonical order. `myIndex` is our slot in that array.
    const bidders = [];
    const commits = [];   // each element is a curve point
    let myIndex = -1;
    for (let i = 0; i < await auction.biddersLength(); ++i) {
      const auctionBidder = await auction.bidders(i);
      bidders.push(auctionBidder);
      commits.push(hex2Elem(await auction.commits(auctionBidder)));
      if (auctionBidder === bidder.address) {
        myIndex = i;
      }
    }

    // (6c-pre) Fix for Bug 2: assert that the proof's maxIndex really points at me.
    //     verifyMaximum only proves "Cs[proof.maxIndex] is the maximum"; it does NOT
    //     prove "the maximum commitment belongs to me". A malicious seller could
    //     submit a valid max-proof for the true maximum bidder while writing a
    //     different address as the winner in finalize(), so we MUST bind it ourselves.
    if (maximumProof.maxIndex !== myIndex) {
      throw new Error("Winner: maximumProof.maxIndex does not point to me");
    }

    // (6c) Verification 1: my (winner's) commitment really is the maximum among `commits`.
    //      32 = bit-length used by the range proof (so all bids must fit in < 2^32).
    if (!verifyMaximum(commits, maximumProof, 32, auction.address)) {
      throw new Error("Winner cannot verify that their bid is the maximum bid");
    }

    // (6d) Verification 2: the seller's published `secondHighestBid` really is the
    //      opening of SOME commitment in {commits} \ {mine}, without revealing which one.
    if (!verifyMembership(
      secondHighestBid,
      commits.toSpliced(myIndex, 1),   // remove our own commitment
      secondMaxProof,
      auction.address)
    ) {
      throw new Error("Winner cannot verify the second highest bid");
    }
    console.log(`${name}: Proofs verified`);

  } else {
    // --- loser branch --------------------------------------------------
    // Losers do nothing in this implementation. In principle they could also
    // pull and verify both proofs, but only the winner needs the second-price
    // to be honest, so the demo only verifies on the winner side.
    console.log(`${name}: I lost`);
  }
}

// ============================================================
// Full lifecycle of the seller: collect reveals -> pick winner -> on-chain finalize
//                                -> build the two ZK proofs -> deliver them to the winner
// Args:
//   auction   — contract instance
//   seller    — ethers signer
//   numbidder — number of reveals expected (3 in this demo)
// ============================================================
async function sellerFlow(auction, seller, numbidder) {
  // (1) Wait for every bidder's reveal (off-chain).
  const reveals = await waitForAllReveals(numbidder);

  // revealMap : bidder address -> reveal object { address, bidAmount, nonce }.
  // Used below to look up (v, r) for each bidder in the canonical bidders[] order.
  const revealMap = new Map();

  // (1b) Fix for Bug 4: every reveal must be consistent with the on-chain commitment;
  //      otherwise discard it.
  //      Threat model: a bidder commits commit(100, r) but reveals v=999 trying to steal
  //      the auction. Without this check, downstream proveMaximum would crash because
  //      r does not match, freezing the entire auction.
  const validReveals = [];
  for (const reveal of reveals) {
    const onchainHex = await auction.commits(reveal.address);
    if (!onchainHex || onchainHex.length === 0) continue; // never committed
    const onchainCommit = hex2Elem(onchainHex);
    const recomputed = commit(reveal.bidAmount, reveal.nonce);
    if (!elemEq(recomputed, onchainCommit)) {
      console.warn(`seller: discarding reveal from ${reveal.address} (commit mismatch)`);
      continue;
    }
    validReveals.push(reveal);
  }
  if (validReveals.length === 0) {
    throw new Error("seller: no valid reveals");
  }

  // (2) Pick the highest bidder as the winner.
  let winner = validReveals[0];
  for (const reveal of validReveals) {
    if (reveal.bidAmount > winner.bidAmount) {
      winner = reveal;
    }
    revealMap.set(reveal.address, reveal);
  }
  console.log("Winner selected:", winner.address);

  // (3) On-chain finalize: write the winner address into the contract; emits AuctionFinalized.
  await auction.connect(seller).finalize(winner.address);

  // (4) Rebuild four parallel arrays in the same order as the on-chain bidders[]:
  //       bidders[i] — address of the i-th bidder
  //       commits[i] — Pedersen commitment of the i-th bidder (curve point)
  //       xs[i]      — true bid v_i of the i-th bidder
  //       rs[i]      — blinding factor r_i of the i-th bidder
  //   Naming: the proveMaximum / proveMembership APIs use `xs` for the value vector
  //   (x_1, x_2, ...) and `rs` for the randomness vector (r_1, r_2, ...).
  const bidders = [];
  const commits = [];
  const xs = [];   // bid values
  const rs = [];   // blinding factors
  let winnerIndex = -1;   // winner's slot
  for (let i = 0; i < await auction.biddersLength(); ++i) {
    const bidder = await auction.bidders(i);
    bidders.push(bidder);
    commits.push(hex2Elem(await auction.commits(bidder)));
    if (bidder === winner.address) {
      winnerIndex = i;
    }
    xs.push(revealMap.get(bidder).bidAmount);
    rs.push(revealMap.get(bidder).nonce);
  }

  // (5) Among the bidders OTHER than the winner, find the index of the second-highest bid.
  //     (This is the price the winner must pay in a Vickrey auction.)
  //     Fix for Bug 3: linear-scan starting from -1 so it works no matter where
  //     the winner sits in the array.
  let secondHighestIndex = -1;
  for (let i = 0; i < bidders.length; ++i) {
    if (i === winnerIndex) continue;
    if (secondHighestIndex === -1 || xs[i] > xs[secondHighestIndex]) {
      secondHighestIndex = i;
    }
  }
  if (secondHighestIndex === -1) {
    throw new Error("seller: only one bidder; no second-highest price exists");
  }

  // (6) Build the two ZK proofs:
  //     maximumProof  — "the winner's commitment really is the maximum among commits[]"
  //                     needs the winner's (x, r) and the bit-length bound m = 32.
  const maximumProof = proveMaximum(
    xs, rs, commits, winnerIndex, 32, auction.address
  );
  //     secondMaxProof — "the public second-price value v really equals the opening
  //                      of SOME commitment among (commits \ winner)"
  //     The 3rd argument is the second-highest's index in the array AFTER removing
  //     the winner: subtract 1 if the original index was past the winner, else keep it.
  const secondMaxProof = proveMembership(
    xs[secondHighestIndex],
    rs[secondHighestIndex],
    secondHighestIndex > winnerIndex ? secondHighestIndex - 1 : secondHighestIndex,
    commits.toSpliced(winnerIndex, 1),
    auction.address
  );

  // (7) Deliver both proofs plus the second-price privately to the winner.
  await sellerSendMessageToWinner(winner.address, {
    maximumProof, secondMaxProof, secondHighestBid: xs[secondHighestIndex]
  });
}

// ============================================================
// Top-level driver: deploy the contract and run the four coroutines concurrently.
// ============================================================
async function main() {
  // Hardhat-prefunded local accounts; account 0 is the seller, the next 3 are bidders.
  const [seller, bidder1, bidder2, bidder3] = await ethers.getSigners();

  // Deploy the contract: "Demo Item" is a description of the lot, 60 is the commit window in seconds.
  const Auction = await ethers.getContractFactory("VickreyAuction", seller);
  const auction = await Auction.deploy("Demo Item", 60);
  await auction.waitForDeployment();

  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const commitDeadline = Number(await auction.commitDeadline());
  console.log("Auction deployed:", await auction.getAddress());
  console.log(`Commit deadline: ${commitDeadline - now} seconds later`);

  // Promise.all : light up all 4 async coroutines simultaneously; they interleave via await.
  // Their only means of coordination are:
  //   (a) the on-chain contract (commit / finalize / events)
  //   (b) the offchainBus       (reveals / private seller message)
  await Promise.all([
    bidderFlow(auction, bidder1, "Bidder 1", 100),
    bidderFlow(auction, bidder2, "Bidder 2", 250),   // expected winner
    bidderFlow(auction, bidder3, "Bidder 3", 175),   // expected second-price
    sellerFlow(auction, seller, 3)
  ]);
}

// Real entry point: when this file is loaded by node / hardhat run the auction kicks off here.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

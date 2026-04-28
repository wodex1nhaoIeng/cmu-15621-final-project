const { ethers } = require("hardhat");
const {
  elemEq, elemAdd, randomScalar, commit, G,
  elem2Hex,
  hex2Elem,
  elemScalarMul
} = require("../src/zk-proof/pedersen");
const { proveMaximum, verifyMaximum } = require("../src/zk-proof/proofMaximum");
const { proveMembership, verifyMembership } = require("../src/zk-proof/proofMembership");

const EventEmitter = require('events');
const offchainBus = new EventEmitter();

async function mineBlock(seconds = 5) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine");
}

async function waitUntilCommitDue(auction, name) {
  while (!(await auction.commitDue())) {
    console.log(`${name}: deadline not due yet; waiting...`);
    await mineBlock(10);
  }

  console.log(`${name}: deadline is due;`);
}

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
        resolve(reveals);
      }
    }

    offchainBus.on("seller:reveal", handler);
  });
}

function waitForSellerMessage(bidder, name) {
  return new Promise((resolve) => {
    offchainBus.once(`message:${bidder.address}`, (message) => {
      console.log(`${name}: received private seller message`);
      resolve(message);
    });
  });
}

async function waitForAuctionFinalized(auction) {
  return new Promise((resolve) => {
    auction.once("AuctionFinalized", (winnerAddress) => {
      resolve(winnerAddress);
    });
  });
}

function sendRevealToSeller(reveal) {
  offchainBus.emit("seller:reveal", reveal);
}

async function sellerSendMessageToWinner(winnerAddress, message) {
  offchainBus.emit(`message:${winnerAddress}`, message);
}

async function bidderFlow(auction, bidder, name, bidAmount) {
  const nonce = randomScalar();
  const commitment = commit(bidAmount, nonce);

  await auction.connect(bidder).commitBid(elem2Hex(commitment));
  console.log(`${name}: committed`);

  await waitUntilCommitDue(auction, name);

  sendRevealToSeller({
    address: bidder.address,
    bidAmount,
    nonce,
  });

  console.log(`${name}: waiting for AuctionFinalized...`);

  const winnerAddress = await waitForAuctionFinalized(auction);

  if (winnerAddress === bidder.address) {
    console.log(`${name}: I won`);

    const { maximumProof, secondMaxProof, secondHighestBid } = await waitForSellerMessage(bidder, name);
    const bidders = [];
    const commits = [];
    let myIndex = -1;
    for (let i = 0; i < await auction.biddersLength(); ++i) {
      const auctionBidder = await auction.bidders(i);
      bidders.push(auctionBidder);
      commits.push(hex2Elem(await auction.commits(auctionBidder)));
      if (auctionBidder === bidder.address) {
        myIndex = i;
      }
    }
    if (!verifyMaximum(commits, maximumProof, 32, auction.address)) {
      throw new Error("Winner cannot verify that their bid is the maximum bid");
    }
    if (!verifyMembership(
      secondHighestBid,
      commits.toSpliced(myIndex, 1),
      maximumProof,
      auction.address)
    ) {
      throw new Error("Winner cannot verify the second highest bid");
    }
    console.log(`${name}: Proofs verified`);

  } else {
    console.log(`${name}: I lost`);
  }
}

async function sellerFlow(auction, seller, numbidder) {
  const reveals = await waitForAllReveals(numbidder);
  const revealMap = new Map();

  let winner = reveals[0];

  for (const reveal of reveals) {
    if (reveal.bidAmount > winner.bidAmount) {
      winner = reveal;
    }
    revealMap.set(reveal.address, reveal);
  }
  console.log("Winner selected:", winner.address);

  await auction.connect(seller).finalize(winner.address);

  const bidders = [];
  const commits = [];
  const xs = [];
  const rs = [];
  let winnerIndex = -1;
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

  let secondHighestIndex = 0;
  for (let i = 1; i < bidders.length; ++i) {
    if (i === winnerIndex) {
      continue;
    }
    if (xs[i] > xs[secondHighestIndex]) {
      secondHighestIndex = i;
    }
  }

  const maximumProof = proveMaximum(
    xs, rs, commits, winnerIndex, 32, auction.address
  );
  const secondMaxProof = proveMembership(
    xs[secondHighestIndex],
    rs[secondHighestIndex],
    secondHighestIndex > winnerIndex ? secondHighestIndex - 1 : secondHighestIndex,
    commits.toSpliced(winnerIndex, 1),
    auction.address
  );
  await sellerSendMessageToWinner(winner.address, {
    maximumProof, secondMaxProof, secondHighestBid: xs[secondHighestIndex]
  });
}

async function main() {
  const [seller, bidder1, bidder2, bidder3] = await ethers.getSigners();

  const Auction = await ethers.getContractFactory("VickreyAuction", seller);
  const auction = await Auction.deploy("Demo Item", 60);
  await auction.waitForDeployment();
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const commitDeadline = Number(await auction.commitDeadline());
  console.log("Auction deployed:", await auction.getAddress());
  console.log(`Commit deadline: ${commitDeadline - now} seconds later`);

  await Promise.all([
    bidderFlow(auction, bidder1, "Bidder 1", 100),
    bidderFlow(auction, bidder2, "Bidder 2", 250),
    bidderFlow(auction, bidder3, "Bidder 3", 175),
    sellerFlow(auction, seller, 3)
  ]);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
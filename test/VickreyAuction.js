const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("VickreyAuction", function () {
  let Auction, auction;
  let seller, bidder1, bidder2, outsider;

  const item = "Rare painting";
  const commitDuration = 30;
  const commit1 = "hash-bid-1";
  const commit2 = "hash-bid-2";

  beforeEach(async function () {
    [seller, bidder1, bidder2, outsider] = await ethers.getSigners();

    Auction = await ethers.getContractFactory("VickreyAuction", seller);
    auction = await Auction.deploy(item, commitDuration);
    await auction.waitForDeployment();
  });

  it("sets constructor state correctly", async function () {
    expect(await auction.seller()).to.equal(seller.address);
    expect(await auction.itemDescription()).to.equal(item);
    expect(await auction.finalized()).to.equal(false);
  });

  it("rejects zero commit duration", async function () {
    await expect(
      Auction.deploy(item, 0)
    ).to.be.reverted;
  });

  it("allows bidders to commit before deadline", async function () {
    await expect(auction.connect(bidder1).commitBid(commit1))
      .to.emit(auction, "BidCommitted")
      .withArgs(bidder1.address, commit1);

    expect(await auction.commits(bidder1.address)).to.equal(commit1);
  });

  it("allows bidders to overwrite commitment before deadline", async function () {
    await expect(auction.connect(bidder1).commitBid(commit1))
      .to.emit(auction, "BidCommitted")
      .withArgs(bidder1.address, commit1);

    await expect(auction.connect(bidder1).commitBid(commit2))
      .to.emit(auction, "BidCommitted")
      .withArgs(bidder1.address, commit2);

    expect(await auction.commits(bidder1.address)).to.equal(commit2);
    expect(await auction.biddersLength()).to.equal(1);
    expect(await auction.bidders(0)).to.equal(bidder1.address);
  });

  it("rejects commits after deadline", async function () {
    const deadline = await auction.commitDeadline();

    await ethers.provider.send("evm_setNextBlockTimestamp", [
      Number(deadline) + 1,
    ]);
    await ethers.provider.send("evm_mine");

    await expect(
      auction.connect(bidder1).commitBid("late-commit")
    ).to.be.reverted;

    expect(await auction.commitDue()).to.equal(true);
  });

  it("allows only seller to finalize", async function () {
    await expect(
      auction.connect(outsider).finalize(bidder1.address)
    ).to.be.reverted;
  });

  it("seller can finalize and set winner", async function () {
    await expect(auction.connect(seller).finalize(bidder1.address))
      .to.emit(auction, "AuctionFinalized")
      .withArgs(bidder1.address);

    expect(await auction.finalized()).to.equal(true);
    expect(await auction.winner()).to.equal(bidder1.address);
  });

  it("commitDue returns false before deadline", async function () {
    expect(await auction.commitDue()).to.be.false;
  });
});
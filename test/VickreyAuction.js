const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("VickreyAuction", function () {
    // Durations in seconds
    const COMMIT_DURATION = 3600;  // 1 hour
    const REVEAL_DURATION = 3600;  // 1 hour
    const RESERVE_PRICE = ethers.parseEther("1"); // 1 ETH

    let auction;
    let seller, bidder1, bidder2, bidder3;

    // Helper: compute commit hash matching the Solidity logic
    function computeHash(bidValue, nonce) {
        return ethers.solidityPackedKeccak256(
            ["uint256", "bytes32"],
            [bidValue, nonce]
        );
    }

    // Helper: random nonce
    function randomNonce() {
        return ethers.hexlify(ethers.randomBytes(32));
    }

    beforeEach(async function () {
        [seller, bidder1, bidder2, bidder3] = await ethers.getSigners();

        const VickreyAuction = await ethers.getContractFactory("VickreyAuction");
        auction = await VickreyAuction.deploy(
            "Rare Digital Art #42",
            RESERVE_PRICE,
            COMMIT_DURATION,
            REVEAL_DURATION
        );
    });

    // ─────────────────── Deployment ───────────────────
    describe("Deployment", function () {
        it("should set the seller correctly", async function () {
            expect(await auction.seller()).to.equal(seller.address);
        });

        it("should set item description and reserve price", async function () {
            expect(await auction.itemDescription()).to.equal("Rare Digital Art #42");
            expect(await auction.reservePrice()).to.equal(RESERVE_PRICE);
        });

        it("should set correct deadlines", async function () {
            const commitDeadline = await auction.commitDeadline();
            const revealDeadline = await auction.revealDeadline();
            expect(revealDeadline - commitDeadline).to.equal(BigInt(REVEAL_DURATION));
        });
    });

    // ─────────────────── Commit Phase ───────────────────
    describe("Commit Phase", function () {
        it("should allow a bidder to commit", async function () {
            const bid = ethers.parseEther("2");
            const nonce = randomNonce();
            const hash = computeHash(bid, nonce);

            await expect(
                auction.connect(bidder1).commitBid(hash, { value: ethers.parseEther("2") })
            ).to.emit(auction, "BidCommitted").withArgs(bidder1.address, hash);

            expect(await auction.getBiddersCount()).to.equal(1n);
        });

        it("should reject seller from bidding", async function () {
            const hash = computeHash(ethers.parseEther("2"), randomNonce());
            await expect(
                auction.connect(seller).commitBid(hash, { value: ethers.parseEther("2") })
            ).to.be.revertedWith("Seller cannot bid");
        });

        it("should reject deposit below reserve price", async function () {
            const hash = computeHash(ethers.parseEther("0.5"), randomNonce());
            await expect(
                auction.connect(bidder1).commitBid(hash, { value: ethers.parseEther("0.5") })
            ).to.be.revertedWith("Deposit below reserve price");
        });

        it("should reject duplicate commits from same address", async function () {
            const hash = computeHash(ethers.parseEther("2"), randomNonce());
            await auction.connect(bidder1).commitBid(hash, { value: ethers.parseEther("2") });
            await expect(
                auction.connect(bidder1).commitBid(hash, { value: ethers.parseEther("2") })
            ).to.be.revertedWith("Already committed");
        });

        it("should reject commits after commit deadline", async function () {
            await time.increase(COMMIT_DURATION + 1);
            const hash = computeHash(ethers.parseEther("2"), randomNonce());
            await expect(
                auction.connect(bidder1).commitBid(hash, { value: ethers.parseEther("2") })
            ).to.be.revertedWith("Phase has ended");
        });
    });

    // ─────────────────── Reveal Phase ───────────────────
    describe("Reveal Phase", function () {
        let bid1, nonce1, bid2, nonce2;

        beforeEach(async function () {
            bid1 = ethers.parseEther("3");
            nonce1 = randomNonce();
            bid2 = ethers.parseEther("2");
            nonce2 = randomNonce();

            await auction.connect(bidder1).commitBid(computeHash(bid1, nonce1), { value: ethers.parseEther("3") });
            await auction.connect(bidder2).commitBid(computeHash(bid2, nonce2), { value: ethers.parseEther("2") });

            // Move past commit deadline
            await time.increase(COMMIT_DURATION + 1);
        });

        it("should allow valid reveal", async function () {
            await expect(
                auction.connect(bidder1).revealBid(bid1, nonce1)
            ).to.emit(auction, "BidRevealed").withArgs(bidder1.address, bid1);
        });

        it("should reject reveal before commit deadline", async function () {
            // Deploy a fresh auction and try to reveal immediately
            const VickreyAuction = await ethers.getContractFactory("VickreyAuction");
            const fresh = await VickreyAuction.deploy("Test", RESERVE_PRICE, COMMIT_DURATION, REVEAL_DURATION);
            const bid = ethers.parseEther("2");
            const nonce = randomNonce();
            await fresh.connect(bidder1).commitBid(computeHash(bid, nonce), { value: ethers.parseEther("2") });

            await expect(
                fresh.connect(bidder1).revealBid(bid, nonce)
            ).to.be.revertedWith("Phase not yet ended");
        });

        it("should reject reveal with wrong nonce", async function () {
            const wrongNonce = randomNonce();
            await expect(
                auction.connect(bidder1).revealBid(bid1, wrongNonce)
            ).to.be.revertedWith("Hash mismatch");
        });

        it("should reject reveal with wrong bid value", async function () {
            const wrongBid = ethers.parseEther("999");
            await expect(
                auction.connect(bidder1).revealBid(wrongBid, nonce1)
            ).to.be.revertedWith("Hash mismatch");
        });

        it("should reject double reveal", async function () {
            await auction.connect(bidder1).revealBid(bid1, nonce1);
            await expect(
                auction.connect(bidder1).revealBid(bid1, nonce1)
            ).to.be.revertedWith("Already revealed");
        });

        it("should reject reveal after reveal deadline", async function () {
            await time.increase(REVEAL_DURATION + 1);
            await expect(
                auction.connect(bidder1).revealBid(bid1, nonce1)
            ).to.be.revertedWith("Phase has ended");
        });
    });

    // ─────────────────── Finalize ───────────────────
    describe("Finalize", function () {
        let bid1, nonce1, bid2, nonce2, bid3, nonce3;

        beforeEach(async function () {
            bid1 = ethers.parseEther("5");   // highest
            nonce1 = randomNonce();
            bid2 = ethers.parseEther("3");   // second highest
            nonce2 = randomNonce();
            bid3 = ethers.parseEther("2");   // third
            nonce3 = randomNonce();

            await auction.connect(bidder1).commitBid(computeHash(bid1, nonce1), { value: ethers.parseEther("5") });
            await auction.connect(bidder2).commitBid(computeHash(bid2, nonce2), { value: ethers.parseEther("3") });
            await auction.connect(bidder3).commitBid(computeHash(bid3, nonce3), { value: ethers.parseEther("3") });

            await time.increase(COMMIT_DURATION + 1);

            await auction.connect(bidder1).revealBid(bid1, nonce1);
            await auction.connect(bidder2).revealBid(bid2, nonce2);
            await auction.connect(bidder3).revealBid(bid3, nonce3);

            await time.increase(REVEAL_DURATION + 1);
        });

        it("should determine winner and second price correctly", async function () {
            await auction.finalize();
            expect(await auction.winner()).to.equal(bidder1.address);
            expect(await auction.winningBid()).to.equal(bid1);
            expect(await auction.secondPrice()).to.equal(bid2); // 3 ETH
        });

        it("should emit AuctionFinalized event", async function () {
            await expect(auction.finalize())
                .to.emit(auction, "AuctionFinalized")
                .withArgs(bidder1.address, bid1, bid2);
        });

        it("should reject finalize before reveal deadline", async function () {
            const VickreyAuction = await ethers.getContractFactory("VickreyAuction");
            const fresh = await VickreyAuction.deploy("Test", RESERVE_PRICE, COMMIT_DURATION, REVEAL_DURATION);
            await expect(fresh.finalize()).to.be.revertedWith("Phase not yet ended");
        });

        it("should reject double finalize", async function () {
            await auction.finalize();
            await expect(auction.finalize()).to.be.revertedWith("Already finalized");
        });

        it("should use reserve price as second price when only one bidder reveals", async function () {
            // Fresh auction with single bidder
            const VickreyAuction = await ethers.getContractFactory("VickreyAuction");
            const solo = await VickreyAuction.deploy("Solo", RESERVE_PRICE, COMMIT_DURATION, REVEAL_DURATION);

            const bid = ethers.parseEther("4");
            const nonce = randomNonce();
            await solo.connect(bidder1).commitBid(computeHash(bid, nonce), { value: ethers.parseEther("4") });

            await time.increase(COMMIT_DURATION + 1);
            await solo.connect(bidder1).revealBid(bid, nonce);
            await time.increase(REVEAL_DURATION + 1);
            await solo.finalize();

            expect(await solo.winner()).to.equal(bidder1.address);
            expect(await solo.secondPrice()).to.equal(RESERVE_PRICE);
        });
    });

    // ─────────────────── Withdraw ───────────────────
    describe("Withdraw", function () {
        let bid1, nonce1, bid2, nonce2;

        beforeEach(async function () {
            bid1 = ethers.parseEther("5");
            nonce1 = randomNonce();
            bid2 = ethers.parseEther("3");
            nonce2 = randomNonce();

            await auction.connect(bidder1).commitBid(computeHash(bid1, nonce1), { value: ethers.parseEther("5") });
            await auction.connect(bidder2).commitBid(computeHash(bid2, nonce2), { value: ethers.parseEther("3") });

            await time.increase(COMMIT_DURATION + 1);
            await auction.connect(bidder1).revealBid(bid1, nonce1);
            await auction.connect(bidder2).revealBid(bid2, nonce2);

            await time.increase(REVEAL_DURATION + 1);
            await auction.finalize();
        });

        it("should refund winner deposit minus second price", async function () {
            const balBefore = await ethers.provider.getBalance(bidder1.address);
            const tx = await auction.connect(bidder1).withdraw();
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * receipt.gasPrice;
            const balAfter = await ethers.provider.getBalance(bidder1.address);

            // Winner deposited 5 ETH, pays 3 ETH (secondPrice), gets back 2 ETH
            const expectedRefund = ethers.parseEther("2");
            expect(balAfter - balBefore + gasCost).to.equal(expectedRefund);
        });

        it("should refund losing bidder full deposit", async function () {
            const balBefore = await ethers.provider.getBalance(bidder2.address);
            const tx = await auction.connect(bidder2).withdraw();
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * receipt.gasPrice;
            const balAfter = await ethers.provider.getBalance(bidder2.address);

            const expectedRefund = ethers.parseEther("3");
            expect(balAfter - balBefore + gasCost).to.equal(expectedRefund);
        });

        it("should allow seller to withdraw second price", async function () {
            const balBefore = await ethers.provider.getBalance(seller.address);
            const tx = await auction.connect(seller).sellerWithdraw();
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * receipt.gasPrice;
            const balAfter = await ethers.provider.getBalance(seller.address);

            expect(balAfter - balBefore + gasCost).to.equal(ethers.parseEther("3"));
        });

        it("should reject withdraw before finalization", async function () {
            const VickreyAuction = await ethers.getContractFactory("VickreyAuction");
            const fresh = await VickreyAuction.deploy("Test", RESERVE_PRICE, COMMIT_DURATION, REVEAL_DURATION);
            await expect(fresh.connect(bidder1).withdraw()).to.be.revertedWith("Not finalized yet");
        });
    });

    // ─────────────────── Forfeited Deposits ───────────────────
    describe("Forfeited Deposits", function () {
        it("should forfeit deposit of bidder who did not reveal", async function () {
            const bid1 = ethers.parseEther("5");
            const nonce1 = randomNonce();
            const bid2 = ethers.parseEther("3");
            const nonce2 = randomNonce();

            await auction.connect(bidder1).commitBid(computeHash(bid1, nonce1), { value: ethers.parseEther("5") });
            await auction.connect(bidder2).commitBid(computeHash(bid2, nonce2), { value: ethers.parseEther("3") });

            await time.increase(COMMIT_DURATION + 1);

            // Only bidder1 reveals; bidder2 forfeits
            await auction.connect(bidder1).revealBid(bid1, nonce1);

            await time.increase(REVEAL_DURATION + 1);
            await auction.finalize();

            // Bidder2 (no reveal) gets 0 refund
            const commit2 = await auction.commits(bidder2.address);
            // After withdraw, bidder2 should get nothing
            const balBefore = await ethers.provider.getBalance(bidder2.address);
            await auction.connect(bidder2).withdraw();
            const balAfter = await ethers.provider.getBalance(bidder2.address);
            // Balance should decrease slightly (gas) since refund is 0
            expect(balAfter).to.be.lessThan(balBefore);

            // Seller gets secondPrice (reservePrice since only 1 reveal) + forfeited deposit (3 ETH)
            const sellerBalBefore = await ethers.provider.getBalance(seller.address);
            const tx = await auction.connect(seller).sellerWithdraw();
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * receipt.gasPrice;
            const sellerBalAfter = await ethers.provider.getBalance(seller.address);

            // secondPrice = reservePrice (1 ETH) + forfeited (3 ETH) = 4 ETH
            expect(sellerBalAfter - sellerBalBefore + gasCost).to.equal(ethers.parseEther("4"));
        });
    });

    // ─────────────────── Full Auction Scenario ───────────────────
    describe("Full Auction E2E", function () {
        it("should complete a full auction lifecycle", async function () {
            // 3 bidders commit
            const bids = [
                { bidder: bidder1, amount: ethers.parseEther("10"), nonce: randomNonce() },
                { bidder: bidder2, amount: ethers.parseEther("7"), nonce: randomNonce() },
                { bidder: bidder3, amount: ethers.parseEther("4"), nonce: randomNonce() },
            ];

            for (const b of bids) {
                const hash = computeHash(b.amount, b.nonce);
                await auction.connect(b.bidder).commitBid(hash, { value: b.amount });
            }

            expect(await auction.getBiddersCount()).to.equal(3n);

            // Move to reveal phase
            await time.increase(COMMIT_DURATION + 1);

            // All reveal
            for (const b of bids) {
                await auction.connect(b.bidder).revealBid(b.amount, b.nonce);
            }

            // Move past reveal
            await time.increase(REVEAL_DURATION + 1);

            // Finalize
            await auction.finalize();
            expect(await auction.winner()).to.equal(bidder1.address);
            expect(await auction.winningBid()).to.equal(ethers.parseEther("10"));
            expect(await auction.secondPrice()).to.equal(ethers.parseEther("7"));

            // Everyone withdraws
            await auction.connect(bidder1).withdraw(); // gets 10 - 7 = 3 ETH back
            await auction.connect(bidder2).withdraw(); // gets 7 ETH back
            await auction.connect(bidder3).withdraw(); // gets 4 ETH back
            await auction.connect(seller).sellerWithdraw(); // gets 7 ETH

            // Contract should be empty
            const contractBalance = await ethers.provider.getBalance(await auction.getAddress());
            expect(contractBalance).to.equal(0n);
        });
    });
});

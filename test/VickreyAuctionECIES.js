const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { PrivateKey, encrypt, decrypt } = require("eciesjs");

describe("VickreyAuctionECIES", function () {
    const COMMIT_DURATION = 3600;
    const REVEAL_DURATION = 3600;
    const RESERVE_PRICE = ethers.parseEther("1");

    let auction;
    let seller, bidder1, bidder2, bidder3;
    let sellerECIES; // seller's ECIES key pair

    function computeHash(bidValue, nonce) {
        return ethers.solidityPackedKeccak256(
            ["uint256", "bytes32"],
            [bidValue, nonce]
        );
    }

    function randomNonce() {
        return ethers.hexlify(ethers.randomBytes(32));
    }

    /**
     * Encrypt (bidValue, nonce) with seller's ECIES public key.
     * Returns hex-encoded ciphertext suitable for on-chain submission.
     */
    function encryptBid(sellerPubKeyHex, bidValue, nonce) {
        // Pack bidValue and nonce the same way Solidity would: abi.encode(uint256, bytes32)
        const plaintext = ethers.AbiCoder.defaultAbiCoder().encode(
            ["uint256", "bytes32"],
            [bidValue, nonce]
        );
        const plaintextBuf = Buffer.from(plaintext.slice(2), "hex");
        const ciphertext = encrypt(sellerPubKeyHex, plaintextBuf);
        return "0x" + Buffer.from(ciphertext).toString("hex");
    }

    /**
     * Decrypt ciphertext with seller's ECIES private key.
     * Returns { bidValue, nonce }.
     */
    function decryptBid(sellerPrivKeyHex, ciphertextHex) {
        const cipherBuf = Buffer.from(ciphertextHex.slice(2), "hex");
        const plainBuf = decrypt(sellerPrivKeyHex, cipherBuf);
        const plainHex = "0x" + Buffer.from(plainBuf).toString("hex");
        const [bidValue, nonce] = ethers.AbiCoder.defaultAbiCoder().decode(
            ["uint256", "bytes32"],
            plainHex
        );
        return { bidValue, nonce };
    }

    beforeEach(async function () {
        [seller, bidder1, bidder2, bidder3] = await ethers.getSigners();

        // Generate seller ECIES key pair
        sellerECIES = new PrivateKey();
        const sellerPubKeyHex = "0x" + Buffer.from(sellerECIES.publicKey.dataUncompressed).toString("hex");

        const VickreyAuctionECIES = await ethers.getContractFactory("VickreyAuctionECIES");
        auction = await VickreyAuctionECIES.deploy(
            "Rare Digital Art #42",
            RESERVE_PRICE,
            COMMIT_DURATION,
            REVEAL_DURATION,
            sellerPubKeyHex
        );
    });

    // ─────────────────── Deployment ───────────────────
    describe("Deployment", function () {
        it("should store the seller public key", async function () {
            const storedKey = await auction.sellerPublicKey();
            expect(storedKey.length).to.be.greaterThan(2); // "0x" + key bytes
        });

        it("should set seller and parameters", async function () {
            expect(await auction.seller()).to.equal(seller.address);
            expect(await auction.reservePrice()).to.equal(RESERVE_PRICE);
        });
    });

    // ─────────────────── Commit Phase ───────────────────
    describe("Commit Phase", function () {
        it("should allow bidder to commit", async function () {
            const bid = ethers.parseEther("2");
            const nonce = randomNonce();
            const hash = computeHash(bid, nonce);

            await expect(
                auction.connect(bidder1).commitBid(hash, { value: ethers.parseEther("2") })
            ).to.emit(auction, "BidCommitted");
        });

        it("should reject seller from bidding", async function () {
            const hash = computeHash(ethers.parseEther("2"), randomNonce());
            await expect(
                auction.connect(seller).commitBid(hash, { value: ethers.parseEther("2") })
            ).to.be.revertedWith("Seller cannot bid");
        });
    });

    // ─────────────────── Encrypted Reveal Phase ───────────────────
    describe("Encrypted Reveal Phase", function () {
        let bid1, nonce1;

        beforeEach(async function () {
            bid1 = ethers.parseEther("3");
            nonce1 = randomNonce();
            await auction.connect(bidder1).commitBid(computeHash(bid1, nonce1), {
                value: ethers.parseEther("3"),
            });
            await time.increase(COMMIT_DURATION + 1);
        });

        it("should accept encrypted bid submission", async function () {
            const ciphertext = encryptBid(
                sellerECIES.publicKey.toHex(),
                bid1,
                nonce1
            );
            await expect(
                auction.connect(bidder1).submitEncryptedBid(ciphertext)
            ).to.emit(auction, "EncryptedBidSubmitted");
        });

        it("should reject encrypted bid before commit deadline ends", async function () {
            const VickreyAuctionECIES = await ethers.getContractFactory("VickreyAuctionECIES");
            const sellerPubKeyHex = "0x" + Buffer.from(sellerECIES.publicKey.dataUncompressed).toString("hex");
            const fresh = await VickreyAuctionECIES.deploy("Test", RESERVE_PRICE, COMMIT_DURATION, REVEAL_DURATION, sellerPubKeyHex);

            const bid = ethers.parseEther("2");
            const nonce = randomNonce();
            await fresh.connect(bidder1).commitBid(computeHash(bid, nonce), { value: ethers.parseEther("2") });

            await expect(
                fresh.connect(bidder1).submitEncryptedBid("0x1234")
            ).to.be.revertedWith("Phase not yet ended");
        });

        it("should reject duplicate encrypted submission", async function () {
            const ciphertext = encryptBid(sellerECIES.publicKey.toHex(), bid1, nonce1);
            await auction.connect(bidder1).submitEncryptedBid(ciphertext);
            await expect(
                auction.connect(bidder1).submitEncryptedBid(ciphertext)
            ).to.be.revertedWith("Already submitted encrypted bid");
        });

        it("ciphertext should be decryptable by seller", async function () {
            const ciphertext = encryptBid(sellerECIES.publicKey.toHex(), bid1, nonce1);
            const { bidValue, nonce } = decryptBid(sellerECIES.toHex(), ciphertext);
            expect(bidValue).to.equal(bid1);
            expect(nonce).to.equal(nonce1);
        });
    });

    // ─────────────────── Seller Declares Results ───────────────────
    describe("Seller Declares Results", function () {
        let bids;

        beforeEach(async function () {
            bids = [
                { bidder: bidder1, amount: ethers.parseEther("5"), nonce: randomNonce() },
                { bidder: bidder2, amount: ethers.parseEther("3"), nonce: randomNonce() },
                { bidder: bidder3, amount: ethers.parseEther("2"), nonce: randomNonce() },
            ];

            // Commit phase
            for (const b of bids) {
                await auction.connect(b.bidder).commitBid(computeHash(b.amount, b.nonce), {
                    value: b.amount,
                });
            }

            await time.increase(COMMIT_DURATION + 1);

            // Encrypted reveal phase
            for (const b of bids) {
                const ciphertext = encryptBid(sellerECIES.publicKey.toHex(), b.amount, b.nonce);
                await auction.connect(b.bidder).submitEncryptedBid(ciphertext);
            }

            await time.increase(REVEAL_DURATION + 1);
        });

        it("should finalize correctly when seller declares all bids", async function () {
            // Seller decrypts and declares
            const bidderAddrs = bids.map((b) => b.bidder.address);
            const values = bids.map((b) => b.amount);
            const nonces = bids.map((b) => b.nonce);

            await expect(
                auction.connect(seller).sellerDeclareAllBids(bidderAddrs, values, nonces)
            ).to.emit(auction, "AuctionFinalized").withArgs(
                bidder1.address,
                ethers.parseEther("5"),
                ethers.parseEther("3")
            );

            expect(await auction.winner()).to.equal(bidder1.address);
            expect(await auction.secondPrice()).to.equal(ethers.parseEther("3"));
        });

        it("should reject if non-seller tries to declare", async function () {
            await expect(
                auction.connect(bidder1).sellerDeclareAllBids([], [], [])
            ).to.be.revertedWith("Only seller");
        });

        it("should reject if seller provides wrong bid value", async function () {
            const bidderAddrs = bids.map((b) => b.bidder.address);
            const wrongValues = [ethers.parseEther("999"), bids[1].amount, bids[2].amount];
            const nonces = bids.map((b) => b.nonce);

            await expect(
                auction.connect(seller).sellerDeclareAllBids(bidderAddrs, wrongValues, nonces)
            ).to.be.revertedWith("Hash mismatch - bid tampered");
        });

        it("should reject if seller provides wrong nonce", async function () {
            const bidderAddrs = bids.map((b) => b.bidder.address);
            const values = bids.map((b) => b.amount);
            const wrongNonces = [randomNonce(), bids[1].nonce, bids[2].nonce];

            await expect(
                auction.connect(seller).sellerDeclareAllBids(bidderAddrs, values, wrongNonces)
            ).to.be.revertedWith("Hash mismatch - bid tampered");
        });

        it("should reject double finalization", async function () {
            const bidderAddrs = bids.map((b) => b.bidder.address);
            const values = bids.map((b) => b.amount);
            const nonces = bids.map((b) => b.nonce);

            await auction.connect(seller).sellerDeclareAllBids(bidderAddrs, values, nonces);
            await expect(
                auction.connect(seller).sellerDeclareAllBids(bidderAddrs, values, nonces)
            ).to.be.revertedWith("Already finalized");
        });
    });

    // ─────────────────── Withdraw ───────────────────
    describe("Withdraw", function () {
        beforeEach(async function () {
            const bids = [
                { bidder: bidder1, amount: ethers.parseEther("5"), nonce: randomNonce() },
                { bidder: bidder2, amount: ethers.parseEther("3"), nonce: randomNonce() },
            ];

            for (const b of bids) {
                await auction.connect(b.bidder).commitBid(computeHash(b.amount, b.nonce), {
                    value: b.amount,
                });
            }

            await time.increase(COMMIT_DURATION + 1);

            for (const b of bids) {
                const ct = encryptBid(sellerECIES.publicKey.toHex(), b.amount, b.nonce);
                await auction.connect(b.bidder).submitEncryptedBid(ct);
            }

            await time.increase(REVEAL_DURATION + 1);

            await auction.connect(seller).sellerDeclareAllBids(
                bids.map((b) => b.bidder.address),
                bids.map((b) => b.amount),
                bids.map((b) => b.nonce)
            );
        });

        it("should refund winner deposit minus second price", async function () {
            const balBefore = await ethers.provider.getBalance(bidder1.address);
            const tx = await auction.connect(bidder1).withdraw();
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * receipt.gasPrice;
            const balAfter = await ethers.provider.getBalance(bidder1.address);

            // Winner deposited 5 ETH, pays 3 ETH, gets 2 ETH back
            expect(balAfter - balBefore + gasCost).to.equal(ethers.parseEther("2"));
        });

        it("should refund losing bidder full deposit", async function () {
            const balBefore = await ethers.provider.getBalance(bidder2.address);
            const tx = await auction.connect(bidder2).withdraw();
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * receipt.gasPrice;
            const balAfter = await ethers.provider.getBalance(bidder2.address);

            expect(balAfter - balBefore + gasCost).to.equal(ethers.parseEther("3"));
        });

        it("should allow seller to withdraw second price", async function () {
            const balBefore = await ethers.provider.getBalance(seller.address);
            const tx = await auction.connect(seller).sellerWithdraw();
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * receipt.gasPrice;
            const balAfter = await ethers.provider.getBalance(seller.address);

            expect(balAfter - balBefore + gasCost).to.equal(ethers.parseEther("3"));
        });
    });

    // ─────────────────── Full E2E with ECIES ───────────────────
    describe("Full ECIES Auction E2E", function () {
        it("should complete a full encrypted auction lifecycle", async function () {
            const bids = [
                { bidder: bidder1, amount: ethers.parseEther("10"), nonce: randomNonce() },
                { bidder: bidder2, amount: ethers.parseEther("7"), nonce: randomNonce() },
                { bidder: bidder3, amount: ethers.parseEther("4"), nonce: randomNonce() },
            ];

            // Phase 1: Commit
            for (const b of bids) {
                await auction.connect(b.bidder).commitBid(
                    computeHash(b.amount, b.nonce),
                    { value: b.amount }
                );
            }

            await time.increase(COMMIT_DURATION + 1);

            // Phase 2: Encrypted Reveal
            const encryptedBids = [];
            for (const b of bids) {
                const ct = encryptBid(sellerECIES.publicKey.toHex(), b.amount, b.nonce);
                await auction.connect(b.bidder).submitEncryptedBid(ct);
                encryptedBids.push(ct);
            }

            await time.increase(REVEAL_DURATION + 1);

            // Phase 3: Seller decrypts off-chain
            const decryptedBids = encryptedBids.map((ct) =>
                decryptBid(sellerECIES.toHex(), ct)
            );

            // Verify decrypted values match originals
            for (let i = 0; i < bids.length; i++) {
                expect(decryptedBids[i].bidValue).to.equal(bids[i].amount);
                expect(decryptedBids[i].nonce).to.equal(bids[i].nonce);
            }

            // Phase 3: Seller declares to contract
            await auction.connect(seller).sellerDeclareAllBids(
                bids.map((b) => b.bidder.address),
                decryptedBids.map((d) => d.bidValue),
                decryptedBids.map((d) => d.nonce)
            );

            expect(await auction.winner()).to.equal(bidder1.address);
            expect(await auction.winningBid()).to.equal(ethers.parseEther("10"));
            expect(await auction.secondPrice()).to.equal(ethers.parseEther("7"));

            // Withdrawals
            await auction.connect(bidder1).withdraw();
            await auction.connect(bidder2).withdraw();
            await auction.connect(bidder3).withdraw();
            await auction.connect(seller).sellerWithdraw();

            const contractBal = await ethers.provider.getBalance(await auction.getAddress());
            expect(contractBal).to.equal(0n);
        });
    });
});

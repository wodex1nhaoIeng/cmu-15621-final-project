const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { PrivateKey, encrypt, decrypt } = require("eciesjs");
const snarkjs = require("snarkjs");
const path = require("path");
const { buildPoseidon } = require("circomlibjs");

describe("VickreyAuctionZKP", function () {
    const COMMIT_DURATION = 3600;
    const REVEAL_DURATION = 3600;
    const RESERVE_PRICE = 1000000000000000000n; // 1 ETH in wei

    const WASM_PATH = path.join(__dirname, "../circuits/build/vickrey_js/vickrey.wasm");
    const ZKEY_PATH = path.join(__dirname, "../circuits/build/vickrey_final.zkey");

    let auction, verifierContract;
    let seller, bidder1, bidder2, bidder3;
    let sellerECIES;
    let poseidon, F; // Poseidon hash function and field

    before(async function () {
        // Build Poseidon hasher (shared across all tests)
        poseidon = await buildPoseidon();
        F = poseidon.F;
    });

    function poseidonHash(a, b) {
        return F.toObject(poseidon([a, b]));
    }

    function randomFieldElement() {
        // Random 31-byte number (fits in BN254 field)
        const bytes = ethers.randomBytes(31);
        return BigInt("0x" + Buffer.from(bytes).toString("hex"));
    }

    function encryptBid(sellerPubKeyHex, bidValue, nonce) {
        const plaintext = ethers.AbiCoder.defaultAbiCoder().encode(
            ["uint256", "uint256"],
            [bidValue, nonce]
        );
        const ciphertext = encrypt(sellerPubKeyHex, Buffer.from(plaintext.slice(2), "hex"));
        return "0x" + Buffer.from(ciphertext).toString("hex");
    }

    function decryptBid(sellerPrivKeyHex, ciphertextHex) {
        const plainBuf = decrypt(sellerPrivKeyHex, Buffer.from(ciphertextHex.slice(2), "hex"));
        const [bidValue, nonce] = ethers.AbiCoder.defaultAbiCoder().decode(
            ["uint256", "uint256"],
            "0x" + Buffer.from(plainBuf).toString("hex")
        );
        return { bidValue, nonce };
    }

    /**
     * Generate a Groth16 proof for the auction result.
     */
    async function generateProof(bidValues, nonces, commitHashes, numActive, winnerIdx, secondPrice, reservePrice) {
        // Pad arrays to MAX_BIDDERS = 4
        const padded = (arr, len, fill) => {
            const result = [...arr];
            while (result.length < len) result.push(fill);
            return result;
        };

        const input = {
            commitHashes: padded(commitHashes.map(String), 4, "0"),
            numActiveBidders: String(numActive),
            declaredWinnerIdx: String(winnerIdx),
            declaredSecondPrice: String(secondPrice),
            reservePrice: String(reservePrice),
            bidValues: padded(bidValues.map(String), 4, "0"),
            nonces: padded(nonces.map(String), 4, "0"),
        };

        const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM_PATH, ZKEY_PATH);

        // Convert proof to Solidity calldata format
        const calldata = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
        const args = JSON.parse("[" + calldata + "]");

        return {
            pA: args[0],
            pB: args[1],
            pC: args[2],
            pubSignals: args[3],
        };
    }

    beforeEach(async function () {
        [seller, bidder1, bidder2, bidder3] = await ethers.getSigners();

        sellerECIES = new PrivateKey();
        const sellerPubKeyHex = "0x" + Buffer.from(sellerECIES.publicKey.dataUncompressed).toString("hex");

        // Deploy the Groth16 verifier
        const Verifier = await ethers.getContractFactory("Groth16Verifier");
        verifierContract = await Verifier.deploy();

        // Deploy the ZKP auction
        const VickreyAuctionZKP = await ethers.getContractFactory("VickreyAuctionZKP");
        auction = await VickreyAuctionZKP.deploy(
            "Rare Digital Art #42",
            RESERVE_PRICE,
            COMMIT_DURATION,
            REVEAL_DURATION,
            sellerPubKeyHex,
            await verifierContract.getAddress()
        );
    });

    // ─────────────────── Deployment ───────────────────
    describe("Deployment", function () {
        it("should set up correctly", async function () {
            expect(await auction.seller()).to.equal(seller.address);
            expect(await auction.reservePrice()).to.equal(RESERVE_PRICE);
            expect(await auction.verifier()).to.equal(await verifierContract.getAddress());
        });
    });

    // ─────────────────── Full ZKP E2E ───────────────────
    describe("Full ZKP Auction E2E", function () {
        it("should complete auction with valid ZKP proof", async function () {
            this.timeout(60000); // proof generation can take a few seconds

            // Prepare bids with Poseidon commitments
            const bids = [
                { bidder: bidder1, amount: 5000000000000000000n, nonce: randomFieldElement() }, // 5 ETH
                { bidder: bidder2, amount: 3000000000000000000n, nonce: randomFieldElement() }, // 3 ETH
                { bidder: bidder3, amount: 2000000000000000000n, nonce: randomFieldElement() }, // 2 ETH
            ];

            const commitHashes = bids.map((b) => poseidonHash(b.amount, b.nonce));

            // Phase 1: Commit
            for (let i = 0; i < bids.length; i++) {
                await auction.connect(bids[i].bidder).commitBid(commitHashes[i], {
                    value: bids[i].amount,
                });
            }

            await time.increase(COMMIT_DURATION + 1);

            // Phase 2: Encrypted Reveal
            for (const b of bids) {
                const ct = encryptBid(sellerECIES.publicKey.toHex(), b.amount, b.nonce);
                await auction.connect(b.bidder).submitEncryptedBid(ct);
            }

            await time.increase(REVEAL_DURATION + 1);

            // Phase 3: Seller generates ZKP and finalizes
            const bidValues = bids.map((b) => b.amount);
            const nonces = bids.map((b) => b.nonce);
            const winnerIdx = 0; // bidder1 has highest bid
            const secondPrice = 3000000000000000000n; // 3 ETH

            const proofData = await generateProof(
                bidValues,
                nonces,
                commitHashes,
                bids.length,
                winnerIdx,
                secondPrice,
                RESERVE_PRICE
            );

            await expect(
                auction.connect(seller).finalizeWithProof(
                    proofData.pA,
                    proofData.pB,
                    proofData.pC,
                    winnerIdx,
                    secondPrice
                )
            ).to.emit(auction, "AuctionFinalized");

            expect(await auction.winner()).to.equal(bidder1.address);
            expect(await auction.secondPrice()).to.equal(secondPrice);

            // Phase 4: Withdrawals
            await auction.connect(bidder1).withdraw(); // gets 5 - 3 = 2 ETH
            await auction.connect(bidder2).withdraw(); // gets 3 ETH
            await auction.connect(bidder3).withdraw(); // gets 2 ETH
            await auction.connect(seller).sellerWithdraw(); // gets 3 ETH

            const contractBal = await ethers.provider.getBalance(await auction.getAddress());
            expect(contractBal).to.equal(0n);
        });

        it("should reject invalid proof (wrong second price)", async function () {
            this.timeout(60000);

            const bids = [
                { bidder: bidder1, amount: 5000000000000000000n, nonce: randomFieldElement() },
                { bidder: bidder2, amount: 3000000000000000000n, nonce: randomFieldElement() },
            ];

            const commitHashes = bids.map((b) => poseidonHash(b.amount, b.nonce));

            for (let i = 0; i < bids.length; i++) {
                await auction.connect(bids[i].bidder).commitBid(commitHashes[i], {
                    value: bids[i].amount,
                });
            }

            await time.increase(COMMIT_DURATION + 1);

            for (const b of bids) {
                const ct = encryptBid(sellerECIES.publicKey.toHex(), b.amount, b.nonce);
                await auction.connect(b.bidder).submitEncryptedBid(ct);
            }

            await time.increase(REVEAL_DURATION + 1);

            // Generate a VALID proof for correct values
            const bidValues = bids.map((b) => b.amount);
            const nonces = bids.map((b) => b.nonce);

            const proofData = await generateProof(
                bidValues,
                nonces,
                commitHashes,
                bids.length,
                0,
                3000000000000000000n, // correct second price
                RESERVE_PRICE
            );

            // But submit with WRONG second price to the contract
            // The public signals in the proof say 3 ETH, but we pass 1 ETH to the contract
            // The contract will rebuild pubSignals with 1 ETH → mismatch → proof fails
            await expect(
                auction.connect(seller).finalizeWithProof(
                    proofData.pA,
                    proofData.pB,
                    proofData.pC,
                    0,
                    1000000000000000000n // wrong second price!
                )
            ).to.be.revertedWith("Invalid ZKP proof");
        });

        it("should reject proof with wrong winner", async function () {
            this.timeout(60000);

            const bids = [
                { bidder: bidder1, amount: 5000000000000000000n, nonce: randomFieldElement() },
                { bidder: bidder2, amount: 3000000000000000000n, nonce: randomFieldElement() },
            ];

            const commitHashes = bids.map((b) => poseidonHash(b.amount, b.nonce));

            for (let i = 0; i < bids.length; i++) {
                await auction.connect(bids[i].bidder).commitBid(commitHashes[i], {
                    value: bids[i].amount,
                });
            }

            await time.increase(COMMIT_DURATION + 1);

            for (const b of bids) {
                const ct = encryptBid(sellerECIES.publicKey.toHex(), b.amount, b.nonce);
                await auction.connect(b.bidder).submitEncryptedBid(ct);
            }

            await time.increase(REVEAL_DURATION + 1);

            // Generate proof claiming bidder2 (index 1) is winner — this should fail in circuit
            try {
                await generateProof(
                    bids.map((b) => b.amount),
                    bids.map((b) => b.nonce),
                    commitHashes,
                    bids.length,
                    1, // wrong winner!
                    5000000000000000000n,
                    RESERVE_PRICE
                );
                // If proof generation succeeds (shouldn't), contract should still reject
                expect.fail("Should not generate valid proof for wrong winner");
            } catch (e) {
                // Circuit should fail to generate witness for invalid inputs
                expect(e.message).to.include("Assert Failed");
            }
        });
    });

    // ─────────────────── Single Bidder ───────────────────
    describe("Single Bidder", function () {
        it("should use reserve price when only one bidder", async function () {
            this.timeout(60000);

            const bid = { bidder: bidder1, amount: 4000000000000000000n, nonce: randomFieldElement() };
            const commitHash = poseidonHash(bid.amount, bid.nonce);

            await auction.connect(bidder1).commitBid(commitHash, { value: bid.amount });

            await time.increase(COMMIT_DURATION + 1);

            const ct = encryptBid(sellerECIES.publicKey.toHex(), bid.amount, bid.nonce);
            await auction.connect(bidder1).submitEncryptedBid(ct);

            await time.increase(REVEAL_DURATION + 1);

            const proofData = await generateProof(
                [bid.amount],
                [bid.nonce],
                [commitHash],
                1,
                0,
                RESERVE_PRICE, // second price = reserve when only 1 bidder
                RESERVE_PRICE
            );

            await auction.connect(seller).finalizeWithProof(
                proofData.pA,
                proofData.pB,
                proofData.pC,
                0,
                RESERVE_PRICE
            );

            expect(await auction.winner()).to.equal(bidder1.address);
            expect(await auction.secondPrice()).to.equal(RESERVE_PRICE);
        });
    });
});

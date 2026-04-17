/**
 * ECIES Auction Demo: complete lifecycle with encrypted bid reveals.
 *
 * Usage:
 *   npx hardhat run scripts/demoECIES.js
 */
const { ethers } = require("hardhat");
const { PrivateKey, encrypt, decrypt } = require("eciesjs");

async function main() {
    const [seller, bidder1, bidder2, bidder3] = await ethers.getSigners();

    // ── Seller generates ECIES key pair ──
    const sellerECIES = new PrivateKey();
    const sellerPubKeyHex = "0x" + Buffer.from(sellerECIES.publicKey.dataUncompressed).toString("hex");

    console.log("=== Deploying VickreyAuctionECIES ===");
    const Factory = await ethers.getContractFactory("VickreyAuctionECIES");
    const auction = await Factory.deploy(
        "Rare Digital Art #42",
        ethers.parseEther("1"),
        3600,
        3600,
        sellerPubKeyHex
    );
    console.log(`Auction deployed at: ${await auction.getAddress()}`);
    console.log(`Seller ECIES public key published on-chain`);
    console.log(`Reserve price: 1 ETH\n`);

    // Helpers
    function computeHash(bidValue, nonce) {
        return ethers.solidityPackedKeccak256(["uint256", "bytes32"], [bidValue, nonce]);
    }

    function encryptBid(bidValue, nonce) {
        const plaintext = ethers.AbiCoder.defaultAbiCoder().encode(
            ["uint256", "bytes32"],
            [bidValue, nonce]
        );
        const ciphertext = encrypt(sellerECIES.publicKey.toHex(), Buffer.from(plaintext.slice(2), "hex"));
        return "0x" + Buffer.from(ciphertext).toString("hex");
    }

    function decryptBid(ciphertextHex) {
        const plainBuf = decrypt(sellerECIES.toHex(), Buffer.from(ciphertextHex.slice(2), "hex"));
        const [bidValue, nonce] = ethers.AbiCoder.defaultAbiCoder().decode(
            ["uint256", "bytes32"],
            "0x" + Buffer.from(plainBuf).toString("hex")
        );
        return { bidValue, nonce };
    }

    // Prepare bids
    const bids = [
        { name: "Bidder1", signer: bidder1, amount: ethers.parseEther("5"), nonce: ethers.hexlify(ethers.randomBytes(32)) },
        { name: "Bidder2", signer: bidder2, amount: ethers.parseEther("3"), nonce: ethers.hexlify(ethers.randomBytes(32)) },
        { name: "Bidder3", signer: bidder3, amount: ethers.parseEther("2"), nonce: ethers.hexlify(ethers.randomBytes(32)) },
    ];

    // ── Phase 1: COMMIT ──
    console.log("=== Phase 1: Commit ===");
    for (const b of bids) {
        const hash = computeHash(b.amount, b.nonce);
        await auction.connect(b.signer).commitBid(hash, { value: b.amount });
        console.log(`${b.name} committed hash (deposit: ${ethers.formatEther(b.amount)} ETH)`);
    }
    console.log(`Total bidders: ${await auction.getBiddersCount()}\n`);

    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine");

    // ── Phase 2: ENCRYPTED REVEAL ──
    console.log("=== Phase 2: Encrypted Reveal ===");
    console.log("Bidders encrypt their bids with seller's ECIES public key...");
    const ciphertexts = [];
    for (const b of bids) {
        const ct = encryptBid(b.amount, b.nonce);
        await auction.connect(b.signer).submitEncryptedBid(ct);
        ciphertexts.push(ct);
        console.log(`${b.name} submitted encrypted bid (${ct.slice(0, 20)}...${ct.slice(-8)})`);
    }
    console.log("No one else can read these ciphertexts!\n");

    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine");

    // ── Phase 3: SELLER DECRYPTS & DECLARES ──
    console.log("=== Phase 3: Seller Decrypts & Declares ===");
    console.log("Seller decrypts all encrypted bids off-chain...");
    const decryptedBids = ciphertexts.map((ct, i) => {
        const { bidValue, nonce } = decryptBid(ct);
        console.log(`  Decrypted ${bids[i].name}: ${ethers.formatEther(bidValue)} ETH`);
        return { bidValue, nonce };
    });

    console.log("\nSeller submits decrypted values to contract for verification...");
    await auction.connect(seller).sellerDeclareAllBids(
        bids.map((b) => b.signer.address),
        decryptedBids.map((d) => d.bidValue),
        decryptedBids.map((d) => d.nonce)
    );

    const winner = await auction.winner();
    const winningBid = await auction.winningBid();
    const secondPrice = await auction.secondPrice();
    console.log(`\nResult (verified on-chain):`);
    console.log(`  Winner:       ${winner}`);
    console.log(`  Winning bid:  ${ethers.formatEther(winningBid)} ETH`);
    console.log(`  Second price: ${ethers.formatEther(secondPrice)} ETH (winner pays this)\n`);

    // ── Phase 4: WITHDRAWALS ──
    console.log("=== Phase 4: Withdrawals ===");
    for (const b of bids) {
        const balBefore = await ethers.provider.getBalance(b.signer.address);
        await auction.connect(b.signer).withdraw();
        const balAfter = await ethers.provider.getBalance(b.signer.address);
        const diff = balAfter - balBefore;
        console.log(`${b.name}: balance change ~ ${ethers.formatEther(diff)} ETH`);
    }

    const sellerBefore = await ethers.provider.getBalance(seller.address);
    await auction.connect(seller).sellerWithdraw();
    const sellerAfter = await ethers.provider.getBalance(seller.address);
    console.log(`Seller: balance change ~ ${ethers.formatEther(sellerAfter - sellerBefore)} ETH`);

    const contractBal = await ethers.provider.getBalance(await auction.getAddress());
    console.log(`\nContract remaining: ${ethers.formatEther(contractBal)} ETH`);
    console.log("=== ECIES Auction Complete ===");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

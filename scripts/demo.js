/**
 * Interactive demo: runs a complete auction on the local Hardhat network.
 *
 * Usage:
 *   npx hardhat run scripts/demo.js
 */
const { ethers } = require("hardhat");

async function main() {
    const [seller, bidder1, bidder2, bidder3] = await ethers.getSigners();

    console.log("=== Deploying VickreyAuction ===");
    const VickreyAuction = await ethers.getContractFactory("VickreyAuction");
    const reservePrice = ethers.parseEther("1");
    const auction = await VickreyAuction.deploy(
        "Rare Digital Art #42",
        reservePrice,
        3600,  // 1h commit
        3600   // 1h reveal
    );
    console.log(`Auction deployed at: ${await auction.getAddress()}`);
    console.log(`Seller: ${seller.address}`);
    console.log(`Reserve price: 1 ETH\n`);

    // Helper
    function computeHash(bidValue, nonce) {
        return ethers.solidityPackedKeccak256(["uint256", "bytes32"], [bidValue, nonce]);
    }

    // Prepare bids
    const bids = [
        { name: "Bidder1", signer: bidder1, amount: ethers.parseEther("5"), nonce: ethers.hexlify(ethers.randomBytes(32)) },
        { name: "Bidder2", signer: bidder2, amount: ethers.parseEther("3"), nonce: ethers.hexlify(ethers.randomBytes(32)) },
        { name: "Bidder3", signer: bidder3, amount: ethers.parseEther("2"), nonce: ethers.hexlify(ethers.randomBytes(32)) },
    ];

    // ── COMMIT PHASE ──
    console.log("=== Commit Phase ===");
    for (const b of bids) {
        const hash = computeHash(b.amount, b.nonce);
        await auction.connect(b.signer).commitBid(hash, { value: b.amount });
        console.log(`${b.name} committed (deposit: ${ethers.formatEther(b.amount)} ETH)`);
    }
    console.log(`Total bidders: ${await auction.getBiddersCount()}\n`);

    // Advance time past commit deadline
    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine");

    // ── REVEAL PHASE ──
    console.log("=== Reveal Phase ===");
    for (const b of bids) {
        await auction.connect(b.signer).revealBid(b.amount, b.nonce);
        console.log(`${b.name} revealed bid: ${ethers.formatEther(b.amount)} ETH`);
    }
    console.log();

    // Advance time past reveal deadline
    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine");

    // ── FINALIZE ──
    console.log("=== Finalize ===");
    await auction.finalize();
    const winner = await auction.winner();
    const winningBid = await auction.winningBid();
    const secondPrice = await auction.secondPrice();
    console.log(`Winner:       ${winner}`);
    console.log(`Winning bid:  ${ethers.formatEther(winningBid)} ETH`);
    console.log(`Second price: ${ethers.formatEther(secondPrice)} ETH (amount winner pays)\n`);

    // ── WITHDRAWALS ──
    console.log("=== Withdrawals ===");
    for (const b of bids) {
        const balBefore = await ethers.provider.getBalance(b.signer.address);
        await auction.connect(b.signer).withdraw();
        const balAfter = await ethers.provider.getBalance(b.signer.address);
        const diff = balAfter - balBefore;
        console.log(`${b.name}: balance change ≈ ${ethers.formatEther(diff)} ETH`);
    }

    const sellerBalBefore = await ethers.provider.getBalance(seller.address);
    await auction.connect(seller).sellerWithdraw();
    const sellerBalAfter = await ethers.provider.getBalance(seller.address);
    console.log(`Seller:  balance change ≈ ${ethers.formatEther(sellerBalAfter - sellerBalBefore)} ETH`);

    const contractBal = await ethers.provider.getBalance(await auction.getAddress());
    console.log(`\nContract remaining balance: ${ethers.formatEther(contractBal)} ETH`);
    console.log("\n=== Auction Complete ===");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

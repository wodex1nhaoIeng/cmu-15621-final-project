const { buildModule } = require("@nomicfoundation/hardhat-ignition/modules");
const { ethers } = require("hardhat");

module.exports = buildModule("VickreyAuctionModule", (m) => {
    const reservePrice = m.getParameter("reservePrice", ethers.parseEther("1").toString());
    const commitDuration = m.getParameter("commitDuration", 3600);   // 1 hour
    const revealDuration = m.getParameter("revealDuration", 3600);   // 1 hour
    const itemDescription = m.getParameter("itemDescription", "Rare Digital Art #42");

    const auction = m.contract("VickreyAuction", [
        itemDescription,
        reservePrice,
        commitDuration,
        revealDuration,
    ]);

    return { auction };
});

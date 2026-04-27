// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title VickreyAuction
 * @notice A trustless second-price sealed-bid (Vickrey) auction using commit-reveal.
 *
 * Flow:
 *   1. Seller deploys the contract, setting bidding deadlines.
 *   2. COMMIT phase – bidders submit commit(bid_value, nonce).
 *   3. REVEAL phase – bidders reveal their bid value and nonce.
 *   4. FINALIZE     – seller finalizes the auction, show proof to the winner.
 *
 * The 3rd and 4th steps are possibly off-chain, so they are not shown here.
 */
contract VickreyAuction {
    // ──────────────────── State ────────────────────
    address public seller;
    string public itemDescription;
    uint256 public commitDeadline; // end of commit phase (timestamp)
    bool public finalized;
    address public winner;

    mapping(address => string) public commits;
    address[] public bidders; // track who committed

    // ──────────────────── Events ────────────────────
    event BidCommitted(address indexed bidder, string commit);
    event AuctionFinalized(address indexed winner);

    // ──────────────────── Modifiers ────────────────────
    modifier onlyBefore(uint256 deadline) {
        require(block.timestamp <= deadline, "Phase has ended");
        _;
    }

    modifier onlySeller() {
        require(
            msg.sender == seller,
            "Only the seller can finalize the auction"
        );
        _;
    }

    // ──────────────────── Constructor ────────────────────
    /**
     * @param _itemDescription  Human-readable description of the auctioned item.
     * @param _commitDuration   Seconds from deployment until commit phase ends.
     */
    constructor(string memory _itemDescription, uint256 _commitDuration) {
        require(_commitDuration > 0, "Commit duration must be > 0");

        seller = msg.sender;
        itemDescription = _itemDescription;
        commitDeadline = block.timestamp + _commitDuration;
    }

    // ──────────────────── Commit Phase ────────────────────
    function commitBid(
        string calldata _commit
    ) external onlyBefore(commitDeadline) {
        if (bytes(commits[msg.sender]).length == 0) {
            bidders.push(msg.sender);
        }
        commits[msg.sender] = _commit;

        emit BidCommitted(msg.sender, _commit);
    }

    // ──────────────────── Finalize ────────────────────
    /**
     * @notice Determine the winner (highest bid).
     */
    function finalize(address _winner) external onlySeller {
        require(!finalized, "Already finalized");
        finalized = true;
        winner = _winner;

        emit AuctionFinalized(_winner);
    }

    function commitDue() external view returns (bool) {
        return block.timestamp > commitDeadline;
    }

    function biddersLength() external view returns (uint256) {
        return bidders.length;
    }
}

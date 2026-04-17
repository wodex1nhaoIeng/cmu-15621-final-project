// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title VickreyAuction
 * @notice A trustless second-price sealed-bid (Vickrey) auction using commit-reveal.
 *
 * Flow:
 *   1. Seller deploys the contract, setting bidding and reveal deadlines.
 *   2. COMMIT phase  – bidders submit hash(bid_value, nonce) along with a deposit >= reserve.
 *   3. REVEAL phase  – bidders reveal their bid value and nonce; contract verifies the hash.
 *   4. FINALIZE      – seller (or anyone) calls finalize(); highest bidder wins, pays 2nd price.
 *   5. WITHDRAW      – losing bidders reclaim their deposits; winner reclaims (deposit - 2nd price).
 */
contract VickreyAuction {
    // ──────────────────── State ────────────────────
    address public seller;
    string public itemDescription;
    uint256 public reservePrice;

    uint256 public commitDeadline; // end of commit phase (timestamp)
    uint256 public revealDeadline; // end of reveal phase (timestamp)

    bool public finalized;
    address public winner;
    uint256 public winningBid; // highest bid
    uint256 public secondPrice; // amount winner actually pays

    struct Commit {
        bytes32 commitHash;
        uint256 deposit;
        bool revealed;
        uint256 bidValue;
    }

    mapping(address => Commit) public commits;
    address[] public bidders; // track who committed

    // ──────────────────── Events ────────────────────
    event BidCommitted(address indexed bidder, bytes32 commitHash);
    event BidRevealed(address indexed bidder, uint256 bidValue);
    event AuctionFinalized(
        address indexed winner,
        uint256 winningBid,
        uint256 secondPrice
    );
    event Withdrawal(address indexed bidder, uint256 amount);

    // ──────────────────── Modifiers ────────────────────
    modifier onlyDuring(uint256 deadline) {
        require(block.timestamp <= deadline, "Phase has ended");
        _;
    }

    modifier onlyAfter(uint256 deadline) {
        require(block.timestamp > deadline, "Phase not yet ended");
        _;
    }

    // ──────────────────── Constructor ────────────────────
    /**
     * @param _itemDescription  Human-readable description of the auctioned item.
     * @param _reservePrice     Minimum acceptable bid (in wei). Deposits must be >= this.
     * @param _commitDuration   Seconds from deployment until commit phase ends.
     * @param _revealDuration   Seconds from commit deadline until reveal phase ends.
     */
    constructor(
        string memory _itemDescription,
        uint256 _reservePrice,
        uint256 _commitDuration,
        uint256 _revealDuration
    ) {
        require(_commitDuration > 0, "Commit duration must be > 0");
        require(_revealDuration > 0, "Reveal duration must be > 0");

        seller = msg.sender;
        itemDescription = _itemDescription;
        reservePrice = _reservePrice;
        commitDeadline = block.timestamp + _commitDuration;
        revealDeadline = commitDeadline + _revealDuration;
    }

    // ──────────────────── Commit Phase ────────────────────
    /**
     * @notice Submit a sealed bid. `_commitHash` = keccak256(abi.encodePacked(bidValue, nonce)).
     *         Must send ETH deposit >= reservePrice (covers potential payment).
     */
    function commitBid(
        bytes32 _commitHash
    ) external payable onlyDuring(commitDeadline) {
        require(msg.sender != seller, "Seller cannot bid");
        require(
            commits[msg.sender].commitHash == bytes32(0),
            "Already committed"
        );
        require(msg.value >= reservePrice, "Deposit below reserve price");

        commits[msg.sender] = Commit({
            commitHash: _commitHash,
            deposit: msg.value,
            revealed: false,
            bidValue: 0
        });
        bidders.push(msg.sender);

        emit BidCommitted(msg.sender, _commitHash);
    }

    // ──────────────────── Reveal Phase ────────────────────
    /**
     * @notice Reveal your bid. Must match the previously committed hash.
     * @param _bidValue  The actual bid amount (in wei).
     * @param _nonce     The random nonce used when committing.
     */
    function revealBid(
        uint256 _bidValue,
        bytes32 _nonce
    ) external onlyAfter(commitDeadline) onlyDuring(revealDeadline) {
        Commit storage c = commits[msg.sender];
        require(c.commitHash != bytes32(0), "No commit found");
        require(!c.revealed, "Already revealed");

        bytes32 expectedHash = keccak256(abi.encodePacked(_bidValue, _nonce));
        require(expectedHash == c.commitHash, "Hash mismatch");
        require(_bidValue >= reservePrice, "Bid below reserve price");
        require(_bidValue <= c.deposit, "Bid exceeds deposit");

        c.revealed = true;
        c.bidValue = _bidValue;

        emit BidRevealed(msg.sender, _bidValue);
    }

    // ──────────────────── Finalize ────────────────────
    /**
     * @notice Determine the winner (highest bid) and the payment (second-highest bid).
     *         Can be called by anyone after the reveal deadline.
     */
    function finalize() external onlyAfter(revealDeadline) {
        require(!finalized, "Already finalized");
        finalized = true;

        uint256 highest = 0;
        uint256 secondHighest = 0;
        address highestBidder = address(0);

        for (uint256 i = 0; i < bidders.length; i++) {
            Commit storage c = commits[bidders[i]];
            if (!c.revealed) continue; // unrevealed bids are forfeit

            if (c.bidValue > highest) {
                secondHighest = highest;
                highest = c.bidValue;
                highestBidder = bidders[i];
            } else if (c.bidValue > secondHighest) {
                secondHighest = c.bidValue;
            }
        }

        // If only one valid bid, they pay their own bid (or reserve)
        if (secondHighest == 0) {
            secondHighest = reservePrice;
        }

        winner = highestBidder;
        winningBid = highest;
        secondPrice = secondHighest;

        emit AuctionFinalized(winner, winningBid, secondPrice);
    }

    // ──────────────────── Withdraw ────────────────────
    /**
     * @notice After finalization, withdraw your funds.
     *         - Winner gets back (deposit - secondPrice); secondPrice goes to seller.
     *         - Losers who revealed get full deposit back.
     *         - Bidders who did NOT reveal forfeit their deposit to the seller.
     */
    function withdraw() external {
        require(finalized, "Not finalized yet");

        Commit storage c = commits[msg.sender];
        require(c.deposit > 0, "Nothing to withdraw");

        uint256 refund;

        if (msg.sender == winner) {
            // Winner pays secondPrice
            refund = c.deposit - secondPrice;
            c.deposit = 0;
        } else if (c.revealed) {
            // Losing bidder who revealed: full refund
            refund = c.deposit;
            c.deposit = 0;
        } else {
            // Did not reveal: forfeit deposit (goes to seller via sellerWithdraw)
            // Do NOT clear deposit here; seller collects it
            refund = 0;
        }

        if (refund > 0) {
            (bool sent, ) = payable(msg.sender).call{value: refund}("");
            require(sent, "Transfer failed");
            emit Withdrawal(msg.sender, refund);
        }
    }

    /**
     * @notice Seller withdraws the secondPrice payment plus any forfeited deposits.
     */
    function sellerWithdraw() external {
        require(msg.sender == seller, "Only seller");
        require(finalized, "Not finalized yet");

        uint256 sellerAmount = secondPrice;

        // Add forfeited deposits (bidders who committed but did not reveal)
        for (uint256 i = 0; i < bidders.length; i++) {
            Commit storage c = commits[bidders[i]];
            if (!c.revealed && c.deposit > 0 && bidders[i] != winner) {
                sellerAmount += c.deposit;
                c.deposit = 0;
            }
        }

        secondPrice = 0; // prevent double withdraw

        (bool sent, ) = payable(seller).call{value: sellerAmount}("");
        require(sent, "Transfer failed");
        emit Withdrawal(seller, sellerAmount);
    }

    // ──────────────────── View Helpers ────────────────────
    function getBiddersCount() external view returns (uint256) {
        return bidders.length;
    }

    /**
     * @notice Helper: compute the commit hash off-chain or in tests.
     */
    function computeCommitHash(
        uint256 _bidValue,
        bytes32 _nonce
    ) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(_bidValue, _nonce));
    }
}

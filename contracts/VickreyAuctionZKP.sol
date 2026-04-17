// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IGroth16Verifier {
    function verifyProof(
        uint[2] calldata _pA,
        uint[2][2] calldata _pB,
        uint[2] calldata _pC,
        uint[8] calldata _pubSignals
    ) external view returns (bool);
}

/**
 * @title VickreyAuctionZKP
 * @notice Full trustless second-price sealed-bid auction with ZKP + ECIES.
 *
 * This is the complete implementation from the paper:
 *   1. COMMIT — bidders submit Poseidon(bidValue, nonce) + ETH deposit
 *   2. ENCRYPTED REVEAL — bidders encrypt (bidValue, nonce) with seller's ECIES key
 *   3. SELLER PROVES — seller decrypts bids, then submits a Groth16 ZKP proving:
 *        a) They know all bid values whose Poseidon hashes match commitments
 *        b) The declared winner has the highest bid
 *        c) The declared second price is the second-highest bid
 *      WITHOUT revealing any individual bid values on-chain!
 *   4. WITHDRAW — winner pays second price, losers get full refund
 *
 * Trust model:
 *   Fully trustless. The seller CANNOT fabricate results because:
 *   - They must provide a valid ZKP that passes on-chain verification
 *   - The ZKP circuit enforces correct winner/second-price computation
 *   - Bid values remain private (only seller knows them via ECIES)
 *
 * Note: Uses Poseidon hash (ZK-friendly) instead of Keccak256 for commitments.
 *       Poseidon hashing is done off-chain (JS) and verified inside the ZKP circuit.
 */
contract VickreyAuctionZKP {
    uint256 public constant MAX_BIDDERS = 4;

    address public seller;
    string public itemDescription;
    uint256 public reservePrice;

    uint256 public commitDeadline;
    uint256 public revealDeadline;

    bytes public sellerPublicKey; // ECIES public key
    IGroth16Verifier public verifier; // On-chain ZKP verifier

    bool public finalized;
    address public winner;
    uint256 public winningBid; // not revealed on-chain (only winner index)
    uint256 public secondPrice;

    struct Commit {
        uint256 commitHash; // Poseidon hash (field element, not bytes32)
        uint256 deposit;
        bytes encryptedBid;
        bool hasEncryptedReveal;
    }

    mapping(address => Commit) public commits;
    address[] public bidders;

    // ──────────────────── Events ────────────────────
    event BidCommitted(address indexed bidder, uint256 commitHash);
    event EncryptedBidSubmitted(address indexed bidder);
    event AuctionFinalized(address indexed winner, uint256 secondPrice);
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
    constructor(
        string memory _itemDescription,
        uint256 _reservePrice,
        uint256 _commitDuration,
        uint256 _revealDuration,
        bytes memory _sellerPublicKey,
        address _verifier
    ) {
        require(_commitDuration > 0, "Commit duration must be > 0");
        require(_revealDuration > 0, "Reveal duration must be > 0");
        require(_sellerPublicKey.length > 0, "Public key required");
        require(_verifier != address(0), "Verifier required");

        seller = msg.sender;
        itemDescription = _itemDescription;
        reservePrice = _reservePrice;
        commitDeadline = block.timestamp + _commitDuration;
        revealDeadline = commitDeadline + _revealDuration;
        sellerPublicKey = _sellerPublicKey;
        verifier = IGroth16Verifier(_verifier);
    }

    // ──────────────────── Phase 1: Commit ────────────────────
    /**
     * @notice Submit Poseidon(bidValue, nonce) as commitment.
     *         Poseidon hash is computed off-chain (JS) using circomlib.
     */
    function commitBid(
        uint256 _commitHash
    ) external payable onlyDuring(commitDeadline) {
        require(msg.sender != seller, "Seller cannot bid");
        require(commits[msg.sender].commitHash == 0, "Already committed");
        require(msg.value >= reservePrice, "Deposit below reserve price");
        require(bidders.length < MAX_BIDDERS, "Max bidders reached");

        commits[msg.sender] = Commit({
            commitHash: _commitHash,
            deposit: msg.value,
            encryptedBid: "",
            hasEncryptedReveal: false
        });
        bidders.push(msg.sender);

        emit BidCommitted(msg.sender, _commitHash);
    }

    // ──────────────────── Phase 2: Encrypted Reveal ────────────────────
    function submitEncryptedBid(
        bytes calldata _ciphertext
    ) external onlyAfter(commitDeadline) onlyDuring(revealDeadline) {
        Commit storage c = commits[msg.sender];
        require(c.commitHash != 0, "No commit found");
        require(!c.hasEncryptedReveal, "Already submitted");

        c.encryptedBid = _ciphertext;
        c.hasEncryptedReveal = true;

        emit EncryptedBidSubmitted(msg.sender);
    }

    // ──────────────────── Phase 3: Seller Finalizes with ZKP ────────────────────
    /**
     * @notice Seller submits a Groth16 proof that the declared results are correct.
     *         The proof verifies (inside the circuit) that:
     *           - All commitment hashes match Poseidon(bidValue, nonce)
     *           - declaredWinnerIdx has the maximum bid
     *           - declaredSecondPrice is the second-highest bid
     *
     * @param _pA        Groth16 proof point A
     * @param _pB        Groth16 proof point B
     * @param _pC        Groth16 proof point C
     * @param _winnerIdx Index into the bidders array
     * @param _secondPrice The second-highest bid (this IS revealed on-chain — it's the payment)
     */
    function finalizeWithProof(
        uint[2] calldata _pA,
        uint[2][2] calldata _pB,
        uint[2] calldata _pC,
        uint256 _winnerIdx,
        uint256 _secondPrice
    ) external onlyAfter(revealDeadline) {
        require(msg.sender == seller, "Only seller");
        require(!finalized, "Already finalized");
        require(_winnerIdx < bidders.length, "Invalid winner index");

        // Build public signals array matching circuit order:
        // [commitHashes[0..3], numActiveBidders, declaredWinnerIdx, declaredSecondPrice, reservePrice]
        uint[8] memory pubSignals;

        // Fill commit hashes (pad with 0 for unused slots)
        for (uint256 i = 0; i < MAX_BIDDERS; i++) {
            if (i < bidders.length) {
                pubSignals[i] = commits[bidders[i]].commitHash;
            } else {
                pubSignals[i] = 0;
            }
        }
        pubSignals[4] = bidders.length;
        pubSignals[5] = _winnerIdx;
        pubSignals[6] = _secondPrice;
        pubSignals[7] = reservePrice;

        // Verify the ZKP on-chain!
        bool valid = verifier.verifyProof(_pA, _pB, _pC, pubSignals);
        require(valid, "Invalid ZKP proof");

        finalized = true;
        winner = bidders[_winnerIdx];
        secondPrice = _secondPrice;

        emit AuctionFinalized(winner, secondPrice);
    }

    // ──────────────────── Withdraw ────────────────────
    function withdraw() external {
        require(finalized, "Not finalized yet");

        Commit storage c = commits[msg.sender];
        require(c.deposit > 0, "Nothing to withdraw");

        uint256 refund;

        if (msg.sender == winner) {
            refund = c.deposit - secondPrice;
            c.deposit = 0;
        } else if (c.hasEncryptedReveal) {
            refund = c.deposit;
            c.deposit = 0;
        } else {
            refund = 0;
        }

        if (refund > 0) {
            (bool sent, ) = payable(msg.sender).call{value: refund}("");
            require(sent, "Transfer failed");
            emit Withdrawal(msg.sender, refund);
        }
    }

    function sellerWithdraw() external {
        require(msg.sender == seller, "Only seller");
        require(finalized, "Not finalized yet");

        uint256 sellerAmount = secondPrice;

        for (uint256 i = 0; i < bidders.length; i++) {
            Commit storage c = commits[bidders[i]];
            if (
                !c.hasEncryptedReveal && c.deposit > 0 && bidders[i] != winner
            ) {
                sellerAmount += c.deposit;
                c.deposit = 0;
            }
        }

        secondPrice = 0;

        (bool sent, ) = payable(seller).call{value: sellerAmount}("");
        require(sent, "Transfer failed");
        emit Withdrawal(seller, sellerAmount);
    }

    // ──────────────────── View Helpers ────────────────────
    function getBiddersCount() external view returns (uint256) {
        return bidders.length;
    }

    function getEncryptedBid(
        address _bidder
    ) external view returns (bytes memory) {
        return commits[_bidder].encryptedBid;
    }

    function getCommitHash(address _bidder) external view returns (uint256) {
        return commits[_bidder].commitHash;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title VickreyAuctionECIES
 * @notice Second-price sealed-bid auction with ECIES encrypted reveals.
 *
 * Improvement over basic commit-reveal:
 *   In the basic version, bidders reveal bids publicly on-chain during the reveal phase.
 *   This means other bidders can see earlier reveals and strategically decide whether to reveal.
 *
 *   With ECIES, bidders encrypt their reveal data with the seller's public key.
 *   Nobody can read each others' bids during the reveal phase — only the seller can decrypt.
 *   After the reveal deadline, the seller decrypts all bids off-chain and submits them
 *   to the contract for on-chain verification.
 *
 * Flow:
 *   1. Seller deploys contract and publishes their ECIES public key.
 *   2. COMMIT — bidders submit hash(bidValue, nonce) + ETH deposit.
 *   3. ENCRYPTED REVEAL — bidders encrypt (bidValue, nonce) with seller's public key,
 *      submit ciphertext on-chain. Nobody else can read it.
 *   4. SELLER DECLARES — seller decrypts all bids off-chain, then submits all
 *      (bidder, bidValue, nonce) tuples to the contract. Contract verifies every
 *      hash matches its commitment, then computes winner & second price.
 *   5. WITHDRAW — same as basic version.
 *
 * Trust model (without ZKP):
 *   The seller MUST honestly reveal all bids. If the seller withholds or fabricates
 *   bids, they cannot pass the on-chain hash verification. However, the seller could
 *   choose to not reveal some bidders' bids (censorship). ZKP would be needed to
 *   fully eliminate this trust requirement.
 */
contract VickreyAuctionECIES {
    // ──────────────────── State ────────────────────
    address public seller;
    string public itemDescription;
    uint256 public reservePrice;

    uint256 public commitDeadline;
    uint256 public revealDeadline;

    bytes public sellerPublicKey; // ECIES public key (uncompressed, 65 bytes)

    bool public finalized;
    address public winner;
    uint256 public winningBid;
    uint256 public secondPrice;

    struct Commit {
        bytes32 commitHash;
        uint256 deposit;
        bytes encryptedBid; // ECIES ciphertext
        bool hasEncryptedReveal;
        bool verified; // seller has revealed and contract verified
        uint256 bidValue;
    }

    mapping(address => Commit) public commits;
    address[] public bidders;

    // ──────────────────── Events ────────────────────
    event SellerKeyPublished(bytes publicKey);
    event BidCommitted(address indexed bidder, bytes32 commitHash);
    event EncryptedBidSubmitted(address indexed bidder);
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
    constructor(
        string memory _itemDescription,
        uint256 _reservePrice,
        uint256 _commitDuration,
        uint256 _revealDuration,
        bytes memory _sellerPublicKey
    ) {
        require(_commitDuration > 0, "Commit duration must be > 0");
        require(_revealDuration > 0, "Reveal duration must be > 0");
        require(_sellerPublicKey.length > 0, "Public key required");

        seller = msg.sender;
        itemDescription = _itemDescription;
        reservePrice = _reservePrice;
        commitDeadline = block.timestamp + _commitDuration;
        revealDeadline = commitDeadline + _revealDuration;
        sellerPublicKey = _sellerPublicKey;

        emit SellerKeyPublished(_sellerPublicKey);
    }

    // ──────────────────── Phase 1: Commit ────────────────────
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
            encryptedBid: "",
            hasEncryptedReveal: false,
            verified: false,
            bidValue: 0
        });
        bidders.push(msg.sender);

        emit BidCommitted(msg.sender, _commitHash);
    }

    // ──────────────────── Phase 2: Encrypted Reveal ────────────────────
    /**
     * @notice Submit your bid encrypted with the seller's ECIES public key.
     *         The ciphertext should contain abi.encode(bidValue, nonce).
     */
    function submitEncryptedBid(
        bytes calldata _ciphertext
    ) external onlyAfter(commitDeadline) onlyDuring(revealDeadline) {
        Commit storage c = commits[msg.sender];
        require(c.commitHash != bytes32(0), "No commit found");
        require(!c.hasEncryptedReveal, "Already submitted encrypted bid");

        c.encryptedBid = _ciphertext;
        c.hasEncryptedReveal = true;

        emit EncryptedBidSubmitted(msg.sender);
    }

    // ──────────────────── Phase 3: Seller Declares Results ────────────────────
    /**
     * @notice Seller decrypts all bids off-chain, then submits the plaintext values
     *         for on-chain verification. The contract verifies every hash matches
     *         and computes the winner.
     *
     * @param _bidders   Array of bidder addresses (only those who submitted encrypted reveals).
     * @param _values    Corresponding bid values.
     * @param _nonces    Corresponding nonces.
     */
    function sellerDeclareAllBids(
        address[] calldata _bidders,
        uint256[] calldata _values,
        bytes32[] calldata _nonces
    ) external onlyAfter(revealDeadline) {
        require(msg.sender == seller, "Only seller");
        require(!finalized, "Already finalized");
        require(
            _bidders.length == _values.length &&
                _values.length == _nonces.length,
            "Array length mismatch"
        );

        uint256 highest = 0;
        uint256 secondHighest = 0;
        address highestBidder = address(0);

        for (uint256 i = 0; i < _bidders.length; i++) {
            Commit storage c = commits[_bidders[i]];
            require(c.hasEncryptedReveal, "Bidder has no encrypted reveal");

            // On-chain hash verification: seller cannot fabricate bids
            bytes32 hash = keccak256(abi.encodePacked(_values[i], _nonces[i]));
            require(hash == c.commitHash, "Hash mismatch - bid tampered");
            require(_values[i] >= reservePrice, "Bid below reserve price");
            require(_values[i] <= c.deposit, "Bid exceeds deposit");

            c.verified = true;
            c.bidValue = _values[i];

            if (_values[i] > highest) {
                secondHighest = highest;
                highest = _values[i];
                highestBidder = _bidders[i];
            } else if (_values[i] > secondHighest) {
                secondHighest = _values[i];
            }
        }

        if (secondHighest == 0) {
            secondHighest = reservePrice;
        }

        finalized = true;
        winner = highestBidder;
        winningBid = highest;
        secondPrice = secondHighest;

        emit AuctionFinalized(winner, winningBid, secondPrice);
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
        } else if (c.verified) {
            // Verified (seller revealed their bid): full refund
            refund = c.deposit;
            c.deposit = 0;
        } else {
            // Not verified (didn't submit encrypted reveal, or seller excluded them)
            // Forfeit deposit
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

        // Add forfeited deposits
        for (uint256 i = 0; i < bidders.length; i++) {
            Commit storage c = commits[bidders[i]];
            if (!c.verified && c.deposit > 0 && bidders[i] != winner) {
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

    function computeCommitHash(
        uint256 _bidValue,
        bytes32 _nonce
    ) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(_bidValue, _nonce));
    }

    function getEncryptedBid(
        address _bidder
    ) external view returns (bytes memory) {
        return commits[_bidder].encryptedBid;
    }
}

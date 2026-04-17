# CMU 15-621 Final Project: Trustless Vickrey Auction on Ethereum

A second-price sealed-bid (Vickrey) auction implemented as Ethereum smart contracts, with three progressive versions demonstrating increasing levels of privacy and trustlessness.

## Overview

In a Vickrey auction, the highest bidder wins but pays the **second-highest** bid. This incentivizes truthful bidding. Our implementation brings this mechanism on-chain with cryptographic guarantees.

| Version | Contract | Privacy | Trust Model |
|---------|----------|---------|-------------|
| **V1: Basic** | `VickreyAuction.sol` | Bids public after reveal | Fully trustless (on-chain computation) |
| **V2: ECIES** | `VickreyAuctionECIES.sol` | Bids encrypted (only seller sees) | Trust seller to reveal honestly |
| **V3: ZKP** | `VickreyAuctionZKP.sol` | Bids encrypted + ZKP verified | **Fully trustless** (zero-knowledge proof) |

## Architecture

### V1: Commit-Reveal

```
Bidder → H(bid, nonce) → Contract    [Commit Phase]
Bidder → (bid, nonce)  → Contract    [Reveal Phase - public]
Anyone → finalize()    → Contract    [Contract computes winner]
```

### V2: ECIES Encrypted Reveal

```
Bidder → H(bid, nonce)           → Contract    [Commit]
Bidder → Encrypt(bid, nonce, pk) → Contract    [Encrypted Reveal]
Seller → decrypt → declare all   → Contract    [Seller reveals, contract verifies hashes]
```

### V3: ZKP (Full Paper Implementation)

```
Bidder → Poseidon(bid, nonce)    → Contract    [Commit with ZK-friendly hash]
Bidder → Encrypt(bid, nonce, pk) → Contract    [Encrypted Reveal]
Seller → decrypt → generate ZKP  → Contract    [Groth16 proof verified on-chain]
```

The ZKP circuit (Circom) proves:
1. All commitment hashes match `Poseidon(bidValue, nonce)`
2. The declared winner has the maximum bid
3. The declared second price is the second-highest bid

**Without revealing any individual bid values on-chain.**

## Project Structure

```
final project/
├── contracts/
│   ├── VickreyAuction.sol          # V1: Basic commit-reveal
│   ├── VickreyAuctionECIES.sol     # V2: + ECIES encryption
│   ├── VickreyAuctionZKP.sol       # V3: + Zero-knowledge proofs
│   └── Groth16Verifier.sol         # Auto-generated ZKP verifier
├── test/
│   ├── VickreyAuction.js           # 25 tests
│   ├── VickreyAuctionECIES.js      # 17 tests
│   └── VickreyAuctionZKP.js        # 5 tests
├── scripts/
│   ├── demo.js                     # V1 interactive demo
│   ├── demoECIES.js                # V2 interactive demo
│   └── buildCircuit.sh             # Compile ZKP circuit
├── circuits/
│   └── vickrey.circom              # ZKP circuit (4215 constraints)
└── hardhat.config.js
```

## Quick Start

### Prerequisites

- Node.js >= 18
- [Circom](https://docs.circom.io/getting-started/installation/) (for ZKP circuit compilation)

### Step 1: Clone & Install Dependencies

```bash
git clone git@github.com:wodex1nhaoIeng/cmu-15621-final-project.git
cd cmu-15621-final-project
npm install
```

### Step 2: Build ZKP Circuit

The ZKP version requires Circom to compile the circuit. Install it first:

```bash
# Install Circom compiler (requires Rust)
cargo install --git https://github.com/iden3/circom.git --tag v2.2.3
```

Then build the circuit (compiles circuit, performs Groth16 trusted setup, generates Solidity verifier):

```bash
bash scripts/buildCircuit.sh
```

> **Note:** V1 and V2 tests work without this step. Only V3 (ZKP) requires it.

### Step 3: Run Tests

```bash
# Run all 47 tests
npx hardhat test

# Run specific version
npx hardhat test test/VickreyAuction.js       # V1: 25 tests
npx hardhat test test/VickreyAuctionECIES.js   # V2: 17 tests
npx hardhat test test/VickreyAuctionZKP.js     # V3: 5 tests (requires Step 2)
```

### Step 4: Run Demos

```bash
npx hardhat run scripts/demo.js         # V1: basic auction demo
npx hardhat run scripts/demoECIES.js    # V2: encrypted auction demo
```

## Technologies

- **Solidity** — Smart contract language
- **Hardhat** — Ethereum development framework
- **Circom + snarkjs** — Zero-knowledge proof circuit and prover
- **Groth16** — ZKP proving system
- **Poseidon Hash** — ZK-friendly hash function
- **ECIES (eciesjs)** — Elliptic Curve Integrated Encryption Scheme
- **circomlibjs** — JavaScript Poseidon hash implementation

## Test Results

```
47 passing

  VickreyAuction:     25 passing  (basic commit-reveal)
  VickreyAuctionECIES: 17 passing (encrypted reveals)
  VickreyAuctionZKP:   5 passing  (zero-knowledge proofs)
```

## Group 7

CMU 15-621 Blockchain Technologies, Spring 2026

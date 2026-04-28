# CMU 15-621 Final Project: Trustless Vickrey Auction on Ethereum

A second-price sealed-bid (Vickrey) auction implemented as Ethereum smart contracts.

## Overview

In a Vickrey auction, the highest bidder wins but pays the **second-highest** bid. This incentivizes truthful bidding. Our implementation brings this mechanism on-chain with cryptographic guarantees.

## Project Structure

```
final project/
├── contracts/
│   └── VickreyAuction.sol
├── test/
│   ├── zk-proof/
│   │   ├── pedersen.js
│   │   ├── proofMaximum.js
│   │   ├── proofMembership.js
│   │   └── sigma.js
│   └── VickreyAuction.js
├── scripts/
│   └── demo.js 
├── src/
│   └── zk-proof/
│       ├── pedersen.js
│       ├── proofMaximum.js
│       ├── proofMembership.js
│       └── sigma.js
└── hardhat.config.js
```

## Quick Start

### Prerequisites

- Node.js >= 18

### Step 1: Clone & Install Dependencies

```bash
git clone git@github.com:wodex1nhaoIeng/cmu-15621-final-project.git
cd cmu-15621-final-project
npm install
```

### Step 2: Run Tests

```bash
npx hardhat test
```

### Step 3: Run Demos

```bash
npx hardhat run scripts/demo.js
```

## Group 7

CMU 15-621 Blockchain Technologies, Spring 2026

#!/bin/bash
# Build script: compile circom circuit, perform trusted setup, generate Solidity verifier
# Usage: bash scripts/buildCircuit.sh

set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CIRCUIT_DIR="$PROJECT_DIR/circuits"
BUILD_DIR="$PROJECT_DIR/circuits/build"

echo "=== Building Vickrey Auction ZKP Circuit ==="

# Create build directory
mkdir -p "$BUILD_DIR"

# Step 1: Compile the circuit
echo "[1/5] Compiling circom circuit..."
circom "$CIRCUIT_DIR/vickrey.circom" \
  --r1cs --wasm --sym \
  -o "$BUILD_DIR" \
  -l "$PROJECT_DIR/node_modules"

echo "  Constraints: $(npx snarkjs r1cs info "$BUILD_DIR/vickrey.r1cs" 2>&1 | grep "Constraints:" || true)"

# Step 2: Download powers of tau (for trusted setup)
# Using a pre-computed powers of tau file (sufficient for circuits up to 2^16 constraints)
PTAU_FILE="$BUILD_DIR/pot16_final.ptau"
if [ ! -f "$PTAU_FILE" ]; then
  echo "[2/5] Downloading powers of tau ceremony file..."
  curl -L -o "$PTAU_FILE" \
    "https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_16.ptau"
else
  echo "[2/5] Powers of tau file already exists, skipping download."
fi

# Step 3: Generate proving key (circuit-specific trusted setup)
echo "[3/5] Generating proving key (Groth16 setup)..."
npx snarkjs groth16 setup "$BUILD_DIR/vickrey.r1cs" "$PTAU_FILE" "$BUILD_DIR/vickrey_0000.zkey"

# Add a contribution (in production, this would be a multi-party ceremony)
echo "test_contribution" | npx snarkjs zkey contribute "$BUILD_DIR/vickrey_0000.zkey" "$BUILD_DIR/vickrey_final.zkey" --name="test_contribution"

# Export verification key
npx snarkjs zkey export verificationkey "$BUILD_DIR/vickrey_final.zkey" "$BUILD_DIR/verification_key.json"

# Step 4: Generate Solidity verifier contract
echo "[4/5] Generating Solidity verifier contract..."
npx snarkjs zkey export solidityverifier "$BUILD_DIR/vickrey_final.zkey" "$PROJECT_DIR/contracts/Groth16Verifier.sol"

echo "[5/5] Build complete!"
echo ""
echo "Generated files:"
echo "  - $BUILD_DIR/vickrey.r1cs          (R1CS constraint system)"
echo "  - $BUILD_DIR/vickrey_js/            (WASM witness generator)"
echo "  - $BUILD_DIR/vickrey_final.zkey     (proving key)"
echo "  - $BUILD_DIR/verification_key.json  (verification key)"
echo "  - $PROJECT_DIR/contracts/Groth16Verifier.sol (Solidity verifier)"

# Cardano Scavenger Rights Donation Bot

A **Node.js/Bun** script to **donate accumulated Scavenger rights** from multiple Cardano wallets (derived from BIP39 mnemonics) to a single destination address using the **Midnight TGE Scavenger API**.

This tool:
- Reads mnemonics from a CSV file
- Derives mainnet addresses using CIP-1852 (Cardano standard)
- Signs the required COSE-Sign1 message
- Submits donation requests with retry logic
- Supports **sequential** or **parallel** execution (rate-limit safe)

---

## Features

- **Zero on-chain transactions** – pure off-chain signature donation
- Uses `@emurgo/cardano-serialization-lib` for correct address derivation
- COSE-Sign1 signing compatible with Midnight TGE Scavenger backend
- CSV input with flexible column names (`mnemonic`, `seed`, etc.)
- Retry logic for 429, 500+, and network errors
- Configurable concurrency
- Works with **Bun** (fast) or **Node.js**

---

## Prerequisites

- [Bun](https://bun.sh) (recommended) or [Node.js](https://nodejs.org) ≥ 18
- A `seeds.csv` file with your wallet mnemonics

---

## Installation

```bash
# Clone the repo
git clone https://github.com/stanlagermin/cardano-scavenger-donate.git
cd cardano-scavenger-donate

# Install dependencies
bun install
# or: npm install

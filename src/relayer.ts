#!/usr/bin/env bun

import express from "express";
import { ethers } from "ethers";
import * as dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config();

const PORT = process.env.PORT || 4269;
const RPC_URL = process.env.RPC_URL;
const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY;
const ESCROW_ADDRESS = process.env.ESCROW_ADDRESS || "0x523B977C37d7F37Ea1Be4e4162F807C4EF888eEd";
const START_BLOCK = process.env.START_BLOCK ? parseInt(process.env.START_BLOCK) : 0;
const CHUNK_SIZE = 2000;

if (!RPC_URL || !RELAYER_PRIVATE_KEY || !ESCROW_ADDRESS || !process.env.START_BLOCK) {
  console.error("Missing required environment variables: RPC_URL, RELAYER_PRIVATE_KEY, ESCROW_ADDRESS, START_BLOCK");
  process.exit(1);
}

// Define the ESCROW contract ABI (same as used in cli.ts)
const ESCROW_ABI = [
  "function deposit(address stealthAddress, bytes calldata senderPubKey) external payable",
  "function claim(address stealthAddress, address recipient, bytes memory signature) external",
  "function deposits(address) external view returns (uint256)",
  "event EtherDeposited(address indexed stealthAddress, uint256 amount, bytes senderPubKey)"
];

// Initialize provider and relayer wallet
const provider = new ethers.JsonRpcProvider(RPC_URL);
const relayerWallet = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);
console.log("Relayer wallet address:", relayerWallet.address);

// Create an instance of the escrow contract using the relayer wallet (so transactions are signed by it)
const escrowContract = new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, relayerWallet);

// Cache of stealth addresses to their ephemeral public keys
const stealthAddressCache = new Map<string, string>();

// Function to scan historical events
async function scanHistoricalEvents(): Promise<void> {
  console.log("Scanning historical events...");
  const currentBlock = await provider.getBlockNumber();
  let fromBlock = START_BLOCK;
  let totalEvents = 0;

  while (fromBlock < currentBlock) {
    const toBlock = Math.min(fromBlock + CHUNK_SIZE, currentBlock);
    console.log(`Scanning blocks ${fromBlock} to ${toBlock}...`);

    const filter = escrowContract.filters.EtherDeposited();
    const events = await escrowContract.queryFilter(filter, fromBlock, toBlock);

    for (const event of events) {
      const { stealthAddress, senderPubKey } = event.args;
      stealthAddressCache.set(stealthAddress.toLowerCase(), ethers.hexlify(senderPubKey));
      totalEvents++;
    }
    
    fromBlock = toBlock + 1;
  }

  console.log(`Finished scanning. Cached ${totalEvents} events from blocks ${START_BLOCK} to ${currentBlock}`);
}

// Function to handle new deposit events
function setupEventListener(): void {
  escrowContract.on("EtherDeposited", (stealthAddress: string, amount: bigint, senderPubKey: Uint8Array) => {
    console.log(`New deposit detected for stealth address: ${stealthAddress}`);
    stealthAddressCache.set(stealthAddress.toLowerCase(), ethers.hexlify(senderPubKey));
  });
  console.log("Listening for new deposit events...");
}

// Setup Express server
const app = express();
app.use(express.json()); // Parse JSON bodies

/**
 * GET /deposits
 * Returns a map of all known stealth addresses and their ephemeral public keys
 */
app.get("/deposits", (_req, res) => {
  const map = Object.fromEntries(stealthAddressCache);
  return res.json({ 
    count: stealthAddressCache.size,
    map
  });
});

/**
 * GET /pubkey/:stealthAddress
 * Returns the ephemeral public key for a given stealth address
 */
app.get("/pubkey/:stealthAddress", (req, res) => {
  const stealthAddress = req.params.stealthAddress.toLowerCase();
  const pubKey = stealthAddressCache.get(stealthAddress);

  if (!pubKey) {
    return res.status(404).json({ 
      error: "Stealth address not found",
      message: "No deposit event found for this stealth address" 
    });
  }

  return res.json({ 
    stealthAddress,
    ephemeralPublicKey: pubKey
  });
});

/**
 * POST /claim
 * Expects a JSON body with:
 *   - chainId: string or number that must match the configured chain id.
 *   - stealthAddress: string (the stealth address holding the funds).
 *   - signature: string (the signature of a message hash signed by the stealth wallet).
 */
app.post("/claim", async (req, res) => {
  try {
    const { chainId, stealthAddress, receiver, signature } = req.body;
    if (!chainId || !stealthAddress || !receiver || !signature) {
      return res.status(400).json({ error: "Missing required fields: chainId, stealthAddress, receiver, signature" });
    }

    // Verify the stealth address exists in our cache
    if (!stealthAddressCache.has(stealthAddress.toLowerCase())) {
      return res.status(404).json({ 
        error: "Unknown stealth address",
        message: "No deposit event found for this stealth address" 
      });
    }

    console.log(`Processing claim:
    Stealth Address: ${stealthAddress}
    Receiver: ${receiver}
    Chain ID: ${chainId}`);

    // Call the claim method on the escrow contract.
    // Note: The contract's claim function expects (stealthAddress, recipient, signature)
    // Here, the relayer's address is used as the recipient.
    const tx = await escrowContract.claim(stealthAddress, receiver, signature);
    console.log("Transaction submitted. Hash:", tx.hash);

    // Wait for the transaction to be confirmed.
    const receipt = await tx.wait();
    console.log("Transaction confirmed:", receipt.hash);

    return res.json({
      message: "Funds claimed successfully",
      txHash: receipt.hash
    });
  } catch (error: any) {
    console.error("Error processing claim:", error);
    return res.status(500).json({ error: error.message || error.toString() });
  }
});

// Initialize and start the server
async function startServer(): Promise<void> {
  try {
    await scanHistoricalEvents();
    setupEventListener();

    app.listen(PORT, () => {
      console.log(`Relayer API listening on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

// Start the server
startServer(); 
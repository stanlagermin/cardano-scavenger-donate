// donate.js
import * as CardanoWasm from "@emurgo/cardano-serialization-lib-nodejs";
import * as bip39 from "bip39";
import cbor from "cbor";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parse } from "csv-parse/sync";

// ---------------------------------------------------------------------
// CONFIGURATION
// ---------------------------------------------------------------------
const DESTINATION_ADDRESS =
  "addr1qxg6wcdly3sr563x3pxv0qm5ukw4rdxxz983f93mj57cprqexqzssdmr839pgsuptwck7gacxjgp5al5zyzg2hknxe2s5km6gj"; // change to your wallet
const API_BASE = "https://scavenger.prod.gd.midnighttge.io/donate_to";
const CSV_FILE = "seeds.csv"; // change if needed
const PARALLEL = false; // true → limited concurrency, false → sequential
const MAX_CONCURRENT = 5; // only used when PARALLEL=true

// ---------------------------------------------------------------------
const harden = (n) => 0x80000000 + n;

// ---------------------------------------------------------------------
// SIGNING HELPERS
// ---------------------------------------------------------------------
function signMessage(privateKey, addressBech32, message) {
  const payload = Buffer.from(message, "utf8");

  // address bytes from Bech32 string
  const addressObj = CardanoWasm.Address.from_bech32(addressBech32);
  const addressBytes = Buffer.from(addressObj.to_bytes());

  const protectedHeader = cbor.encodeCanonical({ 1: -8, address: addressBytes });
  const unprotectedHeader = cbor.encodeCanonical({ hashed: false });

  const toBeSigned = cbor.encode([
    "Signature1",
    protectedHeader,
    Buffer.alloc(0),
    payload,
  ]);

  const signature = privateKey.sign(toBeSigned);
  const coseSign1 = [
    protectedHeader,
    unprotectedHeader,
    payload,
    Buffer.from(signature.to_bytes()),
  ];

  return cbor.encode(coseSign1).toString("hex");
}

// ---------------------------------------------------------------------
// DERIVE WALLET FROM MNEMONIC
// ---------------------------------------------------------------------
function deriveFromMnemonic(mnemonic) {
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error(`Invalid mnemonic: ${mnemonic.slice(0, 30)}…`);
  }

  const entropy = bip39.mnemonicToEntropy(mnemonic);
  const rootKey = CardanoWasm.Bip32PrivateKey.from_bip39_entropy(
    Buffer.from(entropy, "hex"),
    Buffer.from("")
  );

  const accountKey = rootKey
    .derive(harden(1852))
    .derive(harden(1815))
    .derive(harden(0));

  const paymentPrvKey = accountKey.derive(0).derive(0).to_raw_key();
  const publicKey = paymentPrvKey.to_public();
  const stakePrvKey = accountKey.derive(2).derive(0).to_raw_key();
  const stakePublicKey = stakePrvKey.to_public();

  const baseAddr = CardanoWasm.BaseAddress.new(
    CardanoWasm.NetworkInfo.mainnet().network_id(),
    CardanoWasm.Credential.from_keyhash(publicKey.hash()),
    CardanoWasm.Credential.from_keyhash(stakePublicKey.hash())
  );

  const address = baseAddr.to_address();
  const addressBech32 = address.to_bech32();

  return { paymentPrvKey, addressBech32 };
}

// ---------------------------------------------------------------------
// DONATE SINGLE WALLET
// ---------------------------------------------------------------------
async function donateWallet(dest, orig, sig) {
  const url = `${API_BASE}/${dest}/${orig}/${sig}`;
  let attempt = 0;
  const maxAttempts = 3;

  while (attempt <= maxAttempts) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const text = await res.text();

      if (res.ok) {
        console.log(`SUCCESS: ${orig} → ${dest}`);
        console.log(text || "OK");
        return true;
      }
      if (res.status === 400) {
        console.error(`BAD SIG: ${orig} | ${text}`);
        return false;
      }
      if (res.status === 404) {
        console.error(`NOT REGISTERED: ${orig} | ${text}`);
        return false;
      }
      if (res.status === 409) {
        console.warn(`ALREADY DONE: ${orig} | ${text}`);
        return true;
      }

      // server / rate-limit errors
      if (res.status >= 500 || res.status === 429 || res.status === 408) {
        attempt++;
        const wait = 5000 * Math.pow(2, attempt - 1);
        console.warn(
          `Server ${res.status} – retry ${attempt}/${maxAttempts} in ${
            wait / 1000
          }s…`
        );
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }

      console.error(`Failed ${res.status}: ${orig} | ${text}`);
      return false;
    } catch (e) {
      attempt++;
      const wait = 5000 * Math.pow(2, attempt - 1);
      console.warn(
        `Network error – retry ${attempt}/${maxAttempts} in ${wait / 1000}s…`
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  console.error("Max retries exceeded for", orig);
  return false;
}

// ---------------------------------------------------------------------
// PROCESS ONE SEED
// ---------------------------------------------------------------------
async function processSeed(mnemonic) {
  try {
    const { paymentPrvKey, addressBech32 } = deriveFromMnemonic(mnemonic);
    const message = `Assign accumulated Scavenger rights to: ${DESTINATION_ADDRESS}`;
    const sig = signMessage(paymentPrvKey, addressBech32, message);

    console.log(
      `\nFrom: ${addressBech32}\nMessage: "${message}"\nSig: ${sig.slice(
        0,
        32
      )}…`
    );
    await donateWallet(DESTINATION_ADDRESS, addressBech32, sig);
  } catch (err) {
    console.error(`ERROR processing seed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------
// MAIN – READ CSV & DONATE
// ---------------------------------------------------------------------
(async () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const csvPath = path.resolve(__dirname, CSV_FILE);

  if (!fs.existsSync(csvPath)) {
    console.error(`CSV file not found: ${csvPath}`);
    process.exit(1);
  }

  const fileContent = fs.readFileSync(csvPath, "utf8");
  const records = parse(fileContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
  });

  const mnemonics = records
    .map((r) => r.mnemonic || Object.values(r)[0])
    .filter((m) => m && typeof m === "string");

  if (mnemonics.length === 0) {
    console.error("No valid mnemonics found in CSV.");
    process.exit(1);
  }

  console.log(`Loaded ${mnemonics.length} mnemonic(s) from ${CSV_FILE}`);

  if (PARALLEL) {
    // ---- limited concurrency ----
    const semaphore = (max) => {
      let active = 0;
      const queue = [];
      return (task) =>
        new Promise((resolve) => {
          const run = async () => {
            active++;
            await task();
            active--;
            resolve();
            if (queue.length) queue.shift()();
          };
          if (active < max) run();
          else queue.push(run);
        });
    };
    const run = semaphore(MAX_CONCURRENT);
    await Promise.all(mnemonics.map((m) => run(() => processSeed(m))));
  } else {
    // ---- sequential ----
    for (const m of mnemonics) {
      await processSeed(m);
    }
  }

  console.log("\nAll done.");
})();

#!/usr/bin/env node
// me-sol-cli.js — Solana Candy Machine v3 mint (Magic Eden), interaktif + retry
import dotenv from "dotenv";
dotenv.config({ override: true });

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFile } from "node:fs/promises";
import { readFile as readFileCb } from "node:fs";
import bs58 from "bs58";

import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  publicKey,
  createSignerFromKeypair,
  generateSigner,
  signerIdentity
} from "@metaplex-foundation/umi";
import {
  fetchCandyMachine,
  mintV2
} from "@metaplex-foundation/mpl-candy-machine";

const rl = createInterface({ input, output });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const spinner = (text) => {
  const frames = ["|", "/", "-", "\\"];
  let i = 0, t;
  return {
    start() { if (t) return; t = setInterval(() => process.stdout.write(`\r${frames[i++%4]} ${text} (Ctrl+C untuk berhenti)`), 90); },
    update(m) { process.stdout.write(`\r${frames[i++%4]} ${m} (Ctrl+C untuk berhenti)`); },
    stop() { if (t) { clearInterval(t); t = null; process.stdout.write("\r"); } }
  };
};

async function q(label, def = "") {
  const sfx = def !== "" ? ` (Enter=${def})` : "";
  const ans = (await rl.question(`${label}${sfx}: `)).trim();
  return ans === "" ? def : ans;
}

/* ---------- RPC loader dari rpc.json ---------- */
async function loadRpcJson(path = "rpc.json") {
  const raw = await readFile(path, "utf8");
  const j = JSON.parse(raw);
  const keys = Object.keys(j);
  const map = {};
  keys.forEach(k => { if (Array.isArray(j[k])) map[k] = j[k]; });
  if (!Object.keys(map).length) throw new Error("rpc.json tidak berisi array URL.");
  return { keys: Object.keys(map), map };
}
async function pickHealthyRpc(urls, timeoutMs = 4000) {
  const list = (urls || []).map(s => String(s || "").trim()).filter(Boolean);
  for (const url of list) {
    try {
      const umi = createUmi(url);
      // test: getLatestBlockhash races with timeout
      const race = Promise.race([
        umi.rpc.getLatestBlockhash(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs))
      ]);
      await race;
      return { url };
    } catch { /* try next */ }
  }
  throw new Error("Tidak ada RPC yang sehat di grup terpilih.");
}

/* ---------- Keypair loader ---------- */
async function loadKeypair() {
  const b58 = process.env.SECRET_KEY_B58?.trim();
  const jsonPath = process.env.SECRET_KEY_JSON?.trim();
  if (!b58 && !jsonPath) {
    throw new Error("Set salah satu: SECRET_KEY_B58 (base58) atau SECRET_KEY_JSON (path id.json)");
  }
  if (b58) {
    const secret = bs58.decode(b58);
    return new Uint8Array(secret);
  }
  const raw = await readFile(jsonPath, "utf8");
  const arr = JSON.parse(raw);
  return new Uint8Array(arr);
}

async function main() {
  // Pilih RPC dari rpc.json (menu angka / nama grup / atau URL manual)
  const { keys, map } = await loadRpcJson("sol/rpc.json");
  console.log("=== PILIH RPC GROUP (dari sol/rpc.json) ===");
  keys.forEach((k, i) => console.log(`${i + 1}) ${k}`));
  const pick = await q("Masukkan nomor / nama grup / atau tempel URL RPC", keys[0]);

  let rpcUrlList = null, groupKey = null;
  if (/^https?:\/\//i.test(pick)) {            // URL tempel
    rpcUrlList = pick.split(",").map(s => s.trim()).filter(Boolean);
    groupKey = "custom";
  } else if (!Number.isNaN(Number(pick))) {     // angka
    const idx = Number(pick);
    if (!(idx >= 1 && idx <= keys.length)) throw new Error("Pilihan RPC tidak valid.");
    groupKey = keys[idx - 1];
    rpcUrlList = map[groupKey];
  } else {                                      // nama grup
    if (!map[pick]) throw new Error("Pilihan RPC tidak valid.");
    groupKey = pick;
    rpcUrlList = map[groupKey];
  }
  const { url: RPC_URL } = await pickHealthyRpc(rpcUrlList);
  console.log("✅ RPC terpilih:", RPC_URL, "| group:", groupKey);

  // Inputs
  const CM_ID = await q("CANDY_MACHINE_ID", process.env.CANDY_MACHINE_ID || "");
  const GROUP = await q("GUARD_GROUP (kosong=default)", process.env.GUARD_GROUP || "");
  const QTY = Number(await q("QTY", process.env.QTY || "1"));
  const DELAY_SEC = Number(await q("DELAY detik (0.1=100ms)", process.env.DELAY_SEC || "0.2"));
  const RETRIES = Number(await q("RETRIES (0=infinite)", process.env.RETRIES || "0"));
  if (!CM_ID) throw new Error("CANDY_MACHINE_ID wajib diisi");
  if (!Number.isInteger(QTY) || QTY < 1) throw new Error("QTY harus bilangan bulat >= 1");

  // Keypair & UMI
  const secret = await loadKeypair();
  const umi = createUmi(RPC_URL);
  const kp = await umi.eddsa.createKeypairFromSecretKey(secret);
  const signer = createSignerFromKeypair(umi, kp);
  umi.use(signerIdentity(signer));

  // Info Candy Machine
  const cmPk = publicKey(CM_ID);
  const cm = await fetchCandyMachine(umi, cmPk); // akan throw kalau CM salah
  console.log("\n=== RINGKASAN ===");
  console.log({
    rpc: RPC_URL,
    wallet: signer.publicKey.toString(),
    candyMachine: CM_ID,
    group: GROUP || "(default)",
    qty: QTY,
    delaySec: DELAY_SEC,
    retries: RETRIES
  });

  await q("\nTekan ENTER untuk RUN", "");

  const spin = spinner("⏳ Menunggu mint live / guard terpenuhi…");
  let attempt = 0, minted = 0;

  while (minted < QTY) {
    attempt++;
    try {
      const nftMint = generateSigner(umi); // 1 mint per tx
      await mintV2(umi, {
        candyMachine: cmPk,
        nftMint,
        mintArgs: {},                 // public SOL payment by default
        group: GROUP || undefined
      }).sendAndConfirm(umi);

      console.log(`\n🎉 Mint #${minted + 1} sukses → ${nftMint.publicKey.toString()}`);
      minted++;
      await sleep(300);               // jeda kecil antar mint
    } catch (e) {
      spin.start();
      const msg = e?.message || String(e);
      spin.update(`Belum live/guard blokir. Attempt ${attempt}. ${RETRIES ? `max ${RETRIES}` : "∞"}`);
      if (RETRIES > 0 && attempt >= RETRIES) {
        // sesuai permintaan: jangan auto-stop, tetap menunggu hingga Ctrl+C
      }
      await sleep(Math.max(50, DELAY_SEC * 1000));
    }
  }

  spin.stop();
  console.log("\n✅ Selesai. Total minted:", minted);
  rl.close();
}

main().catch((e) => {
  console.error("\n❌", e?.message || e);
  rl.close();
  process.exit(1);
});

#!/usr/bin/env node

import { ethers } from "ethers";
import { createInterface } from "node:readline/promises";
import { readFile } from "node:fs/promises";
import { stdin as input, stdout as output } from "node:process";
import dotenv from "dotenv";

dotenv.config({ override: true });

// ===== ENV =====
function req(name) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`ENV ${name} wajib diisi`);
  return v;
}

const RPC_URL = req("RPC_URL");
const PRIVATE_KEY = req("PRIVATE_KEY");
const CONTRACT_ADDRESS = req("CONTRACT_ADDRESS");


const rl = createInterface({ input, output });
const q = async (label, def = "") => {
  const sfx = def !== "" ? ` (Enter=${def})` : "";
  const ans = (await rl.question(`${label}${sfx}: `)).trim();
  return ans === "" ? def : ans;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ===== Konfigurasi auto-detect (bisa edit langsung di file ini) ===== */
const PRICE_GUESS_LIST = "0.05,0.04,0.03,0.02,0.01,0.069,0.1,0.2,0.5,1"
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const STAGE_TRY_DEFAULT = "0,1,2,3,4,5,6,7,8,9,10,11,12"
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((x) => BigInt(x));

/* ===== RPC loader dari rpc.json ===== */
async function loadRpcJson(path = "rpc.json") {
  try {
    const raw = await readFile(path, "utf8");
    const j = JSON.parse(raw);
    const map = {};
    for (const k of Object.keys(j)) if (Array.isArray(j[k])) map[k] = j[k];
    const keys = Object.keys(map);
    return { keys, map };
  } catch {
    return { keys: [], map: {} };
  }
}
async function pickHealthyProvider(urls, timeoutMs = 5000) {
  const list = (urls || []).map((s) => String(s || "").trim()).filter(Boolean);
  for (const url of list) {
    try {
      const p = new ethers.JsonRpcProvider(url);
      await Promise.race([
        p.getNetwork(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs)),
      ]);
      const net = await p.getNetwork();
      return { provider: p, url, chainId: Number(net.chainId) };
    } catch {
      /* coba berikutnya */
    }
  }
  throw new Error("Tidak ada RPC sehat pada pilihan tersebut.");
}

/* ===== GAS overrides ===== */
async function askGasMode(provider) {
  console.log("\n=== GAS ===\n1) Auto\n2) gasPrice (gwei)\n3) EIP-1559");
  const mode = await q("Mode gas", "1");
  if (mode === "2") {
    const g = await q("gasPrice (gwei)", "");
    if (!g || isNaN(Number(g))) throw new Error("gasPrice tidak valid.");
    return { gasPrice: ethers.parseUnits(g, "gwei") };
  }
  if (mode === "3") {
    const maxFee = await q("maxFeePerGas (gwei)", "");
    const maxPrio = await q("maxPriorityFeePerGas (gwei)", "");
    if (!maxFee || !maxPrio) throw new Error("Isi kedua nilai untuk EIP-1559.");
    return {
      maxFeePerGas: ethers.parseUnits(maxFee, "gwei"),
      maxPriorityFeePerGas: ethers.parseUnits(maxPrio, "gwei"),
    };
  }
  // Auto
  const fee = await provider.getFeeData();
  if (fee.maxFeePerGas && fee.maxPriorityFeePerGas) {
    return { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas };
  }
  if (fee.gasPrice) return { gasPrice: fee.gasPrice };
  return {};
}

/* ===== Raw selector mint (0x6b1a2b7f): (uint256 stageId, uint256 qty, bytes) ===== */
async function rawSelectorMint({
  provider,
  wallet,
  contractAddr,
  unitWei,
  qty,
  stageTry,
  retries,
  delaySec,
  jitterSec,
  gasCfg,
}) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const value = unitWei * qty;
  for (const st of stageTry) {
    const data =
      "0x6b1a2b7f" + coder.encode(["uint256", "uint256", "bytes"], [st, qty, "0x"]).slice(2);

    // probe via eth_call
    try {
      await provider.call({ to: contractAddr, from: wallet.address, data, value });
    } catch {
      continue; // coba stage berikutnya
    }

    console.log(`🔎 cocok (RAW): stage=${st.toString()}`);
    for (let i = 1; i <= (retries || 1); i++) {
      console.log(`🔁 raw attempt stage=${st.toString()} try ${i}/${retries || "∞"}`);
      try {
        const gas = await provider.estimateGas({ to: contractAddr, from: wallet.address, data, value, ...gasCfg });
        const tx = await wallet.sendTransaction({ to: contractAddr, data, value, gasLimit: gas, ...gasCfg });
        console.log("⏳ TX:", tx.hash);
        const rc = await tx.wait();
        console.log("🎉 Mint sukses →", rc.hash || rc.transactionHash);
        return true;
      } catch (e) {
        console.log("❌", e.shortMessage || e.message || e);
        const ms = delaySec * 1000 + Math.random() * (jitterSec * 1000);
        await new Promise((r) => setTimeout(r, ms));
      }
    }
  }
  return false;
}

/* ===== Auto-detect stage + price via raw selector ===== */
async function autoDetectStagePrice({ provider, wallet, contractAddr, qty, priceList, stageList }) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  for (const px of priceList) {
    let unitWei;
    try {
      unitWei = ethers.parseEther(px);
    } catch {
      continue;
    }
    const value = unitWei * qty;
    for (const st of stageList) {
      const data =
        "0x6b1a2b7f" + coder.encode(["uint256", "uint256", "bytes"], [st, qty, "0x"]).slice(2);
      try {
        await provider.call({ to: contractAddr, from: wallet.address, data, value });
        return { stage: st, unitWei };
      } catch {}
    }
  }
  return null;
}

/* ===== Fallback: ABI brute-force untuk variasi umum ===== */
const abiList = [
  // pola 3 arg (sering dipakai DRIP)
  "function mint(uint256 tokenOrStageId,uint256 quantity,bytes data) payable",
  "function mintPublic(uint256 tokenOrStageId,uint256 quantity,bytes data) payable",
  "function purchase(uint256 tokenOrStageId,uint256 quantity,bytes data) payable",
  "function buy(uint256 tokenOrStageId,uint256 quantity,bytes data) payable",
  // pola umum qty-only / to+qty / 4-arg
  "function mint(uint256 quantity) payable",
  "function publicMint(uint256 quantity) payable",
  "function mintPublic(uint256 quantity) payable",
  "function mintTo(address to,uint256 quantity) payable",
  "function mintPublic(address to,uint256 tokenId,uint256 qty,bytes data) payable",
];

async function abiBruteforceLoop({
  provider,
  wallet,
  contractAddr,
  unitWei,
  qty,
  stageTry,
  retries,
  delaySec,
  jitterSec,
  gasCfg,
}) {
  const code = await provider.getCode(contractAddr);
  if (!code || code === "0x") throw new Error("Alamat kontrak tidak ada di chain ini.");

  const value = unitWei * qty;
  const tries = [];
  for (const sig of abiList) {
    if (sig.includes("(uint256 tokenOrStageId,uint256 quantity,bytes")) {
      for (const x of stageTry) tries.push({ sig, build: () => [x, qty, "0x"] });
    } else if (sig.includes("(uint256 quantity)")) {
      tries.push({ sig, build: () => [qty] });
    } else if (sig.includes("address to,uint256 quantity")) {
      tries.push({ sig, build: () => [wallet.address, qty] });
    } else if (sig.includes("address to,uint256 tokenId,uint256 qty,bytes")) {
      tries.push({ sig, build: () => [wallet.address, 0n, qty, "0x"] });
    }
  }

  let attempt = 0;
  for (;;) {
    attempt++;
    for (const t of tries) {
      const c = new ethers.Contract(contractAddr, [t.sig], wallet);
      const fn = c.interface.getFunction(t.sig).name;

      try {
        await c[fn].staticCall(...t.build(), { value });
      } catch {
        continue;
      }

      for (let i = 1; i <= (retries || 1); i++) {
        console.log(`🔁 attempt ${attempt}.${i} via ${fn}`);
        try {
          const gas = await c[fn].estimateGas(...t.build(), { value, ...gasCfg });
          const tx = await c[fn](...t.build(), { value, gasLimit: gas, ...gasCfg });
          console.log("⏳ TX:", tx.hash);
          const rc = await tx.wait();
          console.log("🎉 Mint sukses →", rc.transactionHash);
          return true;
        } catch (e) {
          console.log("❌", e.shortMessage || e.message || e);
          const ms = delaySec * 1000 + Math.random() * (jitterSec * 1000);
          await new Promise((r) => setTimeout(r, ms));
        }
      }
    }

    const ms = delaySec * 1000 + Math.random() * (jitterSec * 1000);
    process.stdout.write(
      `\r⏳ Belum live / arg tidak cocok. Attempt ${attempt}. Menunggu ${(ms / 1000).toFixed(
        2
      )}s… (Ctrl+C untuk stop)`
    );
    await sleep(ms);
  }
}

/* ===== MAIN ===== */
async function main() {
  // Pilih RPC
  const { keys, map } = await loadRpcJson("rpc.json");
  if (keys.length) {
    console.log("=== PILIH RPC GROUP (dari rpc.json) ===");
    keys.forEach((k, i) => console.log(`${i + 1}) ${k}`));
  }
  const pick = await q("Masukkan nomor/nama grup/URL RPC", keys[0] || "");
  let urls = null,
    rpcGroup = "custom";
  if (/^https?:\/\//i.test(pick)) urls = pick.split(",").map((s) => s.trim()).filter(Boolean);
  else if (keys.length && !Number.isNaN(Number(pick))) {
    const idx = Number(pick);
    if (!(idx >= 1 && idx <= keys.length)) throw new Error("Pilihan RPC tidak valid.");
    rpcGroup = keys[idx - 1];
    urls = map[rpcGroup];
  } else if (keys.length) {
    if (!map[pick]) throw new Error("Pilihan RPC tidak valid.");
    rpcGroup = pick;
    urls = map[rpcGroup];
  } else {
    urls = [pick];
  }

  const { provider, url: rpcUrl, chainId } = await pickHealthyProvider(urls);

  // PK
  const pk = await q("PRIVATE_KEY (0x…)", process.env.PRIVATE_KEY || "");
  const wallet = new ethers.Wallet(pk, provider);
  console.log("👛 Wallet:", wallet.address);

  // Input utama
  const CONTRACT_ADDRESS = (await q("CONTRACT_ADDRESS", "")).trim();
  if (!CONTRACT_ADDRESS || !ethers.isAddress(CONTRACT_ADDRESS)) throw new Error("CONTRACT_ADDRESS tidak valid.");

  const priceStr = (await q("MINT_PRICE (ETH/native, 0=auto)", "0")).trim();
  let unitWei = 0n;
  try {
    unitWei = ethers.parseEther(priceStr);
  } catch {
    throw new Error(`MINT_PRICE tidak valid: ${priceStr}`);
  }

  const QTY = BigInt((await q("QTY", "1")).trim());
  if (QTY <= 0n) throw new Error("QTY harus > 0.");

  const STAGE_ID = BigInt((await q("STAGE_ID (prioritas awal)", "4")).trim());
  const DELAY_SEC = Number((await q("DELAY detik", "0.1")).trim());
  const JITTER_SEC = Number((await q("JITTER detik", "0.2")).trim());
  const RETRIES = Number((await q("RETRIES per tx (0=infinite)", "0")).trim());

  console.log("\n=== STAGE ===\n1) Auto (probe)\n2) Manual (pakai STAGE_ID saja)");
  const STAGE_MODE = await q("Stage mode", "1");
  const manualStage = STAGE_MODE === "2";

  const gasCfg = await askGasMode(provider);

  // Ringkasan
  const bal = await provider.getBalance(wallet.address).catch(() => 0n);
  console.log("\n=== DETAILS ===");
  console.log({
    platform: "DRIP",
    rpcUrl,
    chainId,
    rpcGroup,
    wallet: wallet.address,
    qty: QTY,
    delaySec: DELAY_SEC,
    retries: RETRIES || "∞(per tx)",
    gasCfg: Object.fromEntries(Object.entries(gasCfg).map(([k, v]) => [k, v?.toString?.() || v])),
    contract: CONTRACT_ADDRESS,
    stageId: STAGE_ID,
    unitEth: ethers.formatEther(unitWei),
    balanceEth: ethers.formatEther(bal || 0n),
  });

  await q("\nENTER TO RUN", "");

  // MODE MANUAL: hanya stage yang dipilih, loop sampai live
  if (manualStage) {
    for (;;) {
      const ok = await rawSelectorMint({
        provider,
        wallet,
        contractAddr: CONTRACT_ADDRESS,
        unitWei,
        qty: QTY,
        stageTry: [STAGE_ID],
        retries: RETRIES,
        delaySec: DELAY_SEC,
        jitterSec: JITTER_SEC,
        gasCfg,
      });
      if (ok) return rl.close();
      const ms = DELAY_SEC * 1000 + Math.random() * (JITTER_SEC * 1000);
      process.stdout.write(
        `\r⏳ Belum live (stage=${STAGE_ID}). Ulang ${(ms / 1000).toFixed(2)}s… (Ctrl+C untuk stop)`
      );
      await sleep(ms);
    }
  }

  // MODE AUTO: deteksi stage + harga dulu
  let stageList = [STAGE_ID, ...STAGE_TRY_DEFAULT.filter((x) => x !== STAGE_ID)];
  if (unitWei > 0n) {
    // Coba langsung pakai harga user untuk semua stage
    const ok = await rawSelectorMint({
      provider,
      wallet,
      contractAddr: CONTRACT_ADDRESS,
      unitWei,
      qty: QTY,
      stageTry: stageList,
      retries: RETRIES,
      delaySec: DELAY_SEC,
      jitterSec: JITTER_SEC,
      gasCfg,
    });
    if (ok) return rl.close();
  }

  // Auto-detect stage + price
  const found = await autoDetectStagePrice({
    provider,
    wallet,
    contractAddr: CONTRACT_ADDRESS,
    qty: QTY,
    priceList: unitWei === 0n ? PRICE_GUESS_LIST : [ethers.formatEther(unitWei)],
    stageList,
  });

  if (found) {
    unitWei = found.unitWei;
    console.log(
      `✅ Auto-detect: stage=${found.stage.toString()} price=${ethers.formatEther(unitWei)}`
    );
    const ok = await rawSelectorMint({
      provider,
      wallet,
      contractAddr: CONTRACT_ADDRESS,
      unitWei,
      qty: QTY,
      stageTry: [found.stage, ...stageList.filter((x) => x !== found.stage)],
      retries: RETRIES,
      delaySec: DELAY_SEC,
      jitterSec: JITTER_SEC,
      gasCfg,
    });
    if (ok) return rl.close();
  } else {
    console.log("ℹ️ Auto-detect belum menemukan kombinasi. Lanjut ke brute-force ABI…");
  }

  // Fallback ke ABI brute-force (akan loop loading)
  await abiBruteforceLoop({
    provider,
    wallet,
    contractAddr: CONTRACT_ADDRESS,
    unitWei,
    qty: QTY,
    stageTry: stageList,
    retries: RETRIES,
    delaySec: DELAY_SEC,
    jitterSec: JITTER_SEC,
    gasCfg,
  });

  rl.close();
}

main().catch((e) => {
  console.error("\n❌", e?.shortMessage || e?.message || e);
  rl.close();
  process.exit(1);
});

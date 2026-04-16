#!/usr/bin/env node
// all.js — Unified CLI (ME/NFT2, SeaDrop, Rarible, DRIP Raw, Kingdomly, Joe/AVAX, Blever) + RPC group menu from rpc.json
// ethers v6, ESM
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFile } from "node:fs/promises";
import { ethers, isAddress, ZeroAddress } from "ethers";
import dotenv from "dotenv";
dotenv.config({ override: true });

/* ========= Utils ========= */
const rl = createInterface({ input, output });
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);
const isNative = (addr) => (addr || NATIVE).toLowerCase() === NATIVE.toLowerCase();
const ensureAddr = (label, a) => {
  if (!isAddress(a)) throw new Error(`${label} harus alamat 0x valid: ${a}`);
};
const ensurePk = (pk) => {
  if (!/^0x[0-9a-fA-F]{64}$/.test((pk || "").trim())) throw new Error("PRIVATE_KEY tidak valid (0x + 64 hex).");
  return pk.trim();
};
const gasOv = ({ gasPriceGwei, maxFeeGwei, maxPrioGwei }) => {
  if (gasPriceGwei) return { gasPrice: ethers.parseUnits(String(gasPriceGwei), "gwei") };
  const o = {};
  if (maxFeeGwei) o.maxFeePerGas = ethers.parseUnits(String(maxFeeGwei), "gwei");
  if (maxPrioGwei) o.maxPriorityFeePerGas = ethers.parseUnits(String(maxPrioGwei), "gwei");
  return o;
};
const spinner = (text) => {
  const frames = ["|", "/", "-", "\\"];
  let i = 0, t;
  return {
    start() { if (t) return; t = setInterval(() => process.stdout.write(`\r${frames[i++ % 4]} ${text} (Ctrl+C untuk berhenti)`), 90); },
    update(msg) { process.stdout.write(`\r${frames[i++ % 4]} ${msg} (Ctrl+C untuk berhenti)`); },
    stop() { if (t) { clearInterval(t); t = null; process.stdout.write("\r"); } }
  };
};
const q = async (label, def = "") => {
  const ans = (await rl.question(`${label}${def !== "" ? ` (Enter=${def})` : ""}: `)).trim();
  return ans === "" ? def : ans;
};
const toBytes32 = (s) => {
  if (!s || s === "0" || s.toLowerCase() === "public") return "0x" + "00".repeat(32);
  const hex = s.startsWith("0x") ? s.slice(2) : s;
  if (hex.length > 64) throw new Error("bytes32 terlalu panjang (>32 bytes).");
  return "0x" + hex.padStart(64, "0");
};
const ensureSig = (sig) => {
  const s = (sig || "").trim();
  if (!s) throw new Error("SIGNATURE wajib diisi (0x…)");
  if (!/^0x[0-9a-fA-F]+$/.test(s)) throw new Error("SIGNATURE harus hex 0x…");
  if (((s.length - 2) % 2) !== 0) throw new Error("SIGNATURE hex harus genap panjangnya.");
  return s;
};

// --- auto-parse "required=..." dari pesan revert (explorer/custom error) ---
const parseRequiredWei = (err) => {
  const s = String(err?.shortMessage || err?.message || err?.info?.error?.message || err?.data?.message || "");
  const m = s.match(/required\s*=\s*(\d+)/i) || s.match(/required[_\s]*wei\s*[:=]\s*(\d+)/i);
  return m ? BigInt(m[1]) : null;
};

/* ===== FCFS continuous loop (NO delay) ===== */
async function loopFCFS(sendOnce) {
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      const tx = await sendOnce(); // must return a TransactionResponse
      console.log("\n⏳ TX:", tx.hash);
      const rc = await tx.wait();
      console.log("🎉 Sukses →", rc?.hash ?? rc?.transactionHash ?? tx.hash);
      return;
    } catch (e) {
      const msg = (e?.shortMessage || e?.message || "").toLowerCase();
      console.log(`❌ FCFS attempt ${attempt} failed: ${e?.shortMessage || e?.message || e}`);
      if (msg.includes("insufficient funds")) throw e; // stop only if saldo habis
      // NO DELAY — lanjut tembak lagi
    }
  }
}

/* === FCFS global flags === */
const FCFS_GAS_LIMIT = BigInt(process.env.FCFS_GAS_LIMIT || "420000");

/* ========= RPC loader (from rpc.json) ========= */
async function loadRpcJson(path = "rpc.json") {
  const raw = await readFile(path, "utf8");
  const j = JSON.parse(raw);
  if (Array.isArray(j)) return { keys: ["default"], map: { default: j } };
  const map = {}; const keys = [];
  for (const k of Object.keys(j)) { if (Array.isArray(j[k])) { keys.push(k); map[k] = j[k]; } }
  if (!keys.length) throw new Error("rpc.json tidak berisi array URL.");
  return { keys, map };
}
async function pickHealthyProvider(urls, timeoutMs = 4000) {
  const list = (urls || []).map(s => String(s || "").trim()).filter(Boolean);
  if (!list.length) throw new Error("Daftar RPC kosong.");
  for (const url of list) {
    try {
      const provider = new ethers.JsonRpcProvider(url);
      const race = Promise.race([
        provider.getNetwork().then(n => ({ provider, url, chainId: Number(n.chainId) })),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs))
      ]);
      const res = await race; return res;
    } catch (e) { /* next */ }
  }
  throw new Error("Tidak ada RPC yang sehat dari grup terpilih.");
}

/* ========= ABIs ========= */
const SEADROP_ABI = [
  "function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity) payable",
  "function getPublicDrop(address nft) view returns (uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 maxTotalMintableByWallet,uint16 feeBps,bool restrictFeeRecipients)",
  "function publicDrop(address nft) view returns (uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 feeBps,bool restrictFeeRecipients)"
];

const RARI_OE_ABI = [
  "function claim(address _receiver, uint256 _quantity, address _currency, uint256 _pricePerToken, (bytes32[] _proof,uint256 _u256a,uint256 _u256b,address _addr) _allowlistProof, bytes _data) payable"
];
const RARI_CLAIM_ABIS = [
  "function claim(address buyer,uint256 quantity,address paymentToken,uint256 unitPrice,(bytes32[] proof,uint256 phaseId,uint256 unitPrice,address paymentToken) terms,bytes data) payable",
  "function claim(uint256 quantity,address paymentToken,uint256 unitPrice,(bytes32[] proof,uint256 phaseId,uint256 unitPrice,address paymentToken) terms,bytes data) payable",
  "function claim(address buyer,uint256 quantity,address paymentToken,uint256 unitPrice,(bytes32[] proof,uint256 phaseId,uint256 unitPrice,address paymentToken) terms,bytes data,address ref) payable"
];

const MENFT2_ABIS = [
  "function mintPublic(address to,uint256 tokenId,uint256 qty,bytes data) payable",
  "function mint(uint256 quantity) payable",
  "function publicMint(uint256 quantity) payable",
  "function mintTo(address to,uint256 quantity) payable",
  "function mint(address to,uint256 quantity) payable"
];

const KINGDOMLY_ABI = [
  "function batchMint(uint256 amount,uint256 mintId) payable"
];

const JOE_ABI_CANDIDATES = [
  "function publicSaleMint(uint256 amount) payable",
  "function publicSaleMint(uint256 _quantity) payable",
  "function publicMint(uint256 quantity) payable",
  "function mint(uint256 quantity) payable",
  "function mint(uint256 id,uint256 amount) payable",
  "function purchase(uint256 quantity) payable"
];

const BLEVER_ABI_NO_FEE = [
  "function mint(address _to,uint256 _amount,bytes32 _phaseID,uint256 _price,uint256 _maxPerTx,uint256 _maxPerUser,uint256 _maxPerPhase,bytes32 _nonce,bytes _signature) payable"
];
const BLEVER_ABI_WITH_FEE = [
  "function mint(address _to,uint256 _amount,bytes32 _phaseID,uint256 _price,uint256 _mintFee,uint256 _maxPerTx,uint256 _maxPerUser,uint256 _maxPerPhase,bytes32 _nonce,bytes _signature) payable"
];

/* ========= DRIP Raw auto-detect config ========= */
const DRIP_PRICE_GUESS_LIST = (process.env.DRIP_PRICE_GUESS_LIST || "0,0.05,0.04,0.03,0.02,0.01,0.069,0.1,0.2,0.5,1")
  .split(",").map(s => s.trim()).filter(Boolean);
const DRIP_STAGE_TRY_DEFAULT = (process.env.DRIP_STAGE_TRY || "0,1,2,3,4,5,6,7,8,9,10,11,12")
  .split(",").map(s => s.trim()).filter(Boolean).map(x => BigInt(x));
const encDripData = (stageId, qty) => {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return "0x6b1a2b7f" + coder.encode(["uint256", "uint256", "bytes"], [stageId, qty, "0x"]).slice(2);
};
async function autoDetectStagePrice({ provider, from, contract, qty, priceList, stageList }) {
  for (const px of priceList) {
    let unitWei; try { unitWei = ethers.parseEther(px); } catch { continue; }
    const value = unitWei * qty;
    for (const st of stageList) {
      const data = encDripData(st, qty);
      try { await provider.call({ to: contract, from, data, value }); return { stage: st, unitWei }; } catch (e) { }
    }
  }
  return null;
}

/* ========= Runners ========= */
async function runSeaDrop({ provider, wallet, nftAddr, seaAddr, feeRecipient, qty, unitEth, delaySec, retries, gasCfg, FCFS }) {
  ensureAddr("NFT (CONTRACT_ADDRESS)", nftAddr);
  ensureAddr("SEA_ADDRESS", seaAddr);
  if (feeRecipient) ensureAddr("FEE_RECIPIENT", feeRecipient);

  // === FCFS continuous ===
  if (FCFS) {
    const price = (unitEth && String(unitEth).trim() !== "") ? ethers.parseEther(unitEth) : 0n;
    const value = price * qty;
    const sea = new ethers.Contract(seaAddr, SEADROP_ABI, wallet);
    await loopFCFS(() => sea.mintPublic(nftAddr, feeRecipient || ZeroAddress, wallet.address, qty, {
      value, gasLimit: FCFS_GAS_LIMIT, ...gasOv(gasCfg)
    }));
    return;
  }

  const seaRO = new ethers.Contract(seaAddr, SEADROP_ABI, provider);
  const sea = new ethers.Contract(seaAddr, SEADROP_ABI, wallet);

  let price = unitEth ? ethers.parseEther(unitEth) : 0n;
  let start = 0, end = 0, restrict = false;
  try {
    const d = await seaRO.getPublicDrop(nftAddr);
    price = BigInt(d.mintPrice ?? d[0] ?? 0n);
    start = Number(d.startTime ?? d[1] ?? 0);
    end = Number(d.endTime ?? d[2] ?? 0);
    restrict = Boolean(d.restrictFeeRecipients ?? d[5] ?? false);
    if (restrict && !feeRecipient) throw new Error("restrictFeeRecipients=TRUE → isi FEE_RECIPIENT.");
  } catch (e) { }

  const spin = spinner("⏳ Menunggu mint live (SeaDrop)...");
  let attempt = 0;
  while (true) {
    attempt++;
    if (end && nowSec() > end) throw new Error("Mint berakhir (endTime).");
    const value = price * qty;
    try {
      await sea.mintPublic.staticCall(nftAddr, feeRecipient || ZeroAddress, wallet.address, qty, { value, ...gasOv(gasCfg) });
      const gas = await sea.mintPublic.estimateGas(nftAddr, feeRecipient || ZeroAddress, wallet.address, qty, { value, ...gasOv(gasCfg) });
      const tx = await sea.mintPublic(nftAddr, feeRecipient || ZeroAddress, wallet.address, qty, { value, gasLimit: gas, ...gasOv(gasCfg) });
      console.log("\n⏳ TX:", tx.hash);
      const rc = await tx.wait();
      console.log("🎉 Sukses →", rc?.hash ?? rc?.transactionHash ?? tx.hash);
      spin.stop(); return;
    } catch (e) {
      spin.start(); spin.update(`Belum live / revert. Attempt ${attempt}.`);
      await sleep(delaySec * 1000);
      if (retries > 0 && attempt >= retries) { /* infinite keep-waiting */ }
    }
  }
}

async function runRarible({ provider, wallet, contract, qty, unitEth, payToken, delaySec, retries, gasCfg, FCFS }) {
  ensureAddr("CONTRACT_ADDRESS", contract);

  // === FCFS continuous (keep original probing) ===
  if (FCFS) {
    const isNat = isNative(payToken);
    const u = (unitEth && String(unitEth).trim() !== "") ? ethers.parseEther(unitEth) : 0n;
    const val = isNat ? u * qty : 0n;
    const w = new ethers.Contract(contract, RARI_OE_ABI, wallet);
    const MAX = (1n << 256n) - 1n;
    const allow = [[], 0n, MAX, ZeroAddress];
    await loopFCFS(() => w.claim(wallet.address, qty, payToken, u, allow, "0x", {
      value: val, gasLimit: FCFS_GAS_LIMIT, ...gasOv(gasCfg)
    }));
    return;
  }

  const PROOF = [];
  const PHASE_ID = 0n;
  const AL_U256_A = 0n;
  const AL_U256_B_MODE = "MAX"; // MAX | UNIT_PRICE | angka
  const AL_ADDR_MODE = "ZERO"; // ZERO | PAYMENT_TOKEN | 0x...
  const DATA_HEX = "0x";

  const MAX = (1n << 256n) - 1n;
  const tupleOE = (uWei) => {
    const u256a = AL_U256_A;
    const u256b = (AL_U256_B_MODE === "MAX") ? MAX : (AL_U256_B_MODE === "UNIT_PRICE" ? uWei : BigInt(AL_U256_B_MODE || "0"));
    let a = ZeroAddress;
    if (AL_ADDR_MODE === "PAYMENT_TOKEN") a = payToken;
    else if (AL_ADDR_MODE === "ZERO") a = ZeroAddress;
    else a = AL_ADDR_MODE;
    return [PROOF, u256a, u256b, a];
  };

  const guesses = (process.env.PRICE_GUESS_LIST || "0,0.0001,0.001,0.01,0.1,1,2.815").split(",").map(s => s.trim()).filter(Boolean);
  const tryUnits = unitEth && Number(unitEth) > 0 ? [ethers.parseEther(unitEth)] : guesses.map(x => ethers.parseEther(x));
  const isNat = isNative(payToken);
  const spin = spinner("⏳ Menunggu mint live (Rarible)...");

  // 1) OE exact
  try {
    const ro = new ethers.Contract(contract, RARI_OE_ABI, provider);
    const w = new ethers.Contract(contract, RARI_OE_ABI, wallet);
    let picked = null;
    for (const u of tryUnits) {
      const val = isNat ? u * qty : 0n;
      try { await ro.claim.staticCall(wallet.address, qty, payToken, u, tupleOE(u), DATA_HEX, { value: val, ...gasOv(gasCfg) }); picked = u; break; } catch (e) { }
    }
    if (picked) {
      let attempt = 0;
      while (true) {
        attempt++;
        try {
          const val = isNat ? picked * qty : 0n;
          const gas = await w.claim.estimateGas(wallet.address, qty, payToken, picked, tupleOE(picked), DATA_HEX, { value: val, ...gasOv(gasCfg) });
          const tx = await w.claim(wallet.address, qty, payToken, picked, tupleOE(picked), DATA_HEX, { value: val, gasLimit: gas, ...gasOv(gasCfg) });
          console.log("\n⏳ TX:", tx.hash);
          const rc = await tx.wait();
          console.log("🎉 Sukses →", rc?.hash ?? rc?.transactionHash ?? tx.hash);
          spin.stop(); return;
        } catch (e) {
          spin.start(); spin.update(`Belum live / revert. Attempt ${attempt}.`);
          await sleep(delaySec * 1000);
        }
      }
    }
  } catch (e) { }

  // 2) Claim varian umum
  for (const sig of RARI_CLAIM_ABIS) {
    try {
      const ro = new ethers.Contract(contract, [sig], provider);
      const w = new ethers.Contract(contract, [sig], wallet);
      const fn = ro.getFunction("claim");
      let pickedArgs = null, pickedUnit = null;

      for (const u of tryUnits) {
        const val = isNat ? u * qty : 0n;
        const terms = [[], 0n, u, payToken];
        const argSets = [
          [wallet.address, qty, payToken, u, terms, "0x"],
          [Number(qty), payToken, u, terms, "0x"],
          [wallet.address, qty, payToken, u, terms, "0x", ZeroAddress],
        ];
        for (const args of argSets) {
          try { await fn.staticCall(...args, { value: val, ...gasOv(gasCfg) }); pickedArgs = args; pickedUnit = u; break; } catch (e) { }
        }
        if (pickedArgs) break;
      }
      if (pickedArgs) {
        let attempt2 = 0;
        while (true) {
          attempt2++;
          try {
            const val = isNat ? pickedUnit * qty : 0n;
            const gas = await w.getFunction("claim").estimateGas(...pickedArgs, { value: val, ...gasOv(gasCfg) });
            const tx = await w.getFunction("claim")(...pickedArgs, { value: val, gasLimit: gas, ...gasOv(gasCfg) });
            console.log("\n⏳ TX:", tx.hash);
            const rc = await tx.wait();
            console.log("🎉 Sukses →", rc?.hash ?? rc?.transactionHash ?? tx.hash);
            spin.stop(); return;
          } catch (e) {
            spin.start(); spin.update(`Belum live / revert. Attempt ${attempt2}.`);
            await sleep(delaySec * 1000);
          }
        }
      }
    } catch (e) { }
  }

  const code = await provider.getCode(contract);
  if (!code || code === "0x") throw new Error("Alamat kontrak tidak ada (getCode kosong).");
  throw new Error("Tidak ada signature Rarible yang cocok.");
}

async function runMENFT2({ provider, wallet, contract, qty, unitEth, delaySec, retries, gasCfg, FCFS }) {
  ensureAddr("CONTRACT_ADDRESS", contract);

  // === FCFS continuous ===
  if (FCFS) {
    const val = (unitEth && String(unitEth).trim() !== "") ? ethers.parseEther(unitEth) * qty : 0n;
    const cand = [
      { sig: "function mint(uint256)", args: [Number(qty)] },
      { sig: "function publicMint(uint256)", args: [Number(qty)] },
      { sig: "function mintTo(address,uint256)", args: [wallet.address, Number(qty)] },
    ];
    await loopFCFS(async () => {
      for (const c of cand) {
        try {
          const w = new ethers.Contract(contract, [c.sig], wallet);
          const name = c.sig.replace(/^function\s*/, "").split("(")[0];
          return await w.getFunction(name)(...c.args, { value: val, gasLimit: FCFS_GAS_LIMIT, ...gasOv(gasCfg) });
        } catch (e) { }
      }
      throw new Error("FCFS: semua kandidat ME/NFT2 gagal dikirim.");
    });
    return;
  }

  // WAITING mode
  const ABIS = MENFT2_ABIS; // gunakan apa adanya
  const u = ethers.parseEther(unitEth || "0");
  const val = u * qty;
  const spin = spinner("⏳ Menunggu mint live (ME/NFT2)…");
  let attempt = 0;

  while (true) {
    attempt++;
    let matched = null, pickedArgs = null, pickedName = null;
    for (const sig of ABIS) {
      const ro = new ethers.Contract(contract, [sig], provider);
      const name = sig.split("(")[0].replace("function ", "");
      const fn = ro.getFunction(name);
      const sets = [
        [wallet.address, 0, Number(qty), "0x"],
        [Number(qty)],
        [Number(qty)],
        [wallet.address, Number(qty)],
        [wallet.address, Number(qty)],
      ];
      for (const args of sets) {
        try { await fn.staticCall(...args, { value: val, ...gasOv(gasCfg) }); matched = sig; pickedArgs = args; pickedName = name; break; } catch (e) { }
      }
      if (matched) break;
    }
    if (matched) {
      const w = new ethers.Contract(contract, [matched], wallet);
      try {
        const gas = await w.getFunction(pickedName).estimateGas(...pickedArgs, { value: val, ...gasOv(gasCfg) });
        const tx = await w.getFunction(pickedName)(...pickedArgs, { value: val, gasLimit: gas, ...gasOv(gasCfg) });
        console.log("\n⏳ TX:", tx.hash);
        const rc = await tx.wait();
        console.log("🎉 Sukses →", rc?.hash ?? rc?.transactionHash ?? tx.hash);
        spin.stop(); return;
      } catch (e) { }
    }
    const code = await provider.getCode(contract);
    if (!code || code === "0x") throw new Error("Alamat kontrak tidak ada (getCode kosong).");
    spin.start(); spin.update(`Belum live / revert. Attempt ${attempt}.`);
    await sleep(delaySec * 1000);
  }
}

async function runDRIPRaw({ provider, wallet, contract, qty, unitEth, stageHint, delaySec, retries, gasCfg, FCFS }) {
  ensureAddr("CONTRACT_ADDRESS", contract);

  // === FCFS continuous ===
  if (FCFS) {
    const unitWei = (unitEth && String(unitEth).trim() !== "") ? ethers.parseEther(unitEth) : 0n;
    const value = unitWei * qty;
    const data = encDripData(stageHint, qty);
    await loopFCFS(() => wallet.sendTransaction({ to: contract, data, value, gasLimit: FCFS_GAS_LIMIT, ...gasOv(gasCfg) }));
    return;
  }

  let unitWei = 0n; if (unitEth && String(unitEth).trim() !== "0") unitWei = ethers.parseEther(unitEth);
  const stageOrder = [stageHint, ...DRIP_STAGE_TRY_DEFAULT.filter(x => x !== stageHint)];
  const spin = spinner("⏳ Menunggu mint live (DRIP Raw)…");

  if (unitWei > 0n) {
    for (;;) {
      for (const st of stageOrder) {
        const value = unitWei * qty;
        const data = encDripData(st, qty);
        try {
          await provider.call({ to: contract, from: wallet.address, data, value });
          try {
            const gas = await provider.estimateGas({ to: contract, from: wallet.address, data, value, ...gasOv(gasCfg) });
            const tx = await wallet.sendTransaction({ to: contract, data, value, gasLimit: gas, ...gasOv(gasCfg) });
            console.log("\n⏳ TX:", tx.hash); const rc = await tx.wait();
            console.log("🎉 Sukses →", rc?.hash ?? rc?.transactionHash ?? tx.hash); spin.stop(); return;
          } catch (e) { console.log("❌", e.shortMessage || e.message || e); }
        } catch (e) { }
      }
      spin.start(); spin.update("Belum live / kombinasi belum cocok."); await sleep(delaySec * 1000);
    }
  }

  for (;;) {
    const found = await autoDetectStagePrice({ provider, from: wallet.address, contract, qty, priceList: DRIP_PRICE_GUESS_LIST, stageList: stageOrder });
    if (found) {
      unitWei = found.unitWei; const st = found.stage; const value = unitWei * qty; const data = encDripData(st, qty);
      console.log(`\n✅ Auto-detect: stage=${st.toString()} price=${ethers.formatEther(unitWei)}`);
      try {
        const gas = await provider.estimateGas({ to: contract, from: wallet.address, data, value, ...gasOv(gasCfg) });
        const tx = await wallet.sendTransaction({ to: contract, data, value, gasLimit: gas, ...gasOv(gasCfg) });
        console.log("⏳ TX:", tx.hash); const rc = await tx.wait();
        console.log("🎉 Sukses →", rc?.hash ?? rc?.transactionHash ?? tx.hash); spin.stop(); return;
      } catch (e) { console.log("❌", e.shortMessage || e.message || e); }
    }
    spin.start(); spin.update("Belum live / mencari stage+price…"); await sleep(delaySec * 1000);
  }
}

/* ======== Kingdomly (FCFS disamakan dengan platform lain) ======== */
async function runKingdom({ provider, wallet, contract, amount, mintId, unitEth, delaySec, retries, gasCfg, FCFS }) {
  ensureAddr("CONTRACT_ADDRESS", contract);

  // === FCFS continuous ===
  if (FCFS) {
    const qty = BigInt(amount);
    const id = BigInt(mintId);
    const value = (unitEth && String(unitEth).trim() !== "") ? ethers.parseEther(String(unitEth)) * qty : 0n;
    const w = new ethers.Contract(contract, KINGDOMLY_ABI, wallet);
    await loopFCFS(() => w.batchMint(qty, id, { value, gasLimit: FCFS_GAS_LIMIT, ...gasOv(gasCfg) }));
    return;
  }

  // === WAITING ===
  const ro = new ethers.Contract(contract, KINGDOMLY_ABI, provider);
  const w = new ethers.Contract(contract, KINGDOMLY_ABI, wallet);
  const qty = BigInt(amount);
  const id = BigInt(mintId);
  const value = (unitEth && String(unitEth).trim() !== "") ? ethers.parseEther(String(unitEth)) * qty : 0n;
  const spin = spinner("⏳ Menunggu mint live (Kingdomly)...");
  let attempt = 0;

  for (;;) {
    attempt++;
    try {
      await ro.batchMint.staticCall(qty, id, { from: wallet.address, value, ...gasOv(gasCfg) });
      const gas = await w.batchMint.estimateGas(qty, id, { value, ...gasOv(gasCfg) });
      const tx = await w.batchMint(qty, id, { value, gasLimit: gas, ...gasOv(gasCfg) });
      console.log("\n⏳ TX:", tx.hash);
      const rc = await tx.wait();
      console.log("🎉 Sukses →", rc?.hash ?? rc?.transactionHash ?? tx.hash);
      spin.stop(); return;

    } catch (e) {
      const req = parseRequiredWei(e);
      if (req) {
        try {
          const gas2 = await w.batchMint.estimateGas(qty, id, { value: req, ...gasOv(gasCfg) });
          const gasLimit = (gas2 * 125n) / 100n; // buffer 25%
          const tx2 = await w.batchMint(qty, id, { value: req, gasLimit, ...gasOv(gasCfg) });
          console.log("\n⏳ TX:", tx2.hash);
          const rc2 = await tx2.wait();
          console.log("🎉 Sukses →", rc2?.hash ?? rc2?.transactionHash ?? tx2.hash);
          spin.stop(); return;
        } catch (e2) {
          console.log("❌ Gagal kirim ulang dengan value dari revert:", e2.shortMessage || e2.message || e2);
        }
      }

      try {
        const gas3 = await w.batchMint.estimateGas(qty, id, { value, ...gasOv(gasCfg) });
        const tx3 = await w.batchMint(qty, id, { value, gasLimit: gas3, ...gasOv(gasCfg) });
        console.log("\n⏳ TX:", tx3.hash);
        const rc3 = await tx3.wait();
        console.log("🎉 Sukses →", rc3?.hash ?? rc3?.transactionHash ?? tx3.hash);
        spin.stop(); return;
      } catch (e3) {
        const m = (e3?.shortMessage || e3?.message || "").toLowerCase();
        if (m.includes("insufficient funds")) throw e3;
      }

      spin.start(); spin.update(`Belum live / revert. Attempt ${attempt}.`);
      // tanpa delay
    }
  }
}

/* ======== NEW: Joe/AVAX ======== */
async function runJoe({ provider, wallet, contract, qtyIn, tokenIdIn, unitNative, delaySec, retries, gasCfg, FCFS }) {
  ensureAddr("CONTRACT_ADDRESS", contract);

  // === FCFS continuous ===
  if (FCFS) {
    const qtyB = BigInt(qtyIn);
    const idOpt = tokenIdIn === "" ? null : BigInt(tokenIdIn || "0");
    const value = ethers.parseEther(String(unitNative || "0")) * qtyB;

    await loopFCFS(async () => {
      for (const sig of JOE_ABI_CANDIDATES) {
        try {
          const w = new ethers.Contract(contract, [sig], wallet);
          const name = sig.replace(/^function\s*/, "").split("(")[0].trim();
          try {
            return await w.getFunction(name)(qtyB, { value, gasLimit: FCFS_GAS_LIMIT, ...gasOv(gasCfg) });
          } catch (e) { }
          if (idOpt !== null) {
            try {
              return await w.getFunction(name)(idOpt, qtyB, { value, gasLimit: FCFS_GAS_LIMIT, ...gasOv(gasCfg) });
            } catch (e) { }
          }
        } catch (e) { }
      }
      throw new Error("FCFS: Joe/AVAX gagal dikirim (tak ada signature yang cocok).");
    });
    return;
  }

  const candidates = JOE_ABI_CANDIDATES.map(sig => ({ sig, name: sig.replace(/^function\s*/, "").split("(")[0].trim() }));
  const qty = BigInt(qtyIn);
  const idOpt = tokenIdIn === "" ? null : BigInt(tokenIdIn || "0");
  const value = ethers.parseEther(String(unitNative || "0")) * qty;
  const spin = spinner("⏳ Menunggu mint live (Joe/AVAX)...");
  let attempt = 0;

  for (;;) {
    attempt++;
    for (const { sig, name } of candidates) {
      try {
        const ro = new ethers.Contract(contract, [sig], provider);
        const w = new ethers.Contract(contract, [sig], wallet);
        try {
          await ro.getFunction(name).staticCall(qty, { value, ...gasOv(gasCfg) });
          const gas = await w.getFunction(name).estimateGas(qty, { value, ...gasOv(gasCfg) });
          const tx = await w.getFunction(name)(qty, { value, gasLimit: gas, ...gasOv(gasCfg) });
          console.log(`\n➡️  Matched ABI: ${sig}\n⏳ TX:`, tx.hash);
          const rc = await tx.wait();
          console.log("🎉 Sukses →", rc?.hash ?? rc?.transactionHash ?? tx.hash);
          spin.stop(); return;
        } catch (e) { }
        if (idOpt !== null) {
          try {
            await ro.getFunction(name).staticCall(idOpt, qty, { value, ...gasOv(gasCfg) });
            const gas = await w.getFunction(name).estimateGas(idOpt, qty, { value, ...gasOv(gasCfg) });
            const tx = await w.getFunction(name)(idOpt, qty, { value, gasLimit: gas, ...gasOv(gasCfg) });
            console.log(`\n➡️  Matched ABI: ${sig}\n⏳ TX:`, tx.hash);
            const rc = await tx.wait();
            console.log("🎉 Sukses →", rc?.hash ?? rc?.transactionHash ?? tx.hash);
            spin.stop(); return;
          } catch (e) { }
        }
      } catch (e) { }
    }
    spin.start(); spin.update(`Belum live / revert. Attempt ${attempt}.`);
    await sleep(Math.max(100, Math.floor(delaySec * 1000)));
    if (retries > 0 && attempt >= retries) { /* keep waiting */ }
  }
}

/* ======== NEW: Blever (Ape & ETH) ======== */
async function runBlever({ provider, wallet, contract, toAddr, amount, phaseID, priceEth, mintFeeEth, maxPerTx, maxPerUser, maxPerPhase, nonceHex, signature, delaySec, retries, gasCfg, FCFS }) {
  ensureAddr("CONTRACT_ADDRESS", contract);

  // === FCFS continuous ===
  if (FCFS) {
    const qtyB = BigInt(amount);
    const priceWei = ethers.parseEther(String(priceEth || "0"));
    const mintFeeWei = ethers.parseEther(String(mintFeeEth || "0"));
    const value = priceWei * qtyB + mintFeeWei;

    await loopFCFS(async () => {
      try {
        const w = new ethers.Contract(contract, BLEVER_ABI_WITH_FEE, wallet);
        return await w.mint(toAddr, qtyB, phaseID, priceWei, mintFeeWei, BigInt(maxPerTx || 0), BigInt(maxPerUser || 0), BigInt(maxPerPhase || 0), nonceHex, signature, { value, gasLimit: FCFS_GAS_LIMIT, ...gasOv(gasCfg) });
      } catch (e) {
        const w = new ethers.Contract(contract, BLEVER_ABI_NO_FEE, wallet);
        return await w.mint(toAddr, qtyB, phaseID, priceWei, BigInt(maxPerTx || 0), BigInt(maxPerUser || 0), BigInt(maxPerPhase || 0), nonceHex, signature, { value, gasLimit: FCFS_GAS_LIMIT, ...gasOv(gasCfg) });
      }
    });
    return;
  }

  const qty = BigInt(amount);
  const priceWei = ethers.parseEther(String(priceEth || "0"));
  const mintFeeWei = ethers.parseEther(String(mintFeeEth || "0"));
  const value = priceWei * qty + mintFeeWei;

  const argsNoFee = [toAddr, qty, phaseID, priceWei, BigInt(maxPerTx || 0), BigInt(maxPerUser || 0), BigInt(maxPerPhase || 0), nonceHex, signature];
  const argsWithFee = [toAddr, qty, phaseID, priceWei, mintFeeWei, BigInt(maxPerTx || 0), BigInt(maxPerUser || 0), BigInt(maxPerPhase || 0), nonceHex, signature];

  const spin = spinner("⏳ Menunggu mint live (Blever)...");
  let attempt = 0;

  for (;;) {
    attempt++;
    for (const mode of ["WITH_FEE", "NO_FEE"]) {
      try {
        const abi = mode === "WITH_FEE" ? BLEVER_ABI_WITH_FEE : BLEVER_ABI_NO_FEE;
        const args = mode === "WITH_FEE" ? argsWithFee : argsNoFee;

        const ro = new ethers.Contract(contract, abi, provider);
        const w = new ethers.Contract(contract, abi, wallet);
        await ro.mint.staticCall(...args, { value, ...gasOv(gasCfg) });

        const gas = await w.mint.estimateGas(...args, { value, ...gasOv(gasCfg) });
        const tx = await w.mint(...args, { value, gasLimit: gas, ...gasOv(gasCfg) });

        console.log(`\n➡️  Matched ABI mode: ${mode}\n⏳ TX:`, tx.hash);
        const rc = await tx.wait();
        console.log("🎉 Sukses →", rc?.hash ?? rc?.transactionHash ?? tx.hash);
        spin.stop(); return;
      } catch (e) { /* try next */ }
    }
    spin.start(); spin.update(`Belum live / signature mismatch / revert. Attempt ${attempt}.`);
    await sleep(Math.max(120, Math.floor(delaySec * 1000)));
    if (retries > 0 && attempt >= retries) { /* keep waiting */ }
  }
}

/* ========= MAIN ========= */
async function main() {
  console.log("=== PLATFORM OR EXPLORER NAME ===");
  console.log("1) MAGIC EDEN / NFT2 / BLEVER {mint/mintPublic/publicMint}");
  console.log("2) OPENSEA (SeaDrop){mintPublic}");
  console.log("3) RARIBLE {claim}");
  console.log("4) DRIP (Raw selector/0x6b1a2b7f)");
  console.log("5) KINGDOMLY (batchMint)");
  console.log("6) JOE / AVAX (publicSaleMint/publicMint)");
  console.log("7) BLEVER (Ape & ETH){mint auth}");
  const pick = await q("USE NUMBER", process.env.PLATFORM_INDEX || "1");
  if (["1", "2", "3", "4", "5", "6", "7"].includes(pick) === false) throw new Error("Pilihan tidak valid.");

  // RPC menu
  const { keys, map } = await loadRpcJson("rpc.json");
  console.log("\n=== choose RPC  (from rpc.json) ==="); keys.forEach((k, i) => console.log(`${i + 1}) ${k}`));
  const pickRpc = await q("choose number or paste URL RPC (Enter=1 or input url)", "1");
  let groupKey = null, urls = null;
  if (/^https?:\/\//i.test(pickRpc.trim())) { urls = pickRpc.split(",").map(s => s.trim()).filter(Boolean); groupKey = "custom"; }
  else if (!Number.isNaN(Number(pickRpc))) { const rpcIdx = Number(pickRpc); if (!(rpcIdx >= 1 && rpcIdx <= keys.length)) throw new Error("Pilihan RPC tidak valid."); groupKey = keys[rpcIdx - 1]; urls = map[groupKey]; }
  else { if (!map[pickRpc]) throw new Error("Pilihan RPC tidak valid."); groupKey = pickRpc; urls = map[groupKey]; }
  const { provider, url: rpcUrl, chainId } = await pickHealthyProvider(urls);
  console.log("✅ RPC:", rpcUrl, "| chainId:", chainId, "| group:", groupKey);

  // PK
  const pk = ensurePk(await q("PRIVATE_KEY (0x…)", process.env.PRIVATE_KEY || ""));
  const wallet = new ethers.Wallet(pk, provider);
  console.log("👛 Wallet:", wallet.address);

  // Common
  const qty = BigInt(await q("QTY", process.env.QTY || "1"));
  const delaySec = Number(await q("DELAY detik (0.1 = 100ms)", process.env.DELAY_SEC || "0.1"));
  const retries = Number(await q("RETRIES (0 = infinite)", process.env.RETRIES || "0"));

  // Gas
  console.log("\n=== GAS ===\n1) Auto\n2) gasPrice (gwei)\n3) EIP-1559");
  const mode = await q("Mode gas", process.env.GAS_MODE || "1");
  let gasCfg = { gasPriceGwei: null, maxFeeGwei: null, maxPrioGwei: null };
  if (mode === "2") { gasCfg.gasPriceGwei = await q("gasPrice (gwei)", process.env.GAS_PRICE_GWEI || ""); }
  else if (mode === "3") { gasCfg.maxFeeGwei = await q("maxFeePerGas (gwei)", process.env.MAX_FEE_PER_GAS_GWEI || ""); gasCfg.maxPrioGwei = await q("maxPriorityFeePerGas (gwei)", process.env.MAX_PRIORITY_FEE_GWEI || ""); }

  // === MODE MINT ===
  console.log("\n=== MODE ===\n1) Waiting until live\n2) FCFS (burn gas fee)");
  const mintMode = await q("Pilih mode", process.env.MINT_MODE || "1");
  const FCFS = (mintMode === "2");

  // Platform-specific inputs (minimal)
  let runFn, summary = { platform: "", rpcUrl, chainId, rpcGroup: groupKey, wallet: wallet.address, qty, delaySec, retries, gasCfg, FCFS };

  if (pick === "2") {
    const nftAddr = await q("CONTRACT_ADDRESS (NFT)", process.env.CONTRACT_ADDRESS || "");
    const seaAddr = await q("SEA_ADDRESS", process.env.SEA_ADDRESS || "");
    const feeRec = await q("FEE_RECIPIENT", process.env.FEE_RECIPIENT || "");
    const unitEth = await q("MINT_PRICE_ETH (Enter=auto)", process.env.MINT_PRICE_ETH || "");
    summary.platform = "SeaDrop"; Object.assign(summary, { nftAddr, seaAddr, feeRec, unitEth });
    runFn = () => runSeaDrop({ provider, wallet, nftAddr, seaAddr, feeRecipient: feeRec, qty, unitEth, delaySec, retries, gasCfg, FCFS });

  } else if (pick === "3") {
    const contract = await q("CONTRACT_ADDRESS (proxy drop / kontrak tx)", process.env.CONTRACT_ADDRESS || "");
    const unitEth = await q("MINT_PRICE_ETH (0=auto probe)", process.env.MINT_PRICE_ETH || "0");
    const payTokIn = await q("PAYMENT_TOKEN", "");
    const payTok = (payTokIn || "").trim() || NATIVE;
    summary.platform = "Rarible"; Object.assign(summary, { contract, unitEth, payTok });
    runFn = () => runRarible({ provider, wallet, contract, qty, unitEth, payToken: payTok, delaySec, retries, gasCfg, FCFS });

  } else if (pick === "4") {
    const contract = await q("CONTRACT_ADDRESS", process.env.CONTRACT_ADDRESS || "");
    const unitEth = await q("MINT_PRICE (0=auto)", "0");
    const stageHint = BigInt(await q("STAGE_HINT (prioritas awal)", "4"));
    summary.platform = "DRIP Raw"; Object.assign(summary, { contract, unitEth, stageHint });
    runFn = () => runDRIPRaw({ provider, wallet, contract, qty, unitEth, stageHint, delaySec, retries, gasCfg, FCFS });

  } else if (pick === "5") {
    const contract = await q("CONTRACT_ADDRESS", process.env.CONTRACT_ADDRESS || "");
    const amount = BigInt(await q("AMOUNT (quantity)", process.env.QTY || String(qty)));
    const mintId = BigInt(await q("MINT_ID (contoh 0)", process.env.MINT_ID || "0"));
    const unitEth = await q("MINT_PRICE per unit (native, 0 jika free)", process.env.MINT_PRICE_ETH || "0");
    summary.platform = "Kingdomly"; Object.assign(summary, { contract, amount, mintId, unitEth });
    runFn = () => runKingdom({ provider, wallet, contract, amount, mintId, unitEth, delaySec, retries, gasCfg, FCFS });

  } else if (pick === "6") {
    const contract = await q("CONTRACT_ADDRESS", process.env.CONTRACT_ADDRESS || "");
    const tokenId = await q("TOKEN_ID (Enter=skip utk 721)", process.env.TOKEN_ID || "");
    const unitNat = await q("MINT_PRICE per unit (AVAX/native, 0 jika free)", process.env.MINT_PRICE_ETH || "0");
    summary.platform = "Joe/AVAX"; Object.assign(summary, { contract, qty, tokenId, unitNat });
    runFn = () => runJoe({ provider, wallet, contract, qtyIn: qty, tokenIdIn: tokenId, unitNative: unitNat, delaySec, retries, gasCfg, FCFS });

  } else if (pick === "7") {
    const contract = await q("CONTRACT_ADDRESS", process.env.CONTRACT_ADDRESS || "");
    const toAddr = (await q("TO (recipient 0x…, Enter=wallet)", process.env.TO || wallet.address)).trim() || wallet.address; ensureAddr("TO", toAddr);
    const amount = BigInt(await q("AMOUNT (qty)", process.env.QTY || String(qty)));
    const phaseID = toBytes32(await q("PHASE_ID (bytes32, Enter=0)", process.env.PHASE_ID || "0"));
    const priceEth = await q("PRICE per unit (native, 0 jika free)", process.env.MINT_PRICE_ETH || "0");
    const mintFee = await q("MINT_FEE per tx (native, 0 jika none)", process.env.MINT_FEE || "0");
    const maxPerTx = BigInt(await q("MAX_PER_TX (Enter=0)", process.env.MAX_PER_TX || "0"));
    const maxPerUser = BigInt(await q("MAX_PER_USER (Enter=0)", process.env.MAX_PER_USER || "0"));
    const maxPerPhase = BigInt(await q("MAX_PER_PHASE (Enter=0)", process.env.MAX_PER_PHASE || "0"));
    const nonceHex = toBytes32(await q("NONCE (bytes32)", process.env.NONCE || ""));
    const signature = ensureSig(await q("SIGNATURE (0x…)", process.env.SIGNATURE || ""));
    summary.platform = "Blever"; Object.assign(summary, { contract, toAddr, amount, phaseID, priceEth, mintFee, maxPerTx, maxPerUser, maxPerPhase, nonceHex, sigLen: (signature.length - 2) / 2 });
    runFn = () => runBlever({ provider, wallet, contract, toAddr, amount, phaseID, priceEth, mintFeeEth: mintFee, maxPerTx, maxPerUser, maxPerPhase, nonceHex, signature, delaySec, retries, gasCfg, FCFS });

  } else {
    const contract = await q("CONTRACT_ADDRESS", process.env.CONTRACT_ADDRESS || "");
    const unitEth = await q("MINT_PRICE per unit (native, 0 jika free)", process.env.MINT_PRICE_ETH || "0");
    summary.platform = "ME/NFT2"; Object.assign(summary, { contract, unitEth });
    runFn = () => runMENFT2({ provider, wallet, contract, qty, unitEth, delaySec, retries, gasCfg, FCFS });
  }

  console.log("\n=== DETAILS ===");
  console.dir(summary, { depth: null });
  await q("\nENTER TO RUN", "");

  await runFn();
  rl.close();
}

main().catch(e => {
  console.error("\n❌", e?.shortMessage || e?.message || e);
  if (e?.reason) console.error("reason:", e.reason);
  if (e?.data) console.error("data:", e.data);
  rl.close(); process.exit(1);
});

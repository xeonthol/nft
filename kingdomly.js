#!/usr/bin/env node
// kingdom.js — runner untuk kontrak Kingdomly-style
// Fungsi: batchMint(uint256 amount, uint256 mintId) payable
// Node >=18, ethers v6, ESM (pakai dotenv & rpc.json yang sudah ada)

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFile } from "node:fs/promises";
import { ethers, isAddress } from "ethers";
import dotenv from "dotenv";
dotenv.config({ override: true });

/* ========= Utils ========= */
const rl = createInterface({ input, output });
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const ensureAddr = (label,a)=>{ if(!isAddress(a)) throw new Error(`${label} harus alamat 0x valid: ${a}`); };
const ensurePk = (pk)=>{ if(!/^0x[0-9a-fA-F]{64}$/.test((pk||"").trim())) throw new Error("PRIVATE_KEY tidak valid (0x + 64 hex)."); return pk.trim(); };
const gasOv = ({ gasPriceGwei, maxFeeGwei, maxPrioGwei })=>{
  if (gasPriceGwei) return { gasPrice: ethers.parseUnits(String(gasPriceGwei), "gwei") };
  const o={};
  if (maxFeeGwei)  o.maxFeePerGas         = ethers.parseUnits(String(maxFeeGwei), "gwei");
  if (maxPrioGwei) o.maxPriorityFeePerGas = ethers.parseUnits(String(maxPrioGwei), "gwei");
  return o;
};
const spinner = (text)=>{
  const frames = ["|","/","-","\\"]; let i=0,t;
  return {
    start(){ if(t) return; t=setInterval(()=>process.stdout.write(`\r${frames[i++%4]} ${text} (Ctrl+C untuk berhenti)`),90); },
    update(msg){ process.stdout.write(`\r${frames[i++%4]} ${msg} (Ctrl+C untuk berhenti)`); },
    stop(){ if(t){ clearInterval(t); t=null; process.stdout.write("\r"); } }
  };
};
const q = async (label, def="")=>{
  const ans = (await rl.question(`${label}${def!==""?` (Enter=${def})`:""}: `)).trim();
  return ans===""? def : ans;
};

/* ========= RPC loader (from rpc.json) ========= */
async function loadRpcJson(path = "rpc.json"){
  const raw = await readFile(path, "utf8");
  const j = JSON.parse(raw);
  if (Array.isArray(j)) return { keys:["default"], map:{ default: j } };
  const map = {}; const keys=[];
  for (const k of Object.keys(j)) { if (Array.isArray(j[k])) { keys.push(k); map[k]=j[k]; } }
  if (!keys.length) throw new Error("rpc.json tidak berisi array URL.");
  return { keys, map };
}
async function pickHealthyProvider(urls, timeoutMs=4000){
  const list = (urls||[]).map(s=>String(s||"").trim()).filter(Boolean);
  if (!list.length) throw new Error("Daftar RPC kosong.");
  for (const url of list){
    try{
      const provider = /^wss:/i.test(url) ? new ethers.WebSocketProvider(url) : new ethers.JsonRpcProvider(url);
      const race = Promise.race([
        provider.getNetwork().then(n => ({ provider, url, chainId: Number(n.chainId) })),
        new Promise((_,rej)=>setTimeout(()=>rej(new Error("timeout")), timeoutMs))
      ]);
      const res = await race; return res;
    }catch{ /* next */ }
  }
  throw new Error("Tidak ada RPC yang sehat dari grup terpilih.");
}

/* ========= ABI ========= */
const ABI = [
  "function batchMint(uint256 amount,uint256 mintId) payable"
];

/* ========= Runner ========= */
async function runKingdom({ provider, wallet, contract, amount, mintId, unitEth, delaySec, retries, gasCfg }){
  ensureAddr("CONTRACT_ADDRESS", contract);
  const ro = new ethers.Contract(contract, ABI, provider);
  const w  = new ethers.Contract(contract, ABI, wallet);

  const qty = BigInt(amount);
  const value = (unitEth && String(unitEth).trim()!=="")
    ? ethers.parseEther(String(unitEth)) * qty
    : 0n; // set manual jika perlu (tidak ada computePrice di pattern ini)

  const spin = spinner("⏳ Menunggu mint live (Kingdomly batchMint)…");
  let attempt = 0;

  for(;;){
    attempt++;
    try{
      // cek siap
      await ro.batchMint.staticCall(qty, mintId, { value, ...gasOv(gasCfg) });
      // kirim
      const gas = await w.batchMint.estimateGas(qty, mintId, { value, ...gasOv(gasCfg) });
      const tx  = await w.batchMint(qty, mintId, { value, gasLimit: gas, ...gasOv(gasCfg) });
      console.log("\n⏳ TX:", tx.hash);
      const rc = await tx.wait();
      console.log("🎉 Sukses →", rc?.hash ?? rc?.transactionHash ?? tx.hash);
      spin.stop(); return;
    }catch(e){
      const m = (e?.shortMessage||e?.message||"").toLowerCase();
      if (m.includes("insufficient funds")) throw e;
      spin.start(); spin.update(`Belum live / revert. Attempt ${attempt}.`);
      await sleep(Math.max(100, Math.floor(delaySec*1000))); // min 100ms
      if (retries>0 && attempt>=retries){ /* tetap nunggu sesuai gaya all.js */ }
    }
  }
}

/* ========= MAIN ========= */
async function main(){
  process.on("SIGINT", ()=>{ console.log("\n⛔ Dibatalkan."); rl.close(); process.exit(0); });

  console.log("=== KINGDOMLY / batchMint runner ===");

  // RPC pilih dari rpc.json (sama kayak all.js)
  const { keys, map } = await loadRpcJson("rpc.json");
  console.log("\n=== choose RPC  (from rpc.json) ==="); keys.forEach((k, i) => console.log(`${i + 1}) ${k}`));
  const pickRpc = await q("choose number or paste URL RPC (Enter=1 or input url)", "1");
  let groupKey=null, urls=null;
  if (/^https?:\/\//i.test(pickRpc.trim()) || /^wss:\/\//i.test(pickRpc.trim())){ urls = pickRpc.split(",").map(s=>s.trim()).filter(Boolean); groupKey="custom"; }
  else if (!Number.isNaN(Number(pickRpc))) { const rpcIdx = Number(pickRpc); if (!(rpcIdx>=1 && rpcIdx<=keys.length)) throw new Error("Pilihan RPC tidak valid."); groupKey = keys[rpcIdx-1]; urls = map[groupKey]; }
  else { if (!map[pickRpc]) throw new Error("Pilihan RPC tidak valid."); groupKey = pickRpc; urls = map[groupKey]; }
  const { provider, url: rpcUrl, chainId } = await pickHealthyProvider(urls);
  console.log("✅ RPC:", rpcUrl, "| chainId:", chainId, "| group:", groupKey);

  // PK
  const pk = ensurePk(await q("PRIVATE_KEY (0x…)", process.env.PRIVATE_KEY || ""));
  const wallet = new ethers.Wallet(pk, provider);
  console.log("👛 Wallet:", wallet.address);

  // Inputs (selaras .env kamu)
  const contract = await q("CONTRACT_ADDRESS", process.env.CONTRACT_ADDRESS || "");
  const amount   = BigInt(await q("AMOUNT (quantity)", process.env.QTY || "1"));
  const mintId   = BigInt(await q("MINT_ID", process.env.MINT_ID || "0"));
  const unitEth  = await q("MINT_PRICE_ETH per mint (Enter=0)", process.env.MINT_PRICE_ETH || "0");

  // Loop control
  const delaySec = Number(await q("DELAY detik (0.1 = 100ms)", process.env.DELAY_SEC || "0.15"));
  const retries  = Number(await q("RETRIES (0 = infinite)", process.env.RETRIES || "0"));

  // GAS menu (1=auto, 2=gasPrice, 3=EIP-1559) — sama seperti di all.js
  console.log("\n=== GAS ===\n1) Auto\n2) gasPrice (gwei)\n3) EIP-1559");
  const mode = await q("Mode gas", process.env.GAS_MODE || "3");
  let gasCfg = { gasPriceGwei:null, maxFeeGwei:null, maxPrioGwei:null };
  if (mode==="2"){ gasCfg.gasPriceGwei = await q("gasPrice (gwei)", process.env.GAS_PRICE_GWEI || ""); }
  else if (mode==="3"){ gasCfg.maxFeeGwei = await q("maxFeePerGas (gwei)", process.env.MAX_FEE_PER_GAS_GWEI || ""); gasCfg.maxPrioGwei = await q("maxPriorityFeePerGas (gwei)", process.env.MAX_PRIORITY_FEE_GWEI || ""); }

  // Ringkasan + konfirmasi run
  const summary = { platform:"Kingdomly", rpcUrl, chainId, rpcGroup: groupKey, wallet: wallet.address, contract, amount, mintId, unitEth, delaySec, retries, gasCfg };
  console.log("\n=== DETAILS ==="); console.dir(summary, { depth: null });
  await q("\nENTER TO RUN", "");

  await runKingdom({ provider, wallet, contract, amount, mintId, unitEth, delaySec, retries, gasCfg });
  rl.close();
}

main().catch(e=>{
  console.error("\n❌", e?.shortMessage || e?.message || e);
  if (e?.reason) console.error("reason:", e.reason);
  if (e?.data)   console.error("data:", e.data);
  rl.close(); process.exit(1);
});

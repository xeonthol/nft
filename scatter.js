#!/usr/bin/env node
// mint_archetype.js — Standalone minter untuk kontrak Archetype-style
// Node >=18, ethers v6, ESM. Baca rpc.json, dukung HTTP/WSS, gas menu, wait-until-live.
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFile } from "node:fs/promises";
import { ethers, isAddress, ZeroAddress } from "ethers";
import dotenv from "dotenv";
dotenv.config({ override: true });

/* ========= Utils ========= */
const rl = createInterface({ input, output });
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const nowSec = ()=>Math.floor(Date.now()/1000);
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
const parseBytes32 = (s)=>{
  if (!s || s==="public" || s==="0" || s==="0x0") return "0x"+"00".repeat(32);
  const hex = s.startsWith("0x")? s.slice(2):s;
  if (hex.length>64) throw new Error("KEY terlalu panjang (>32 bytes).");
  return "0x"+hex.padStart(64,"0");
};
const parseProofList = (s)=>{
  if (!s) return [];
  return s.split(",").map(x=>x.trim()).filter(Boolean).map(x=>{
    const hx = x.startsWith("0x")?x:`0x${x}`;
    if ((hx.length-2)!==64) throw new Error(`Proof bukan bytes32: ${x}`);
    return hx;
  });
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

/* ========= ABI (Archetype) ========= */
/*
  Archetype v0.5+:
  - function mint((bytes32 key, bytes32[] proof) auth, uint256 quantity, address affiliate, bytes signature) payable
  - function computePrice(bytes32 key, uint256 quantity, bool affiliateUsed) view returns (uint256)
  - function invites(bytes32 key) view returns (
        uint128 price, uint128 reservePrice, uint128 delta,
        uint32 start, uint32 end, uint32 limit, uint32 maxSupply, uint32 interval, uint32 unitSize,
        address tokenAddress, bool isBlacklist
    )
*/
const ARCHETYPE_ABI = [
  "function mint((bytes32 key, bytes32[] proof) auth,uint256 quantity,address affiliate,bytes signature) payable",
  "function computePrice(bytes32 key,uint256 quantity,bool affiliateUsed) view returns (uint256)",
  "function invites(bytes32 key) view returns (uint128,uint128,uint128,uint32,uint32,uint32,uint32,uint32,uint32,address,bool)"
];

/* ========= Runner ========= */
async function runArchetypeMint({ provider, wallet, contract, qtyIn, keyHex, proofList, affiliate, sigHex, unitEth, delaySec, retries, gasCfg }){
  ensureAddr("CONTRACT_ADDRESS", contract);
  if (affiliate && affiliate !== ZeroAddress) ensureAddr("AFFILIATE", affiliate);
  const ro = new ethers.Contract(contract, ARCHETYPE_ABI, provider);
  const w  = new ethers.Contract(contract, ARCHETYPE_ABI, wallet);

  // Cek tokenAddress (ETH only)
  let tokenAddr = ZeroAddress;
  try {
    const inv = await ro.invites(keyHex);
    tokenAddr = String(inv[9] ?? ZeroAddress);
  } catch {}
  if (tokenAddr && tokenAddr !== ZeroAddress) {
    throw new Error(`Invite ini memakai ERC20 token: ${tokenAddr} — script hanya support native ETH.`);
  }

  // Harga
  let qty = BigInt(qtyIn);
  let value = 0n;
  if (unitEth && String(unitEth).trim()!=="") {
    value = ethers.parseEther(String(unitEth)) * qty;
  } else {
    try {
      const total = await ro.computePrice(keyHex, qty, Boolean(affiliate && affiliate!==ZeroAddress));
      value = BigInt(total);
    } catch { value = 0n; }
  }

  const auth = { key: keyHex, proof: proofList };
  const spin = spinner("⏳ Menunggu mint live (Archetype)…");
  let attempt = 0;

  for(;;){
    attempt++;
    try{
      // static check
      await w.mint.staticCall(auth, qty, affiliate||ZeroAddress, sigHex, { value, ...gasOv(gasCfg) });
      // estimate & send
      const gas = await w.mint.estimateGas(auth, qty, affiliate||ZeroAddress, sigHex, { value, ...gasOv(gasCfg) });
      const tx  = await w.mint(auth, qty, affiliate||ZeroAddress, sigHex, { value, gasLimit: gas, ...gasOv(gasCfg) });
      console.log("\n⏳ TX:", tx.hash);
      const rc = await tx.wait();
      console.log("🎉 Sukses →", rc?.hash ?? rc?.transactionHash ?? tx.hash);
      spin.stop(); return;
    }catch(e){
      const msg = (e?.shortMessage||e?.message||"revert").toLowerCase();
      if (msg.includes("insufficient funds")) throw e;
      spin.start(); spin.update(`Belum live / revert. Attempt ${attempt}.`);
      await sleep(Math.max(10, Math.floor(delaySec*1000)));
      if (retries>0 && attempt>=retries){ /* keep waiting (gaya kamu) */ }
    }
  }
}

/* ========= MAIN ========= */
async function main(){
  process.on("SIGINT", ()=>{ console.log("\n⛔ Dibatalkan."); rl.close(); process.exit(0); });

  console.log("=== ARCTYPE PUBLIC/WL MINT (single-file) ===");

  // RPC
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

  // Inputs
  const contract = await q("CONTRACT_ADDRESS", process.env.CONTRACT_ADDRESS || "");
  const qty      = BigInt(await q("QTY", process.env.QTY || "1"));
  const keyIn    = await q("KEY (bytes32)  (ketik 'public' atau 0 jika public)", process.env.KEY || "public");
  const keyHex   = parseBytes32(keyIn);
  const proofIn  = await q("MERKLE_PROOF (comma, kosong jika public)", process.env.MERKLE_PROOF || "");
  const proof    = parseProofList(proofIn);
  const affiliate= await q("AFFILIATE (0x… kosong jika tidak ada)", process.env.AFFILIATE || "");
  const sigHex   = (await q("SIGNATURE (0x… kosong jika public)", process.env.SIGNATURE || "")).trim() || "0x";
  const unitEth  = await q("MINT_PRICE_ETH (Enter=auto)", process.env.MINT_PRICE_ETH || "");

  // Loop settings
  const delaySec = Number(await q("DELAY detik (0.1 = 100ms)", process.env.DELAY_SEC || "0.1"));
  const retries  = Number(await q("RETRIES (0 = infinite)", process.env.RETRIES || "0"));

  // Gas
  console.log("\n=== GAS ===\n1) Auto\n2) gasPrice (gwei)\n3) EIP-1559");
  const mode = await q("Mode gas", process.env.GAS_MODE || "1");
  let gasCfg = { gasPriceGwei:null, maxFeeGwei:null, maxPrioGwei:null };
  if (mode==="2"){ gasCfg.gasPriceGwei = await q("gasPrice (gwei)", process.env.GAS_PRICE_GWEI || ""); }
  else if (mode==="3"){ gasCfg.maxFeeGwei = await q("maxFeePerGas (gwei)", process.env.MAX_FEE_PER_GAS_GWEI || ""); gasCfg.maxPrioGwei = await q("maxPriorityFeePerGas (gwei)", process.env.MAX_PRIORITY_FEE_GWEI || ""); }

  // Ringkasan
  const summary = { platform:"Archetype", rpcUrl, chainId, rpcGroup: groupKey, wallet: wallet.address, contract, qty, keyHex, proofLen: proof.length, affiliate, sigLen: sigHex==="0x"?0:(sigHex.length-2)/2, unitEth, delaySec, retries, gasCfg };
  console.log("\n=== DETAILS ==="); console.dir(summary, { depth: null });
  await q("\nENTER TO RUN", "");

  await runArchetypeMint({ provider, wallet, contract, qtyIn: qty, keyHex, proofList: proof, affiliate, sigHex, unitEth, delaySec, retries, gasCfg });
  rl.close();
}

main().catch(e=>{
  console.error("\n❌", e?.shortMessage || e?.message || e);
  if (e?.reason) console.error("reason:", e.reason);
  if (e?.data)   console.error("data:", e.data);
  rl.close(); process.exit(1);
});

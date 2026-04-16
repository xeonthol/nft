#!/usr/bin/env node
// element/element.js — Element Launchpad runner (ethers v6, ESM/Node >=18)
// Tx example matched: launchpadBuy(bytes4,bytes4,uint256,uint256,uint256[],bytes) payable
// Reads RPC groups from rpc.json, supports EIP-1559, retry loop, and staticCall pre-check.

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFile } from "node:fs/promises";
import { ethers, isAddress } from "ethers";

const rl = createInterface({ input, output });

/* ========= Utils ========= */
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const ensurePk = (pk)=>{ if(!/^0x[0-9a-fA-F]{64}$/.test((pk||"").trim())) throw new Error("PRIVATE_KEY tidak valid (0x + 64 hex)."); return pk.trim(); };
const ensureAddr = (label,a)=>{ if(!isAddress(a)) throw new Error(`${label} harus alamat 0x valid: ${a}`); };
const q = async (label, def="")=>{
  const ans = (await rl.question(`${label}${def!==""?` (Enter=${def})`:""}: `)).trim();
  return ans===""? def : ans;
};
const gasOv = ({ gasPriceGwei, maxFeeGwei, maxPrioGwei })=>{
  if (gasPriceGwei) return { gasPrice: ethers.parseUnits(String(gasPriceGwei), "gwei") };
  const o={};
  if (maxFeeGwei)  o.maxFeePerGas         = ethers.parseUnits(String(maxFeeGwei), "gwei");
  if (maxPrioGwei) o.maxPriorityFeePerGas = ethers.parseUnits(String(maxPrioGwei), "gwei");
  return o;
};
const toBytes4 = (s)=>{
  let hex = String(s||"").trim();
  if (hex.startsWith("0x")) hex = hex.slice(2);
  if (hex.length===0) throw new Error("PROJECT_ID/LAUNCHPAD_ID wajib diisi (bytes4).");
  if (hex.length>8)   throw new Error("bytes4 terlalu panjang (max 8 hex).");
  return "0x"+hex.padEnd(8,"0"); // Element biasanya treat sebagai id 4-byte; pad kanan aman untuk ID pendek
};
const parseUintArrayCsv = (s)=>{
  const t = String(s||"").trim();
  if (!t) return [];
  return t.split(/[,\s]+/).filter(Boolean).map(x=>BigInt(x));
};

/* ========= RPC loader ========= */
async function loadRpcJson(path="rpc.json"){
  const raw = await readFile(path,"utf8");
  const j = JSON.parse(raw);
  if (Array.isArray(j)) return { keys:["default"], map:{ default:j } };
  const map={}, keys=[];
  for(const k of Object.keys(j)){ if(Array.isArray(j[k])){ keys.push(k); map[k]=j[k]; } }
  if(!keys.length) throw new Error("rpc.json tidak berisi array URL.");
  return { keys, map };
}
async function pickHealthyProvider(urls, timeoutMs=4000){
  const list=(urls||[]).map(s=>String(s||"").trim()).filter(Boolean);
  if(!list.length) throw new Error("Daftar RPC kosong.");
  for(const url of list){
    try{
      const provider = new ethers.JsonRpcProvider(url);
      const race = Promise.race([
        provider.getNetwork().then(n=>({ provider, url, chainId: Number(n.chainId) })),
        new Promise((_,rej)=>setTimeout(()=>rej(new Error("timeout")), timeoutMs))
      ]);
      const res = await race; return res;
    }catch{/* next */}
  }
  throw new Error("Tidak ada RPC yang sehat dari grup terpilih.");
}

/* ========= ABI ========= */
const ELEMENT_ABI = [
  "function launchpadBuy(bytes4 projectId,bytes4 launchpadId,uint256 slotId,uint256 quantity,uint256[] additional,bytes data) payable"
];

/* ========= Spinner ========= */
const spinner = (text)=>{
  const frames=["|","/","-","\\"]; let i=0,t;
  return {
    start(){ if(t) return; t=setInterval(()=>process.stdout.write(`\r${frames[i++%4]} ${text} (Ctrl+C untuk berhenti)`),90); },
    update(msg){ process.stdout.write(`\r${frames[i++%4]} ${msg} (Ctrl+C untuk berhenti)`); },
    stop(){ if(t){ clearInterval(t); t=null; process.stdout.write("\r"); } }
  };
};

/* ========= Runner ========= */
async function runElement({ provider, wallet, contract, projectId4, launchpadId4, slotId, qty, addArr, dataHex, unitEth, delaySec, retries, gasCfg }){
  ensureAddr("CONTRACT_ADDRESS", contract);
  const ro = new ethers.Contract(contract, ELEMENT_ABI, provider);
  const w  = new ethers.Contract(contract, ELEMENT_ABI, wallet);

  const priceWei = ethers.parseEther(String(unitEth||"0"));
  const value = priceWei * qty;

  const spin = spinner("⏳ Menunggu mint live (Element Launchpad)...");
  let attempt=0;
  for(;;){
    attempt++;
    try{
      await ro.launchpadBuy.staticCall(projectId4, launchpadId4, slotId, qty, addArr, dataHex, { value, ...gasOv(gasCfg) });
      const gas = await w.launchpadBuy.estimateGas(projectId4, launchpadId4, slotId, qty, addArr, dataHex, { value, ...gasOv(gasCfg) });
      const tx  = await w.launchpadBuy(projectId4, launchpadId4, slotId, qty, addArr, dataHex, { value, gasLimit: gas, ...gasOv(gasCfg) });
      console.log("\n⏳ TX:", tx.hash);
      const rc = await tx.wait();
      console.log("🎉 Sukses →", rc?.hash ?? rc?.transactionHash ?? tx.hash);
      spin.stop(); return;
    }catch(e){
      const msg = (e?.shortMessage||e?.message||"").toLowerCase();
      if (msg.includes("insufficient funds")) throw e;
      spin.start(); spin.update(`Belum live / argumen salah / revert. Attempt ${attempt}.`);
      await sleep(Math.max(100, Math.floor((delaySec||0.1)*1000)));
      if (retries>0 && attempt>=retries){ /* continue looping ala wait-until-live */ }
    }
  }
}

/* ========= MAIN ========= */
async function main(){
  try{
    // RPC
    const { keys, map } = await loadRpcJson("rpc.json");
    console.log("=== ELEMENT LAUNCHPAD ===");
    console.log("\n=== choose RPC (from rpc.json) ===");
    keys.forEach((k,i)=>console.log(`${i+1}) ${k}`));
    const pickRpc = await q("choose number or paste URL RPC (Enter=1 or input url)", "1");

    let groupKey=null, urls=null;
    if (/^https?:\/\//i.test(pickRpc.trim())){ urls = pickRpc.split(",").map(s=>s.trim()).filter(Boolean); groupKey="custom"; }
    else if (!Number.isNaN(Number(pickRpc))) { const rpcIdx = Number(pickRpc); if (!(rpcIdx>=1 && rpcIdx<=keys.length)) throw new Error("Pilihan RPC tidak valid."); groupKey = keys[rpcIdx-1]; urls = map[groupKey]; }
    else { if (!map[pickRpc]) throw new Error("Pilihan RPC tidak valid."); groupKey = pickRpc; urls = map[groupKey]; }

    const { provider, url: rpcUrl, chainId } = await pickHealthyProvider(urls);
    console.log("✅ RPC:", rpcUrl, "| chainId:", chainId, "| group:", groupKey);

    // PK
    const pk = ensurePk(await q("PRIVATE_KEY (0x…)", process.env.PRIVATE_KEY || ""));
    const wallet = new ethers.Wallet(pk, provider);
    console.log("👛 Wallet:", wallet.address);

    // GAS
    console.log("\n=== GAS ===\n1) Auto\n2) gasPrice (gwei)\n3) EIP-1559");
    const mode = await q("Mode gas", process.env.GAS_MODE || "1");
    let gasCfg = { gasPriceGwei:null, maxFeeGwei:null, maxPrioGwei:null };
    if (mode==="2"){ gasCfg.gasPriceGwei = await q("gasPrice (gwei)", process.env.GAS_PRICE_GWEI || ""); }
    else if (mode==="3"){ gasCfg.maxFeeGwei = await q("maxFeePerGas (gwei)", process.env.MAX_FEE_PER_GAS_GWEI || ""); gasCfg.maxPrioGwei = await q("maxPriorityFeePerGas (gwei)", process.env.MAX_PRIORITY_FEE_GWEI || ""); }

    // Inputs
    const contract = await q("CONTRACT_ADDRESS", process.env.CONTRACT_ADDRESS || "");
    const projectId4    = toBytes4(await q("PROJECT_ID (bytes4, ex: 0c21cfbb)", process.env.PROJECT_ID || ""));
    const launchpadId4  = toBytes4(await q("LAUNCHPAD_ID (bytes4, ex: e75bfbba)", process.env.LAUNCHPAD_ID || ""));
    const slotId        = BigInt(await q("SLOT_ID (uint256)", process.env.SLOT_ID || "0"));
    const qty           = BigInt(await q("QTY", process.env.QTY || "1"));
    const additionalCsv = await q("ADDITIONAL uint256[] (comma sep, Enter=none)", process.env.ADDITIONAL || "");
    const addArr        = parseUintArrayCsv(additionalCsv);
    let dataHex         = (await q("DATA_HEX (0x…, Enter=0x)", process.env.DATA_HEX || "0x")).trim();
    if (!/^0x[0-9a-fA-F]*$/.test(dataHex)) throw new Error("DATA_HEX harus hex 0x…");
    const unitEth       = await q("MINT_PRICE per unit (native, 0 jika free)", process.env.MINT_PRICE_ETH || "0");

    // Ringkasan
    const summary = { platform:"Element", rpcUrl, chainId, rpcGroup: groupKey, wallet: wallet.address,
      contract, projectId4, launchpadId4, slotId, qty, addArr, dataHex, unitEth, gasCfg };
    console.log("\n=== DETAILS ===");
    console.dir(summary, { depth:null });

    await q("\nENTER TO RUN", "");
    await runElement({ provider, wallet, contract, projectId4, launchpadId4, slotId, qty, addArr, dataHex, unitEth, delaySec: Number(process.env.DELAY_SEC||"0.1"), retries: Number(process.env.RETRIES||"0"), gasCfg });

    rl.close();
  }catch(e){
    console.error("\n❌", e?.shortMessage || e?.message || e);
    if (e?.reason) console.error("reason:", e.reason);
    if (e?.data)   console.error("data:", e.data);
    rl.close(); process.exit(1);
  }
}

main();

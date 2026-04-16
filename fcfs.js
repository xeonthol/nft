#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFile } from "node:fs/promises";
import { ethers, isAddress, ZeroAddress } from "ethers";
import dotenv from "dotenv";
import { scheduleMint } from './timer.js';  // ← TAMBAHAN: Import timer
dotenv.config({ override: true });

/* ========= Utils ========= */
const rl = createInterface({ input, output });
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const isNative = (addr)=> (addr||NATIVE).toLowerCase() === NATIVE.toLowerCase();
const ensureAddr = (label,a)=>{ if(!isAddress(a)) throw new Error(`${label} harus alamat 0x valid: ${a}`); };

const gasOv = ({ gasPriceGwei, maxFeeGwei, maxPrioGwei })=>{
  if (gasPriceGwei) return { gasPrice: ethers.parseUnits(String(gasPriceGwei), "gwei") };
  const o={};
  if (maxFeeGwei)  o.maxFeePerGas        = ethers.parseUnits(String(maxFeeGwei), "gwei");
  if (maxPrioGwei) o.maxPriorityFeePerGas = ethers.parseUnits(String(maxPrioGwei), "gwei");
  return o;
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
      const provider = new ethers.JsonRpcProvider(url);
      const race = Promise.race([
        provider.getNetwork().then(n => ({ provider, url, chainId: Number(n.chainId) })),
        new Promise((_,rej)=>setTimeout(()=>rej(new Error("timeout")), timeoutMs))
      ]);
      const res = await race; return res;
    }catch{}
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
const MEDRIP_ABIS = [
  "function mintPublic(address to,uint256 tokenId,uint256 qty,bytes data) payable",
  "function mint(uint256 quantity) payable",
  "function publicMint(uint256 quantity) payable",
  "function mintTo(address to,uint256 quantity) payable",
  "function mint(address to,uint256 quantity) payable"
];

/* ========= DRIP Raw helpers ========= */
const DRIP_PRICE_GUESS_LIST = (process.env.DRIP_PRICE_GUESS_LIST || "0,0.05,0.04,0.03,0.02,0.075,0.069,0.1,0.2,0.5,1")
  .split(",").map(s=>s.trim()).filter(Boolean);
const DRIP_STAGE_TRY_DEFAULT = (process.env.DRIP_STAGE_TRY || "0,1,2,3,4,5,6,7,8,9,10,11,12")
  .split(",").map(s=>s.trim()).filter(Boolean).map(x=>BigInt(x));

const encDripData = (stageId, qty)=>{
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return "0x6b1a2b7f" + coder.encode(["uint256","uint256","bytes"],[stageId, qty, "0x"]).slice(2);
};

/* ========= BLAST LOOP ========= */
async function blastLoop({ provider, wallet, to, dataBuilder, valueBuilder, gasCfg, startNonce, delayMs=0 }){
  let nonce = startNonce;
  let i = 0;
  while (true){
    i++;
    const data  = dataBuilder(i);
    const value = valueBuilder?.(i) ?? 0n;

    let tx = { to, data, value, nonce, ...gasOv(gasCfg) };
    if (!("gasLimit" in tx)){
      try{
        const est = await provider.estimateGas({ ...tx, from: wallet.address });
        tx.gasLimit = (est * 120n)/100n;
      }catch{ tx.gasLimit = 300000n; }
    }

    try{
      const sent = await wallet.sendTransaction(tx);
      console.log(`⏳ TX [#${i}] ${sent.hash}`);
    }catch(e){
      console.log(`❌ send fail [#${i}]:`, e?.shortMessage || e?.message || e);
    }

    nonce += 1;
    if (delayMs>0) await sleep(delayMs);
    else await sleep(0);
  }
}

/* ========= Runners (NO wait for live) ========= */
async function runSeaDrop({ provider, wallet, nftAddr, seaAddr, feeRecipient, qty, unitEth, delaySec, gasCfg }){
  ensureAddr("NFT (CONTRACT_ADDRESS)", nftAddr);
  ensureAddr("SEA_ADDRESS", seaAddr);
  if (feeRecipient) ensureAddr("FEE_RECIPIENT", feeRecipient);

  const seaRO = new ethers.Contract(seaAddr, SEADROP_ABI, provider);
  let price = unitEth ? ethers.parseEther(unitEth) : 0n;
  try { const d = await seaRO.getPublicDrop(nftAddr); if (!unitEth) price = BigInt(d.mintPrice ?? d[0] ?? 0n); } catch {}

  const iface = new ethers.Interface(SEADROP_ABI);
  const dataFixed = iface.encodeFunctionData("mintPublic", [nftAddr, feeRecipient||ZeroAddress, wallet.address, qty]);
  const valueFixed = price * qty;

  const startNonce = await provider.getTransactionCount(wallet.address, "pending");
  await blastLoop({
    provider, wallet, to: seaAddr,
    dataBuilder: ()=>dataFixed,
    valueBuilder: ()=>valueFixed,
    gasCfg, startNonce,
    delayMs: Math.max(0, Math.floor(delaySec*1000))
  });
}

async function runRarible({ provider, wallet, contract, qty, unitEth, payToken, delaySec, gasCfg }){
  ensureAddr("CONTRACT_ADDRESS", contract);
  const isNat = isNative(payToken||NATIVE);

  // rotasi: ABI × argset × priceGuess
  const guessPrices = (unitEth && Number(unitEth)>0)
    ? [unitEth]
    : (process.env.PRICE_GUESS_LIST || "0,0.0001,0.001,0.005,0.01,0.02,0.05,0.069,0.1,0.2,1").split(",").map(s=>s.trim()).filter(Boolean);

  // siapkan encoder utk tiap varian
  const variants = [];

  // OE exact
  variants.push({
    sig: RARI_OE_ABI[0],
    buildArgs: (uWei)=>[ wallet.address, qty, (payToken||NATIVE), uWei, [[],0n,(1n<<256n)-1n,ZeroAddress], "0x" ],
    needsValue: true
  });

  // 3 varian umum
  variants.push(
    {
      sig: RARI_CLAIM_ABIS[0],
      buildArgs: (uWei)=>[ wallet.address, qty, (payToken||NATIVE), uWei, [[],0n,uWei,(payToken||NATIVE)], "0x" ],
      needsValue: true
    },
    {
      sig: RARI_CLAIM_ABIS[1],
      buildArgs: (uWei)=>[ qty, (payToken||NATIVE), uWei, [[],0n,uWei,(payToken||NATIVE)], "0x" ],
      needsValue: true
    },
    {
      sig: RARI_CLAIM_ABIS[2],
      buildArgs: (uWei)=>[ wallet.address, qty, (payToken||NATIVE), uWei, [[],0n,uWei,(payToken||NATIVE)], "0x", ZeroAddress ],
      needsValue: true
    }
  );

  // rotator
  let iVar=0, iPrice=0;
  const startNonce = await provider.getTransactionCount(wallet.address, "pending");

  await blastLoop({
    provider, wallet, to: contract,
    dataBuilder: ()=>{
      const v = variants[iVar];
      const iface = new ethers.Interface([v.sig]);
      const s = guessPrices[iPrice];
      let uWei = 0n; try{ uWei = ethers.parseEther(s); }catch{}
      const data = iface.encodeFunctionData("claim", v.buildArgs(uWei));
      iVar = (iVar+1) % variants.length;
      if (iVar===0) iPrice = (iPrice+1) % guessPrices.length;
      return data;
    },
    valueBuilder: ()=>{
      const s = guessPrices[(iPrice===0? guessPrices.length-1 : iPrice-1)];
      let uWei = 0n; try{ uWei = ethers.parseEther(s); }catch{}
      return isNat ? uWei*qty : 0n;
    },
    gasCfg, startNonce,
    delayMs: Math.max(0, Math.floor(delaySec*1000))
  });
}

async function runMEDrip({ provider, wallet, contract, qty, unitEth, delaySec, gasCfg }){
  ensureAddr("CONTRACT_ADDRESS", contract);
  const ABIS = MEDRIP_ABIS.map(s=>`function ${s}`);
  const uWei = ethers.parseEther(unitEth||"0");

  // siapkan semua kandidat call
  const cands = [];
  for (const sig of ABIS){
    const name = sig.split("(")[0].replace("function ","");
    const iface = new ethers.Interface([sig]);
    const argSets = [
      [wallet.address, 0, Number(qty), "0x"],
      [Number(qty)],
      [Number(qty)],
      [wallet.address, Number(qty)],
      [wallet.address, Number(qty)],
    ];
    for (const args of argSets){
      cands.push({ to: contract, iface, name, args });
    }
  }

  let i=0;
  const startNonce = await provider.getTransactionCount(wallet.address, "pending");

  await blastLoop({
    provider, wallet, to: contract,
    dataBuilder: ()=>{
      const c = cands[i];
      const data = c.iface.encodeFunctionData(c.name, c.args);
      i = (i+1) % cands.length;
      return data;
    },
    valueBuilder: ()=> uWei*qty,
    gasCfg, startNonce,
    delayMs: Math.max(0, Math.floor(delaySec*1000))
  });
}

async function runDRIPRaw({ provider, wallet, contract, qty, unitEth, stageHint, delaySec, gasCfg }){
  ensureAddr("CONTRACT_ADDRESS", contract);
  const stages = [stageHint, ...DRIP_STAGE_TRY_DEFAULT.filter(x=>x!==stageHint)];
  const prices = (unitEth && unitEth!=="0") ? [unitEth] : DRIP_PRICE_GUESS_LIST;

  let iS=0, iP=0;
  const startNonce = await provider.getTransactionCount(wallet.address, "pending");

  await blastLoop({
    provider, wallet, to: contract,
    dataBuilder: ()=>{
      const st = stages[iS];
      const data = encDripData(st, qty);
      iS=(iS+1)%stages.length; if(iS===0) iP=(iP+1)%prices.length;
      return data;
    },
    valueBuilder: ()=>{
      const px = prices[(iP===0? prices.length-1 : iP-1)];
      let wei=0n; try{ wei = ethers.parseEther(px); }catch{}
      return wei*qty;
    },
    gasCfg, startNonce,
    delayMs: Math.max(0, Math.floor(delaySec*1000))
  });
}

/* ========= MAIN ========= */
async function main(){
  console.log("=== PLATFORM ===");
  console.log("1) MAGIC EDEN / NFT2 ");
  console.log("2) OPENSEA (SeaDrop)");
  console.log("3) RARIBLE");
  console.log("4) DRIP (Raw selector)");
  const pick = await q("Masukkan nomor", process.env.PLATFORM_INDEX || "1");
  if (!["1","2","3","4"].includes(pick)) throw new Error("Pilihan tidak valid.");

  // RPC menu
  const { keys, map } = await loadRpcJson("rpc.json");
  console.log("\n=== choose RPC  (from rpc.json) ===");
  keys.forEach((k, i) => console.log(`${i + 1}) ${k}`));
  const pickRpc = await q("choose number or paste URL RPC (Enter=1 or input url)", "1");
  let groupKey=null, urls=null;
  if (/^https?:\/\//i.test(pickRpc.trim())){ urls = pickRpc.split(",").map(s=>s.trim()).filter(Boolean); groupKey="custom"; }
  else if (!Number.isNaN(Number(pickRpc))) { const rpcIdx = Number(pickRpc); if (!(rpcIdx>=1 && rpcIdx<=keys.length)) throw new Error("Pilihan RPC tidak valid."); groupKey = keys[rpcIdx-1]; urls = map[groupKey]; }
  else { if (!map[pickRpc]) throw new Error("Pilihan RPC tidak valid."); groupKey = pickRpc; urls = map[groupKey]; }
  const { provider, url: rpcUrl, chainId } = await pickHealthyProvider(urls);
  console.log("✅ RPC:", rpcUrl, "| chainId:", chainId, "| group:", groupKey);

  // PK
  const pk = await q("PRIVATE_KEY (0x…)", process.env.PRIVATE_KEY || "");
  const wallet = new ethers.Wallet(pk, provider);
  console.log("👛 Wallet:", wallet.address);

  // Common
  const qty       = BigInt(await q("QTY", process.env.QTY || "1"));
  const delaySec  = Number(await q("DELAY detik (0 = no delay)", process.env.DELAY_SEC || "0"));

  // Gas
  console.log("\n=== GAS ===\n1) Auto\n2) gasPrice (gwei)\n3) EIP-1559");
  const mode = await q("Mode gas", process.env.GAS_MODE || "1");
  let gasCfg = { gasPriceGwei:null, maxFeeGwei:null, maxPrioGwei:null };
  if (mode==="2"){ gasCfg.gasPriceGwei = await q("gasPrice (gwei)", process.env.GAS_PRICE_GWEI || ""); }
  else if (mode==="3"){ 
    gasCfg.maxFeeGwei  = await q("maxFeePerGas (gwei)", process.env.MAX_FEE_PER_GAS_GWEI || ""); 
    gasCfg.maxPrioGwei = await q("maxPriorityFeePerGas (gwei)", process.env.MAX_PRIORITY_FEE_GWEI || ""); 
  }

  // Platform-specific inputs
  let runFn, summary = { platform:"", rpcUrl, chainId, rpcGroup: groupKey, wallet: wallet.address, qty, delaySec, gasCfg };

  if (pick==="2"){
    const nftAddr = await q("CONTRACT_ADDRESS (NFT)", process.env.CONTRACT_ADDRESS || "");
    const seaAddr = await q("SEA_ADDRESS", process.env.SEA_ADDRESS || "");
    const feeRec  = await q("FEE_RECIPIENT", process.env.FEE_RECIPIENT || "");
    const unitEth = await q("MINT_PRICE_ETH (kosong=auto dari drop/0)", process.env.MINT_PRICE_ETH || "");
    summary.platform="SeaDrop"; Object.assign(summary,{ nftAddr, seaAddr, feeRec, unitEth });
    runFn = ()=>runSeaDrop({ provider, wallet, nftAddr, seaAddr, feeRecipient: feeRec, qty, unitEth, delaySec, gasCfg });
  } else if (pick==="3"){
    const contract = await q("CONTRACT_ADDRESS (proxy drop / kontrak tx)", process.env.CONTRACT_ADDRESS || "");
    const unitEth  = await q("MINT_PRICE_ETH (kosong=pakai daftar tebakan)", process.env.MINT_PRICE_ETH || "");
    const payTokIn = await q("PAYMENT_TOKEN", "");
    const payTok   = (payTokIn||"").trim() || NATIVE;
    summary.platform="Rarible"; Object.assign(summary,{ contract, unitEth, payTok });
    runFn = ()=>runRarible({ provider, wallet, contract, qty, unitEth, payToken: payTok, delaySec, gasCfg });
  } else if (pick==="4"){
    const contract = await q("CONTRACT_ADDRESS", process.env.CONTRACT_ADDRESS || "");
    const unitEth  = await q("MINT_PRICE (0/blank=pakai daftar tebakan)", process.env.MINT_PRICE || "");
    const stageHint= BigInt(await q("STAGE_HINT (prioritas awal)", "4"));
    summary.platform="DRIP Raw"; Object.assign(summary,{ contract, unitEth, stageHint });
    runFn = ()=>runDRIPRaw({ provider, wallet, contract, qty, unitEth, stageHint, delaySec, gasCfg });
  } else {
    const contract = await q("CONTRACT_ADDRESS", process.env.CONTRACT_ADDRESS || "");
    const unitEth  = await q("MINT_PRICE_ETH (0 jika free)", process.env.MINT_PRICE_ETH || "0");
    summary.platform="ME/Drip"; Object.assign(summary,{ contract, unitEth });
    runFn = ()=>runMEDrip({ provider, wallet, contract, qty, unitEth, delaySec, gasCfg });
  }

  // Ringkasan & KONFIRMASI TERAKHIR
  console.log("\n=== DETAILS ===");
  console.dir(summary, { depth: null });
  await q("\nENTER TO RUN", "");   // <-- Sekarang di PALING BAWAH

  await runFn();
  rl.close();
}

// ← GANTI BARIS INI:
// main().catch(e=>{ ... });

// MENJADI INI (Wrapper dengan Timer + Error Handling):
(async () => {
  try {
    await scheduleMint(async () => {
      await main();
    });
  } catch (e) {
    console.error("\n❌ Fatal:", e?.shortMessage || e?.message || e);
    if (e?.reason) console.error("reason:", e.reason);
    if (e?.data)   console.error("data:", e.data);
    rl.close();
    process.exit(1);
  }
})();

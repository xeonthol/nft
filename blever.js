#!/usr/bin/env node
/**
 * Web Mint (API-driven) for Blever — supports dropId (UUID) or slug
 * Node >= 18 (global fetch) + ESM (package.json: { "type": "module" })
 * deps: ethers@6, dotenv
 */

import { ethers } from "ethers";
import dotenv from "dotenv";
import { scheduleMint } from './timer.js';  // ← TAMBAHAN: Import timer
dotenv.config({ override: true });


const RPC_URL    = must(process.env.RPC_URL, "RPC_URL");
const PRIVATE_KEY = must(process.env.PRIVATE_KEY, "PRIVATE_KEY");
const DROP_SLUG  = (process.env.DROP_ID || "pow-on-ape").trim();
const DROP_UUID  = (process.env.DROP_UUID || "").trim();
const QTY        = Number(process.env.QTY || "1");
const TO         = (process.env.TO || "").trim();

function must(v, name){ if(!v) throw new Error(`Missing ${name} in .env`); return v; }
function env(k){ return (process.env[k]||"").trim(); }

function buildHeaders(){
  const raw = (process.env.HEADERS_JSON || "").trim();
  if (raw){
    const h = JSON.parse(raw);
    console.log("🔧 Using HEADERS_JSON. x-csrf:", String(h["x-csrf-token"]||"").slice(0,6)+"…",
                "| blever:", String(h["Cookie"]||"").includes("blever=Fe26.2*")?"present":"missing");
    return h;
  }
  const x = env("BLEVER_XCSRF");
  const s = env("BLEVER_CSRF_SECRET") || env("BLEVER_CSRF");
  const b = env("BLEVER_COOKIE_BLEVER") || env("BLEVER_COOKIE");
  if (!x || !s || !b) throw new Error("Missing BLEVER_XCSRF / BLEVER_CSRF_SECRET / BLEVER_COOKIE_BLEVER in .env (atau set HEADERS_JSON)");
  console.log("🔧 Using BLEVER_* vars. xcs:", x.slice(0,6)+"…", "| blever:", b.startsWith("Fe26.2*")?"ok":"BAD");
  return {
    "content-type":"application/json",
    "x-csrf-token": x,
    "cookie": `_csrfSecret=${s}; blever=${b}`,
    "origin":"https://app.blever.xyz",
    "referer": `https://app.blever.xyz/drops/${DROP_SLUG}`,
    "user-agent":"Mozilla/5.0",
    "accept":"*/*",
  };
}

function buildPayload(addr, qty, to){
  // Wajib: quantity (number). Bonus: amount (string) utk kompatibilitas lama.
  const base = { to: to || addr, quantity: Number(qty), amount: String(qty) };
  const json = DROP_UUID ? { ...base, dropId: DROP_UUID } : { ...base, slug: DROP_SLUG };
  return { "0": { json } };
}

async function fetchMintQuote(addr, qty, to){
  const res = await fetch("https://app.blever.xyz/api/trpc/drops.mint?batch=1", {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(buildPayload(addr, qty, to)),
  });
  const text = await res.text();
  if(!res.ok){
    console.error("❌ API error", res.status, res.statusText, "-", text.slice(0,200));
    if(res.status===400 && /dropId/.test(text) && !DROP_UUID) console.error("Hint: endpoint butuh dropId → set DROP_UUID=<uuid> di .env.");
    if(res.status===401) console.error("Hint: cookie 'blever' invalid/expired → copy ulang dari Request Headers (POST drops.mint).");
    if(res.status===403) console.error("Hint: x-csrf-token ≠ _csrfSecret → ambil ulang keduanya dari request yang sama.");
    throw new Error(`Blever API ${res.status} ${res.statusText}`);
  }
  let json; try{ json = JSON.parse(text); }catch{ throw new Error(`Non-JSON response from API: ${text.slice(0,120)}`); }
  const j0 = json?.[0]?.result?.data?.json;
  if(!j0?.address || !j0?.args || !j0?.signature || j0.value==null){
    throw new Error(`Unexpected response shape: ${JSON.stringify(json).slice(0,200)}...`);
  }
  return j0; // { chainId, address, args[], signature, value }
}

const ABI_NO_FEE = [
  "function mint(address _to,uint256 _amount,bytes32 _phaseID,uint256 _price,uint256 _maxPerTx,uint256 _maxPerUser,uint256 _maxPerPhase,bytes32 _nonce,bytes _signature) payable"
];
const ABI_WITH_FEE = [
  "function mint(address _to,uint256 _amount,bytes32 _phaseID,uint256 _price,uint256 _mintFee,uint256 _maxPerTx,uint256 _maxPerUser,uint256 _maxPerPhase,bytes32 _nonce,bytes _signature) payable"
];

async function sendTx(provider, wallet, quote){
  const contractAddr = quote.address;
  const args = quote.args; // [to, amount, phaseId, price, (mintFee?), maxPerTx, maxPerUser, maxPerPhase, nonce]
  const value = BigInt(quote.value ?? "0");

  const modes = [
    ["WITH_FEE", ABI_WITH_FEE, () => [args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7], args[8], quote.signature]],
    ["NO_FEE",   ABI_NO_FEE,   () => [args[0], args[1], args[2], args[3],        args[5], args[6], args[7], args[8], quote.signature]],
  ];

  for(const [name, abi, buildArgs] of modes){
    try{
      const ro = new ethers.Contract(contractAddr, abi, provider);
      const w  = new ethers.Contract(contractAddr, abi, wallet);
      const callArgs = buildArgs();
      const ov = { value };

      await ro.mint.staticCall(...callArgs, ov);
      let gas = await w.mint.estimateGas(...callArgs, ov); gas = (gas * 12n) / 10n; // +20%
      const tx = await w.mint(...callArgs, { ...ov, gasLimit: gas });
      console.log(`➡️  ABI mode: ${name}`);
      console.log("⏳ TX:", tx.hash);
      const rc = await tx.wait();
      console.log("🎉 Mint sukses →", rc?.hash ?? tx.hash);
      return;
    }catch(e){
      if(name === "NO_FEE") throw e; // sudah dicoba semua
    }
  }
}

async function main(){
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const to = TO || wallet.address;

  console.log("👛 Wallet:", wallet.address);
  console.log(`➡️  Fetching server signature for ${DROP_UUID?`dropId=${DROP_UUID}`:`slug=${DROP_SLUG}`}, amount=${QTY}, to=${to}`);

  const quote = await fetchMintQuote(wallet.address, QTY, to);
  console.log("✅ chainId:", quote.chainId, "| contract:", quote.address);
  console.log("✅ signature:", quote.signature.slice(0, 18) + "…");

  await sendTx(provider, wallet, quote);
}

// ← GANTI BARIS INI:
// main().catch((e)=>{ ... });

// MENJADI INI (Wrapper dengan Timer + Error Handling):
(async () => {
  try {
    await scheduleMint(async () => {
      await main();
    });
  } catch (e) {
    console.error("❌ Fatal:", e?.message || e);
    if(String(e).includes("invalid csrf")){
      console.error("Tip: perbarui BLEVER_XCSRF + cookie (_csrfSecret; blever) dari POST drops.mint terbaru.");
    }
    if(String(e).includes("Wrong mac prefix")){
      console.error("Tip: cookie 'blever' invalid/kadaluarsa. Copy ulang dari Request Headers (harus mulai 'Fe26.2*…').");
    }
    process.exit(1);
  }
})();

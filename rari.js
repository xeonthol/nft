// rari-mint-openedition.js — Rarible OpenEdition claim only (exact signature)
import { ethers, isAddress, ZeroAddress } from "ethers";
import dotenv from "dotenv";
dotenv.config({ override: true });

// ===== ENV =====
function req(n){ const v = process.env[n]?.trim(); if(!v) throw new Error(`ENV ${n} wajib diisi`); return v; }
function opt(n, d=""){ const v = process.env[n]; return v===undefined ? d : v.trim(); }

const RPC_URL          = req("RPC_URL");
const PRIVATE_KEY      = req("PRIVATE_KEY");
// PANGGIL KE PROXY (yang “Interacted with contract”): 0x3785F8... (The Climb)
const CONTRACT_ADDRESS = req("CONTRACT_ADDRESS");

const QTY              = BigInt(opt("QTY","1"));
const PAYMENT_TOKEN    = opt("PAYMENT_TOKEN","0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"); // native default
let   MINT_PRICE_ETH   = opt("MINT_PRICE_ETH","0"); // kalau 0 → skrip coba probe harga kandidat

// Allowlist tuple (bytes32[], uint256, uint256, address)
// Default OpenEdition public: [], 0, MAX_UINT256, 0x0
let PROOF = [];
try { PROOF = JSON.parse(process.env.PROOF ?? "[]"); if(!Array.isArray(PROOF)) PROOF = []; } catch {}
const AL_U256_A = opt("AL_U256_A","0");           // mis. 0 (OE public) atau phaseId (30) untuk drop tertentu
const AL_U256_B = opt("AL_U256_B","MAX");         // "MAX" | "UNIT_PRICE" | angka u256 (desimal)
const AL_ADDR   = opt("AL_ADDR","ZERO");          // "ZERO" | "PAYMENT_TOKEN" | alamat 0x...

// Retry/Jeda
const RETRIES    = Number(opt("RETRIES","100"));
const DELAY_SEC  = Number(opt("DELAY_SEC","0.4"));
const JITTER_SEC = Number(opt("JITTER_SEC","0.2"));

// Gas (opsional)
const GAS_PRICE_GWEI        = opt("GAS_PRICE_GWEI","");
const MAX_FEE_PER_GAS_GWEI  = opt("MAX_FEE_PER_GAS_GWEI","");
const MAX_PRIORITY_FEE_GWEI = opt("MAX_PRIORITY_FEE_GWEI","");

// Harga kandidat jika MINT_PRICE_ETH=0 (probe)
const PRICE_GUESS_LIST = (process.env.PRICE_GUESS_LIST || "0,0.0001,0.001,0.01,0.1,1,2.815").split(",").map(s=>s.trim()).filter(Boolean);

// ===== Setup =====
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
if (!isAddress(CONTRACT_ADDRESS)) throw new Error(`CONTRACT_ADDRESS bukan 0x valid: ${CONTRACT_ADDRESS}`);

const abiExact = [
  // persis seperti decode kamu (method id 0x84bb1e42)
  "function claim(address _receiver, uint256 _quantity, address _currency, uint256 _pricePerToken, (bytes32[] _proof,uint256 _u256a,uint256 _u256b,address _addr) _allowlistProof, bytes _data) payable"
];

const MAX_UINT256 = (1n << 256n) - 1n;

function gasOv(){
  if (GAS_PRICE_GWEI) return { gasPrice: ethers.parseUnits(GAS_PRICE_GWEI, "gwei") };
  const o = {};
  if (MAX_FEE_PER_GAS_GWEI)  o.maxFeePerGas        = ethers.parseUnits(MAX_FEE_PER_GAS_GWEI,  "gwei");
  if (MAX_PRIORITY_FEE_GWEI) o.maxPriorityFeePerGas = ethers.parseUnits(MAX_PRIORITY_FEE_GWEI, "gwei");
  return o;
}
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
function logErr(e){ const m = e?.shortMessage ?? e?.info ?? e?.message ?? String(e); console.error("❌", m); if(e?.reason) console.error("reason:", e.reason); if(e?.data) console.error("data:", e.data); }

function isNative(){ return PAYMENT_TOKEN.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"; }

function buildAllowlistTuple(unitWei){
  const u256a = AL_U256_A.toUpperCase?.() === "UNIT_PRICE" ? unitWei : BigInt(AL_U256_A || "0");
  let u256b;
  if (AL_U256_B.toUpperCase?.() === "MAX") u256b = MAX_UINT256;
  else if (AL_U256_B.toUpperCase?.() === "UNIT_PRICE") u256b = unitWei;
  else u256b = BigInt(AL_U256_B || "0");

  let addr = ZeroAddress;
  if (AL_ADDR.toUpperCase?.() === "PAYMENT_TOKEN") addr = PAYMENT_TOKEN;
  else if (AL_ADDR.toUpperCase?.() === "ZERO") addr = ZeroAddress;
  else addr = AL_ADDR;

  return [ PROOF, u256a, u256b, addr ];
}

async function probePrice(drop){
  // jika user sudah isi > 0, pakai itu
  if (MINT_PRICE_ETH && Number(MINT_PRICE_ETH) > 0) {
    try {
      const p = ethers.parseEther(MINT_PRICE_ETH);
      const val = isNative() ? p * QTY : 0n;
      const terms = buildAllowlistTuple(p);
      await drop.claim.staticCall(wallet.address, QTY, PAYMENT_TOKEN, p, terms, "0x", { value: val, ...gasOv() });
      return p;
    } catch {
      // lanjut ke guessing
    }
  }
  // coba kandidat
  for (const s of PRICE_GUESS_LIST) {
    try {
      const p = ethers.parseEther(s);
      const val = isNative() ? p * QTY : 0n;
      const terms = buildAllowlistTuple(p);
      await drop.claim.staticCall(wallet.address, QTY, PAYMENT_TOKEN, p, terms, "0x", { value: val, ...gasOv() });
      console.log(`🔎 Ketemu price cocok via probe: ${s}`);
      return p;
    } catch {}
  }
  return null;
}

async function main(){
  const [net, bal, code] = await Promise.all([
    provider.getNetwork(),
    provider.getBalance(wallet.address),
    provider.getCode(CONTRACT_ADDRESS),
  ]);
  console.log("🔌 RPC:", RPC_URL);
  console.log("🌐 chainId:", Number(net.chainId));
  console.log("👛 Wallet:", wallet.address, "balance:", ethers.formatEther(bal));
  if (!code || code === "0x") throw new Error("CONTRACT_ADDRESS bukan kontrak (getCode kosong).");
  if (QTY <= 0n) throw new Error("QTY harus > 0");

  const drop = new ethers.Contract(CONTRACT_ADDRESS, abiExact, wallet);

  // 1) Tentukan price (langsung atau probe)
  let unit = await probePrice(drop);
  if (!unit) throw new Error("Gagal menentukan harga (set MINT_PRICE_ETH atau atur AL_* sesuai kontrak).");
  const value = isNative() ? unit * QTY : 0n;

  console.log("💵 unitPrice:", ethers.formatEther(unit), "| qty:", QTY.toString(), "| total:", ethers.formatEther(value));

  // 2) Kirim tx dengan retry
  const terms = buildAllowlistTuple(unit);
  for (let i=1;i<=RETRIES;i++){
    console.log(`🔁 attempt ${i}/${RETRIES}`);
    try{
      const gas = await drop.claim.estimateGas(wallet.address, QTY, PAYMENT_TOKEN, unit, terms, "0x", { value, ...gasOv() });
      const tx  = await drop.claim(wallet.address, QTY, PAYMENT_TOKEN, unit, terms, "0x", { value, gasLimit: gas, ...gasOv() });
      console.log("⏳ TX:", tx.hash);
      const rc  = await tx.wait();
      console.log("🎉 Sukses →", rc.transactionHash);
      return;
    }catch(e){
      logErr(e);
      if (i < RETRIES){
        const ms = DELAY_SEC*1000 + Math.random()*(JITTER_SEC*1000);
        console.log(`⏳ tunggu ${(ms/1000).toFixed(2)}s…`); await sleep(ms);
      }
    }
  }
  throw new Error("Gagal mint setelah semua percobaan.");
}

main().catch(e=>{ logErr(e); process.exit(1); });

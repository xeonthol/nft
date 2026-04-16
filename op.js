// mint-seadrop-loop.js — ethers v6
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`ENV ${name} belum di-set`);
  return v;
}

// Wajib dari .env
const RPC_URL = req("RPC_URL");                  
const PRIVATE_KEY = req("PRIVATE_KEY");
const NFT_ADDRESS = req("CONTRACT_ADDRESS");
const SEA_ADDRESS = req("SEA_ADDRESS");
const FEE_RECIPIENT = req("FEE_RECIPIENT");
const QTY = BigInt(process.env.QTY ?? "1");
const RETRIES = parseInt(process.env.RETRIES ?? "100", 10);
const DELAY_SEC = parseFloat(process.env.DELAY_SEC ?? "1");
const JITTER_SEC = parseFloat(process.env.JITTER_SEC ?? "0");

// ABI minimal SeaDrop
const seaAbi = [
  "function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity) payable",
  "function getPublicDrop(address nft) view returns (uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 maxTotalMintableByWallet,uint16 feeBps,bool restrictFeeRecipients)",
  "function publicDrop(address nft) view returns (uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 feeBps,bool restrictFeeRecipients)"
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const sea = new ethers.Contract(SEA_ADDRESS, seaAbi, wallet);

function ifaceHas(contract, sig) {
  try { contract.interface.getFunction(sig); return true; } catch { return false; }
}

async function readMintPrice(nftAddr) {
  for (const fn of ["getPublicDrop", "publicDrop"]) {
    if (!ifaceHas(sea, `${fn}(address)`)) continue;
    try {
      const res = await sea[fn](nftAddr);
      return BigInt(res.mintPrice ?? res[0] ?? 0n);
    } catch {}
  }
  return null;
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log("🔌 RPC:", RPC_URL);
  const net = await provider.getNetwork();
  console.log("🌐 chainId:", Number(net.chainId));
  console.log("📦 NFT address:", NFT_ADDRESS);
  console.log("🌊 SeaDrop address:", SEA_ADDRESS);
  console.log("🎯 Fee recipient:", FEE_RECIPIENT);

  // Pastikan NFT ada
  const code = await provider.getCode(NFT_ADDRESS);
  if (!code || code === "0x") throw new Error("NFT tidak ada di chain ini");

  // Tentukan harga
  let unitPrice = await readMintPrice(NFT_ADDRESS);
  if (unitPrice == null) {
    unitPrice = process.env.MINT_PRICE_WEI
      ? BigInt(process.env.MINT_PRICE_WEI)
      : ethers.parseEther(process.env.MINT_PRICE_ETH || "0.003");
  }
  const value = unitPrice * QTY;

  console.log("💵 unitPrice:", ethers.formatEther(unitPrice), "ETH");
  console.log("🧮 qty:", QTY.toString(), "→ total value:", ethers.formatEther(value));

  for (let i = 1; i <= RETRIES; i++) {
    console.log(`\n🔁 Percobaan ${i}/${RETRIES}`);
    try {
      // Coba staticCall dulu (kalau belum live, biasanya revert di sini)
      await sea.mintPublic.staticCall(NFT_ADDRESS, FEE_RECIPIENT, wallet.address, QTY, { value });
      console.log("✅ staticCall OK → mengirim tx...");

      const gas = await sea.mintPublic.estimateGas(NFT_ADDRESS, FEE_RECIPIENT, wallet.address, QTY, { value });
      const tx = await sea.mintPublic(NFT_ADDRESS, FEE_RECIPIENT, wallet.address, QTY, { value, gasLimit: gas });
      console.log("⏳ TX:", tx.hash);
      const rc = await tx.wait();
      console.log("🎉 Mint sukses! hash:", rc.transactionHash);
      break; // keluar loop kalau berhasil
    } catch (err) {
      console.error("❌ Gagal:", err.shortMessage || err.message || err);
      if (i < RETRIES) {
        const jitter = Math.random() * (JITTER_SEC * 1000);
        const ms = DELAY_SEC * 1000 + jitter;
        console.log(`⏳ Tunggu ${(ms / 1000).toFixed(2)} detik sebelum retry...`);
        await delay(ms);
      } else {
        console.log("⚠️ Batas percobaan tercapai, berhenti.");
      }
    }
  }
}

main().catch((e) => console.error("❌ Fatal:", e));

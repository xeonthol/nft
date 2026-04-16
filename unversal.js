// mint-universal.js — ethers v6
import { ethers, isAddress, ZeroAddress } from "ethers";
import dotenv from "dotenv";
dotenv.config({ override: true });

// ===== Helpers ENV =====
function req(name) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`ENV ${name} wajib diisi`);
  return v;
}
function opt(name, def) {
  const v = process.env[name];
  return v === undefined ? def : v.trim();
}
function ensureHexAddress(label, addr) {
  if (!isAddress(addr) || addr === ZeroAddress) {
    throw new Error(`${label} harus alamat 0x valid (bukan ENS/placeholder): ${addr}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function printErr(e) {
  const msg = e?.shortMessage ?? e?.info ?? e?.message ?? String(e);
  const code = e?.code ? ` code=${e.code}` : "";
  console.error(`❌ ${msg}${code}`);
  if (e?.reason) console.error("reason:", e.reason);
  if (e?.data) console.error("data:", e.data);
  if (e?.transaction) console.error("tx:", e.transaction);
}

// ===== ENV =====
const RPC_URL = req("RPC_URL");
const PRIVATE_KEY = req("PRIVATE_KEY");
const CONTRACT_ADDRESS = req("CONTRACT_ADDRESS"); // = NFT address
const SEA_ADDRESS = opt("SEA_ADDRESS", "");        // kalau kosong → non-SeaDrop
const FEE_RECIPIENT = opt("FEE_RECIPIENT", "");    // wajib kalau drop restrict

const QTY = BigInt(opt("QTY", "1"));
const RETRIES = Number(opt("RETRIES", "100"));
const DELAY_SEC = Number(opt("DELAY_SEC", "1"));
const JITTER_SEC = Number(opt("JITTER_SEC", "0.2"));

// Harga: boleh pakai salah satu
const MINT_PRICE_WEI = opt("MINT_PRICE_WEI", "");
const MINT_PRICE_ETH = opt("MINT_PRICE_ETH", ""); // mis. "0" atau "0.001"
const MAX_PRICE_WEI = opt("MAX_PRICE_WEI", "");
const MAX_PRICE_ETH = opt("MAX_PRICE_ETH", "");

// Gas override opsional
const MAX_FEE_PER_GAS_GWEI = opt("MAX_FEE_PER_GAS_GWEI", "");
const MAX_PRIORITY_FEE_GWEI = opt("MAX_PRIORITY_FEE_GWEI", "");
const GAS_PRICE_GWEI = opt("GAS_PRICE_GWEI", ""); // legacy

// ===== Setup =====
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
ensureHexAddress("CONTRACT_ADDRESS", CONTRACT_ADDRESS);
ensureHexAddress("Wallet Address", wallet.address);

// ===== Utils =====
function parseWeiLike(label, weiStr, ethStr) {
  if (weiStr) {
    if (!/^\d+$/.test(weiStr)) throw new Error(`${label} (WEI) harus integer: ${weiStr}`);
    return BigInt(weiStr);
  }
  if (ethStr !== "") {
    try { return ethers.parseEther(ethStr); }
    catch { throw new Error(`${label} (ETH) tidak valid: "${ethStr}"`); }
  }
  return null;
}
function gasOverridesBase() {
  const o = {};
  if (GAS_PRICE_GWEI) {
    o.gasPrice = ethers.parseUnits(GAS_PRICE_GWEI, "gwei");
    return o;
  }
  if (MAX_FEE_PER_GAS_GWEI) o.maxFeePerGas = ethers.parseUnits(MAX_FEE_PER_GAS_GWEI, "gwei");
  if (MAX_PRIORITY_FEE_GWEI) o.maxPriorityFeePerGas = ethers.parseUnits(MAX_PRIORITY_FEE_GWEI, "gwei");
  return o;
}
function withValueOverrides(value) {
  return { value, ...gasOverridesBase() };
}

// ===== SeaDrop bits =====
const seaAbi = [
  "function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity) payable",
  "function getPublicDrop(address nft) view returns (uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 maxTotalMintableByWallet,uint16 feeBps,bool restrictFeeRecipients)",
  "function publicDrop(address nft) view returns (uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 feeBps,bool restrictFeeRecipients)"
];
const seaROAbi = [
  ...seaAbi,
  "function getPublicDrop(address nft) view returns (uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 maxTotalMintableByWallet,uint16 feeBps,bool restrictFeeRecipients)"
];

async function readDrop(seaAddr, nftAddr) {
  const seaRO = new ethers.Contract(seaAddr, seaROAbi, provider);
  try {
    const d = await seaRO.getPublicDrop(nftAddr);
    return {
      mintPrice: BigInt(d.mintPrice ?? d[0] ?? 0n),
      startTime: Number(d.startTime ?? d[1] ?? 0),
      endTime:   Number(d.endTime ?? d[2] ?? 0),
      feeBps:    Number(d.feeBps ?? d[4] ?? 0),
      restrict:  Boolean(d.restrictFeeRecipients ?? d[5] ?? false)
    };
  } catch {
    try {
      const p = await seaRO.publicDrop(nftAddr);
      return {
        mintPrice: BigInt(p.mintPrice ?? p[0] ?? 0n),
        startTime: 0, endTime: 0,
        feeBps: Number(p.feeBps ?? p[3] ?? 0),
        restrict: Boolean(p.restrictFeeRecipients ?? p[4] ?? false)
      };
    } catch { return null; }
  }
}

async function seaDropMint() {
  ensureHexAddress("SEA_ADDRESS", SEA_ADDRESS);
  if (FEE_RECIPIENT) ensureHexAddress("FEE_RECIPIENT", FEE_RECIPIENT);

  const sea = new ethers.Contract(SEA_ADDRESS, seaAbi, wallet);

  // Harga
  let unitPrice = parseWeiLike("MINT_PRICE", MINT_PRICE_WEI, MINT_PRICE_ETH);
  const drop = await readDrop(SEA_ADDRESS, CONTRACT_ADDRESS);
  if (drop?.mintPrice != null && (unitPrice == null || unitPrice < drop.mintPrice)) {
    unitPrice = drop.mintPrice; // pakai harga onchain kalau tersedia dan lebih tinggi
  }
  if (unitPrice == null) unitPrice = 0n;

  // Limit harga
  const maxPrice = parseWeiLike("MAX_PRICE", MAX_PRICE_WEI, MAX_PRICE_ETH);
  if (maxPrice != null && unitPrice > maxPrice) {
    throw new Error(`Mint price ${ethers.formatEther(unitPrice)} ETH > MAX_PRICE`);
  }

  // Window waktu mint
  if (drop) {
    const now = Math.floor(Date.now() / 1000);
    if (drop.startTime && now < drop.startTime) {
      const waitMs = (drop.startTime - now) * 1000 + Math.random() * 800;
      console.log(`⏳ Belum mulai. Tunggu ${(waitMs/1000).toFixed(1)}s sampai startTime…`);
      await sleep(waitMs);
    }
    if (drop.endTime && now > drop.endTime) {
      throw new Error("Mint sudah berakhir (endTime lewat).");
    }
    if (drop.restrict && !FEE_RECIPIENT) {
      throw new Error("Drop restrictFeeRecipients=TRUE. Set FEE_RECIPIENT yang diallow.");
    }
  }

  const value = unitPrice * QTY;
  console.log("💵 unitPrice:", ethers.formatEther(unitPrice), "ETH");
  console.log("🧮 qty:", QTY.toString(), "→ total value:", ethers.formatEther(value));

  // Loop
  for (let i = 1; i <= RETRIES; i++) {
    console.log(`\n🔁 SeaDrop attempt ${i}/${RETRIES}`);
    try {
      // simulasi (static)
      await sea.mintPublic.staticCall(CONTRACT_ADDRESS, FEE_RECIPIENT || ZeroAddress, wallet.address, QTY, withValueOverrides(value));
      console.log("✅ staticCall OK → kirim tx…");

      const gas = await sea.mintPublic.estimateGas(CONTRACT_ADDRESS, FEE_RECIPIENT || ZeroAddress, wallet.address, QTY, withValueOverrides(value));
      const tx = await sea.mintPublic(CONTRACT_ADDRESS, FEE_RECIPIENT || ZeroAddress, wallet.address, QTY, { ...withValueOverrides(value), gasLimit: gas });
      console.log("⏳ TX:", tx.hash);
      const rc = await tx.wait();
      console.log("🎉 Mint sukses! hash:", rc.transactionHash);
      return;
    } catch (e) {
      printErr(e);
      if (i < RETRIES) {
        const jitter = Math.random() * (JITTER_SEC * 1000);
        const ms = DELAY_SEC * 1000 + jitter;
        console.log(`⏳ Tunggu ${(ms/1000).toFixed(2)}s sebelum retry…`);
        await sleep(ms);
      }
    }
  }
  throw new Error(`Gagal mint setelah ${RETRIES} percobaan (SeaDrop).`);
}

// ===== Direct NFT mint (non-SeaDrop) =====
// ABI minimal: mintPublic(address to, uint256 tokenId, uint256 qty, bytes data)
const directAbi = [
  "function mintPublic(address to, uint256 tokenId, uint256 qty, bytes data) external payable"
];

async function directMint() {
  const contract = new ethers.Contract(CONTRACT_ADDRESS, directAbi, wallet);

  // Harga
  let unitPrice = parseWeiLike("MINT_PRICE", MINT_PRICE_WEI, MINT_PRICE_ETH);
  if (unitPrice == null) unitPrice = 0n;

  const maxPrice = parseWeiLike("MAX_PRICE", MAX_PRICE_WEI, MAX_PRICE_ETH);
  if (maxPrice != null && unitPrice > maxPrice) {
    throw new Error(`Mint price ${ethers.formatEther(unitPrice)} ETH > MAX_PRICE`);
  }

  const value = unitPrice * QTY;

  // Dry run (provider.call) ala script #2
  const iface = new ethers.Interface(directAbi);
  const calldata = iface.encodeFunctionData("mintPublic", [wallet.address, 0, Number(QTY), "0x"]);
  try {
    await provider.call({ to: CONTRACT_ADDRESS, from: wallet.address, data: calldata, value });
    console.log("✅ Simulasi OK (tidak revert). Lanjut kirim tx…");
  } catch (e) {
    console.error("🧪 Simulasi REVERT. Cek param/aturan mint:");
    printErr(e);
    // Uncomment kalau mau stop total saat pasti gagal:
    // process.exit(1);
  }

  for (let i = 1; i <= RETRIES; i++) {
    console.log(`🚀 Direct mint attempt ${i}/${RETRIES}`);
    try {
      const tx = await contract.mintPublic(wallet.address, 0, Number(QTY), "0x", withValueOverrides(value));
      console.log("⏳ Minting... TX:", tx.hash);
      const receipt = await tx.wait();
      console.log("✅ Mint sukses!", receipt.transactionHash);
      return;
    } catch (e) {
      printErr(e);
      if (i < RETRIES) {
        const jitter = Math.floor(Math.random() * (JITTER_SEC * 1000));
        const waitMs = Math.max(0, DELAY_SEC * 1000 + jitter);
        await sleep(waitMs);
      }
    }
  }
  throw new Error(`Gagal mint setelah ${RETRIES} percobaan (Direct).`);
}

// ===== Main =====
async function main() {
  // Info jaringan + sanity checks
  const [net, bal, code] = await Promise.all([
    provider.getNetwork(),
    provider.getBalance(wallet.address),
    provider.getCode(CONTRACT_ADDRESS),
  ]);
  console.log("🔌 RPC:", RPC_URL);
  console.log("🌐 chainId:", Number(net.chainId), "name:", net.name);
  console.log("👛 Wallet:", wallet.address, "balance:", ethers.formatEther(bal), "ETH");
  if (!code || code === "0x") throw new Error("Kontrak NFT tidak ada di chain ini (getCode kosong).");

  if (QTY <= 0n) throw new Error(`QTY harus > 0. Dapat: ${QTY.toString()}`);

  if (SEA_ADDRESS) {
    await seaDropMint();
  } else {
    await directMint();
  }
}

main().catch((e) => { printErr(e); process.exit(1); });

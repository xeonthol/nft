// me.js
import { ethers, isAddress, ZeroAddress } from "ethers";
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

// Opsional (pakai default bila kosong)
const QTY = Number((process.env.QTY ?? "1").trim());
const MINT_PRICE_ETH = (process.env.MINT_PRICE_ETH ?? "0").trim();
const RETRIES = Number((process.env.RETRIES ?? "100").trim());
const DELAY_SEC = Number((process.env.DELAY_SEC ?? "1").trim());
const JITTER_SEC = Number((process.env.JITTER_SEC ?? "0.2").trim());
// Optional manual gas price override (gwei). Kosongkan kalau mau auto.
const GAS_PRICE_GWEI = process.env.GAS_PRICE_GWEI?.trim();

// ===== Setup =====
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

function ensureHexAddress(label, addr) {
  if (!isAddress(addr) || addr === ZeroAddress) {
    throw new Error(`${label} harus alamat 0x valid (bukan ENS/placeholder): ${addr}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gasOverrides() {
  if (GAS_PRICE_GWEI && !Number.isNaN(Number(GAS_PRICE_GWEI))) {
    // Force legacy gasPrice ketika user set manual
    const gasPrice = ethers.parseUnits(GAS_PRICE_GWEI, "gwei");
    return { gasPrice };
  }
  // Auto detect
  const fee = await provider.getFeeData();
  if (fee.maxFeePerGas && fee.maxPriorityFeePerGas) {
    return {
      maxFeePerGas: fee.maxFeePerGas,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
    };
  }
  if (fee.gasPrice) {
    return { gasPrice: fee.gasPrice };
  }
  return {}; // fallback: biar ethers isi default
}

function printErr(e) {
  const msg = e?.shortMessage ?? e?.info ?? e?.message ?? String(e);
  const code = e?.code ? ` code=${e.code}` : "";
  console.error(`❌ ${msg}${code}`);
  if (e?.reason) console.error("reason:", e.reason);
  if (e?.data) console.error("data:", e.data);
  if (e?.transaction) console.error("tx:", e.transaction);
}

async function main() {
  // Validasi dasar
  ensureHexAddress("CONTRACT_ADDRESS", CONTRACT_ADDRESS);
  ensureHexAddress("Wallet Address", wallet.address);
  if (!Number.isInteger(QTY) || QTY <= 0) {
    throw new Error(`QTY harus bilangan bulat > 0. Dapat: ${QTY}`);
  }

  // Info network + saldo
  const net = await provider.getNetwork();
  const bal = await provider.getBalance(wallet.address);
  console.log("🔌 Network", { chainId: Number(net.chainId), name: net.name });
  console.log("👛 Wallet", { address: wallet.address, balanceEth: ethers.formatEther(bal) });

  // Siapkan kontrak & nilai
  const abi = [
    "function mintPublic(address to, uint256 tokenId, uint256 qty, bytes data) external payable"
  ];
  const contract = new ethers.Contract(CONTRACT_ADDRESS, abi, wallet);

  let value;
  try {
    value = ethers.parseEther(MINT_PRICE_ETH);
  } catch {
    throw new Error(`MINT_PRICE_ETH tidak valid: "${MINT_PRICE_ETH}" (contoh: 0, 0.001, 1)`);
  }

  // ===== Simulasi (dry-run) sebelum kirim tx =====
  const iface = new ethers.Interface(abi);
  const calldata = iface.encodeFunctionData("mintPublic", [wallet.address, 0, QTY, "0x"]);
  try {
    await provider.call({
      to: CONTRACT_ADDRESS,
      from: wallet.address,
      data: calldata,
      value,
    });
    console.log("✅ Simulasi OK (tidak revert). Lanjut kirim tx…");
  } catch (e) {
    console.error("🧪 Simulasi REVERT. Periksa param/aturan mint:");
    printErr(e);
    // Optional: stop di sini biar gak buang gas jika pasti gagal
    // process.exit(1);
  }

  // ===== Loop kirim tx dengan retry/backoff =====
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    console.log(`🚀 Mint attempt ${attempt}/${RETRIES}`);
    try {
      const feeOv = await gasOverrides();
      const overrides = { value, ...feeOv };

      const tx = await contract.mintPublic(wallet.address, 0, QTY, "0x", overrides);
      console.log("⏳ Minting... TX:", tx.hash);

      const receipt = await tx.wait();
      console.log("✅ Mint sukses!", receipt.transactionHash);
      return;
    } catch (e) {
      printErr(e);

      // Hint cepat
      const m = (e?.shortMessage ?? e?.message ?? "").toUpperCase();
      if (m.includes("INSUFFICIENT_FUNDS")) {
        console.error("💡 Isi saldo native untuk gas.");
      } else if (m.includes("UNPREDICTABLE_GAS_LIMIT")) {
        console.error("💡 Cek ABI/param, status mint (paused/allowlist), atau kebutuhan value > 0.");
      } else if (m.includes("DOES NOT SUPPORT ENS")) {
        console.error("💡 Pastikan semua alamat 0x… (bukan .eth).");
      } else if (m.includes("NONCE_EXPIRED") || m.includes("REPLACEMENT_UNDERPRICED")) {
        console.error("💡 Coba naikkan gas (set GAS_PRICE_GWEI) atau sinkronkan nonce.");
      }

      if (attempt === RETRIES) break;

      const jitterMs = Math.floor(Math.random() * (JITTER_SEC * 1000));
      const waitMs = Math.max(0, DELAY_SEC * 1000 + jitterMs);
      await sleep(waitMs);
    }
  }

  throw new Error(`Gagal mint setelah ${RETRIES} percobaan.`);
}

main().catch((e) => {
  printErr(e);
  process.exit(1);
});

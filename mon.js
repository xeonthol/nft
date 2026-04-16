import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const CONTRACT_ADDRESS = "CONTRACT_ADDRESS";
const abi = [
  "function mintPublic(address to, uint256 tokenId, uint256 qty, bytes data) external payable"
];

const contract = new ethers.Contract(CONTRACT_ADDRESS, abi, wallet);

async function mint() {
  try {
    const recipient = wallet.address; 
    const tx = await contract.mintPublic(
      recipient,     
      0,             
      1,             // jumlah mint
      "0x",         
      { value: ethers.parseEther("0") } // PRICE mint, 0,0.1 FREE =0
    );

    console.log("⏳ Minting... TX Hash:", tx.hash);
    const receipt = await tx.wait();
    console.log("✅ Mint sukses!", receipt.transactionHash);
  } catch (err) {
    console.error("❌ Mint gagal:", err);
  }
}

mint();

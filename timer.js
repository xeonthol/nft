// timer.js
import dotenv from "dotenv";
dotenv.config();

export async function scheduleMint(mintFn) {
  // Kalau timer mati atau MINT_TIME kosong, langsung run
  if (process.env.SCHEDULED_MINT !== 'true' || !process.env.MINT_TIME) {
    return await mintFn();
  }

  const target = new Date(process.env.MINT_TIME).getTime();
  const delay = target - Date.now();
  const tz = process.env.TIMEZONE || 'Asia/Jakarta';

  const fmt = d => d.toLocaleString('id-ID', { timeZone: tz, hour12: false });

  console.log(`\n🕒 [TIMER] Aktif`);
  console.log(`   🎯 Target: ${fmt(new Date(target))} (${tz})`);
  
  if (delay > 0) {
    const s = Math.floor(delay / 1000);
    console.log(`   ⏳ Tunggu: ${Math.floor(s/3600)}j ${Math.floor((s%3600)/60)}m ${s%60}d\n`);
    
    setTimeout(async () => {
      console.log(`\n🚀 [${new Date().toISOString()}] EXECUTE MINT!`);
      await mintFn();
      process.exit(0);
    }, delay);
  } else {
    console.log(`   ⚠️ Waktu sudah lewat, langsung run...\n`);
    await mintFn();
    process.exit(0);
  }
}

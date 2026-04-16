// timer.js
require('dotenv').config();

/**
 * Schedule fungsi minting di waktu tertentu
 * @param {Function} mintFn - Fungsi async yang berisi logika minting
 * @param {Object} options - Konfigurasi optional
 */
async function scheduleMint(mintFn, options = {}) {
    const {
        enabled = process.env.SCHEDULED_MINT === 'true',
        mintTime = process.env.MINT_TIME,      // e.g. "2026-04-16T19:05:00+07:00"
        timezone = process.env.TIMEZONE || 'Asia/Jakarta',
        onCountdown = true,
        exitAfter = true
    } = options;

    if (!enabled || !mintTime) {
        console.log("⚡ Timer tidak aktif, langsung eksekusi...");
        return await mintFn();
    }

    const targetDate = new Date(mintTime);
    const delay = targetDate.getTime() - Date.now();

    const fmt = (date) => date.toLocaleString('id-ID', { 
        timeZone: timezone, 
        weekday: 'short', 
        year: 'numeric', 
        month: 'short', 
        day: 'numeric', 
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit' 
    });

    console.log(`\n🕒 [SCHEDULER] Aktif`);
    console.log(`   📅 Target: ${fmt(targetDate)} (${timezone})`);
    console.log(`   🌐 UTC: ${targetDate.toISOString()}`);
    
    if (delay > 0) {
        const hrs = Math.floor(delay / 3600000);
        const mins = Math.floor((delay % 3600000) / 60000);
        const secs = Math.floor((delay % 60000) / 1000);
        console.log(`   ⏳ Countdown: ${hrs}j ${mins}m ${secs}d\n`);
        
        if (onCountdown) {
            // Optional: live countdown log tiap 10 detik
            const interval = setInterval(() => {
                const remaining = Math.max(0, new Date(mintTime).getTime() - Date.now());
                if (remaining <= 0) { clearInterval(interval); return; }
                const s = Math.floor(remaining / 1000);
                process.stdout.write(`\r⏱️  Berjalan: ${Math.floor(s/60)}m ${s%60}d tersisa...`);
            }, 10000);
        }

        return new Promise(async (resolve, reject) => {
            setTimeout(async () => {
                try {
                    console.log(`\n\n🚀 [${new Date().toISOString()}] WAKTUNYA MINTING!`);
                    await mintFn();
                    if (exitAfter) {
                        console.log("✅ Selesai. Exiting...");
                        process.exit(0);
                    }
                    resolve();
                } catch (err) {
                    console.error("❌ Error saat minting:", err.message);
                    reject(err);
                }
            }, delay);
        });
    } else {
        console.log("⚠️ Waktu target sudah lewat, langsung eksekusi...\n");
        return await mintFn();
    }
}

module.exports = { scheduleMint };

import { Connection, PublicKey } from "@solana/web3.js";
import "dotenv/config";

/** ===== Config ===== */
const RPC_HTTP = process.env.RPC_HTTP || "https://api.mainnet-beta.solana.com";
const RPC_WSS  = process.env.RPC_WSS  || "wss://api.mainnet-beta.solana.com";
const SEEDS = (process.env.WATCH_ADDRS || process.env.SEED_ADDR || "")
  .split(",").map(s=>s.trim()).filter(Boolean);
if (!SEEDS.length) { console.error("8X7pr6Zk1hX3r4eZ4iGDaohF9ZNpS2tUn8LccG4fSheQ"); process.exit(1); }

const LOOKBACK_MIN   = Number(process.env.LOOKBACK_MIN   || 60);   // rétro (minutes)
const MIN_SOL        = Number(process.env.MIN_SOL        || 0.2);  // seuil transferts SOL
const MIN_SPL_UNITS  = Number(process.env.MIN_SPL_UNITS  || 1e6);  // seuil SPL (unités brutes)
const MAX_DEPTH      = Number(process.env.MAX_DEPTH      || 6);    // profondeur max suivi
const TOP_CHILDREN   = Number(process.env.TOP_CHILDREN   || 3);    // top N receveurs/split
const CEX = new Set((process.env.CEX_HOT_WALLETS || "").split(",").map(x=>x.trim()).filter(Boolean));
const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL
  "TokenzQdBNbLqP5VEh9bSTBz2T9SxH3hszMpyyZHPv9"  // Token-2022
]);

/** ===== Connexions / État ===== */
const connFast = new Connection(RPC_HTTP, { commitment: "processed", wsEndpoint: RPC_WSS });
const connConf = new Connection(RPC_HTTP, { commitment: "confirmed", wsEndpoint: RPC_WSS });

const WATCH = new Map();           // addr -> { depth, subId }
const SEEN  = new Set();           // signatures déjà traitées (anti-doublons)
const isCEX = (a)=>CEX.has(a);
const nowSec = ()=>Math.floor(Date.now()/1000);

const log = (...a)=>console.log(...a);
const info = (...a)=>console.log("[INFO]", ...a);
const warn = (...a)=>console.warn("[WARN]", ...a);
const err  = (...a)=>console.error("[ERR ]", ...a);

/** ===== Core ===== */
function addAddress(addr, depth=0){
  if (!addr || WATCH.has(addr) || depth > MAX_DEPTH) return;
  let pk; try { pk = new PublicKey(addr); } catch { return; }
  const subId = connFast.onLogs(pk, lg => onLogs(addr, depth, lg), "processed");
  WATCH.set(addr, { depth, subId });
  info(`Subscribed: ${addr} (depth ${depth})`);
}

async function onLogs(addr, depth, lg){
  try {
    const sig = lg?.signature;
    if (!sig || SEEN.has(sig)) return;
    await handleSignature(addr, depth, sig);
  } catch (e) { err(e?.message || e); }
}

async function handleSignature(fromAddr, depth, signature){
  SEEN.add(signature);

  const tx = await connConf.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
  if (!tx?.transaction) return;

  // signal InitializeMint (utile pour spot le nouveau token)
  const logs = tx?.meta?.logMessages || [];
  if (logs.some(l => l.includes("Instruction: InitializeMint"))) {
    log(`🚨 InitializeMint | signer≈${fromAddr} | sig=${signature}`);
  }

  // Extraire transferts sortants (SOL + SPL simple)
  const dests = new Map(); // dest -> agg
  const instrs = tx.transaction.message.instructions || [];

  for (const ins of instrs) {
    const program   = ins?.program;
    const programId = ins?.programId?.toString?.() || ins?.programId || "";
    const parsed    = ins?.parsed;

    // SOL
    if (program === "system" && parsed?.type === "transfer") {
      const { source, destination, lamports } = parsed.info || {};
      if (source === fromAddr) {
        const amt = Number(lamports||0)/1e9;
        if (amt >= MIN_SOL && !isCEX(destination))
          dests.set(destination, (dests.get(destination)||0) + amt);
      }
    }

    // SPL (simple)
    const isSpl = (program === "spl-token") || TOKEN_PROGRAMS.has(programId);
    if (isSpl && parsed?.type && (parsed.type === "transfer" || parsed.type === "transferChecked")) {
      const inf = parsed.info || {};
      const owners = [inf.owner, inf.sourceOwner, inf.authority].filter(Boolean);
      if (owners.includes(fromAddr)) {
        const toOwner = inf.destinationOwner || inf.destination || inf.account || null;
        const amt = Number(inf.amount || 0);
        if (toOwner && amt >= MIN_SPL_UNITS && !isCEX(toOwner))
          dests.set(toOwner, (dests.get(toOwner)||0) + amt);
      }
    }
  }

  if (!dests.size) return;

  const top = [...dests.entries()].sort((a,b)=>b[1]-a[1]).slice(0, TOP_CHILDREN);
  for (const [to, amt] of top) {
    const nextDepth = depth + 1;
    if (nextDepth > MAX_DEPTH) { warn("Max depth:", to); continue; }
    log(`➡️  ${fromAddr} -> ${to} | amt≈${amt} | depth ${nextDepth} | sig=${signature}`);
    addAddress(to, nextDepth);
  }
}

/** ===== Backfill (rétroactif) ===== */
async function backfillAddress(addr){
  const pk = new PublicKey(addr);
  const cutoff = nowSec() - LOOKBACK_MIN*60;
  let before = undefined;
  info(`Backfill ${addr} sur ${LOOKBACK_MIN} min...`);

  while (true) {
    const sigs = await connConf.getSignaturesForAddress(pk, { before, limit: 100 });
    if (!sigs.length) break;

    const oldest = sigs[sigs.length-1];
    before = oldest.signature;

    // garder celles >= cutoff
    const fresh = sigs.filter(s => (s.blockTime ?? 0) >= cutoff);

    // traiter du plus vieux → plus récent
    for (const s of fresh.reverse()) {
      if (!SEEN.has(s.signature)) {
        await handleSignature(addr, WATCH.get(addr)?.depth ?? 0, s.signature);
      }
    }

    if ((oldest.blockTime ?? 0) < cutoff) break;
  }
}

/** ===== Boot ===== */
log("--- Rug Tracker (Backfill + WebSocket) ---");
log("Seeds:", SEEDS.join(", "));
log(`LOOKBACK_MIN=${LOOKBACK_MIN} | MIN_SOL=${MIN_SOL} | MIN_SPL_UNITS=${MIN_SPL_UNITS} | TOP_CHILDREN=${TOP_CHILDREN} | MAX_DEPTH=${MAX_DEPTH}`);
if (CEX.size) log(`CEX hot wallets: ${CEX.size}`);

(async ()=>{
  // 1) S'abonner en temps réel à toutes les seeds
  for (const a of SEEDS) addAddress(a, 0);

  // 2) Backfill initial (rattrapage)
  for (const a of SEEDS) {
    try { await backfillAddress(a); }
    catch(e){ err("Backfill error", a, e?.message||e); }
  }

  log("✅ Backfill OK → passage en temps réel.");
})();

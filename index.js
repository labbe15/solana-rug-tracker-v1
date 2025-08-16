import { Connection, PublicKey } from "@solana/web3.js";
import "dotenv/config";

/** ===== Config ===== */
const RPC_HTTP = process.env.RPC_HTTP || "https://api.mainnet-beta.solana.com";
const RPC_WSS  = process.env.RPC_WSS  || "wss://api.mainnet-beta.solana.com";

const SEEDS = (process.env.WATCH_ADDRS || process.env.SEED_ADDR || "")
  .split(",").map(s=>s.trim()).filter(Boolean);
if (!SEEDS.length) {
  console.error("8X7pr6Zk1hX3r4eZ4iGDaohF9ZNpS2tUn8LccG4fSheQ");
  process.exit(1);
}

const MIN_SOL        = Number(process.env.MIN_SOL || 0.2);
const MIN_SPL_UNITS  = Number(process.env.MIN_SPL_UNITS || 1e6);
const MAX_DEPTH      = Number(process.env.MAX_DEPTH || 6);
const TOP_CHILDREN   = Number(process.env.TOP_CHILDREN || 3);

// Backfill total (par défaut) ; tu peux limiter le nombre max de signatures si besoin
const BACKFILL_ALL   = (process.env.BACKFILL_ALL ?? "true").toLowerCase() === "true";
const BACKFILL_LIMIT = Number(process.env.BACKFILL_LIMIT || 0); // 0 = illimité

const CEX = new Set((process.env.CEX_HOT_WALLETS || "")
  .split(",").map(s=>s.trim()).filter(Boolean));

const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL
  "TokenzQdBNbLqP5VEh9bSTBz2T9SxH3hszMpyyZHPv9"  // Token-2022
]);

/** ===== Connexions / État ===== */
const connFast = new Connection(RPC_HTTP, { commitment: "processed", wsEndpoint: RPC_WSS });
const connConf = new Connection(RPC_HTTP, { commitment: "confirmed", wsEndpoint: RPC_WSS });

const WATCH = new Map(); // addr -> { depth, subId }
const DEPTH = new Map(); // addr -> depth (utile pendant backfill)
const SEEN  = new Set(); // signatures déjà traitées

const isCEX = (a)=>CEX.has(a);
const log = (...a)=>console.log(...a);
const info = (...a)=>console.log("[INFO]", ...a);
const warn = (...a)=>console.warn("[WARN]", ...a);
const err  = (...a)=>console.error("[ERR ]", ...a);

/** ===== Core ===== */
function addAddress(addr, depth=0, subscribeNow=true){
  if (!addr) return;
  if (depth > MAX_DEPTH) return;
  // garde la profondeur minimale rencontrée pour cette addr
  if (!DEPTH.has(addr) || depth < DEPTH.get(addr)) DEPTH.set(addr, depth);

  if (!subscribeNow) return; // pendant backfill, on peut différer l’abonnement WS

  if (WATCH.has(addr)) return;
  let pk; try { pk = new PublicKey(addr); } catch { return; }
  const subId = connFast.onLogs(pk, lg => onLogs(addr, DEPTH.get(addr) ?? depth, lg), "processed");
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

  // Signal InitializeMint (utile pour capter une création)
  const logs = tx?.meta?.logMessages || [];
  if (logs.some(l => l.includes("Instruction: InitializeMint"))) {
    log(`🚨 InitializeMint | signer≈${fromAddr} | sig=${signature}`);
  }

  // Extraire sorties (SOL + SPL simple)
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

  // suivre top-N
  const top = [...dests.entries()].sort((a,b)=>b[1]-a[1]).slice(0, TOP_CHILDREN);
  for (const [to, amt] of top) {
    const nextDepth = depth + 1;
    if (nextDepth > MAX_DEPTH) { warn("Max depth:", to); continue; }
    log(`➡️  ${fromAddr} -> ${to} | amt≈${amt} | depth ${nextDepth} | sig=${signature}`);
    // Pendant backfill on ajoute sans WS ; le WS sera branché après.
    addAddress(to, nextDepth, false);
  }
}

/** ===== Backfill (illimité ou limité) ===== */
async function backfillAllFrom(addr){
  const pk = new PublicKey(addr);
  info(`Backfill total pour ${addr} ...${BACKFILL_LIMIT ? ` (limité à ${BACKFILL_LIMIT} signatures)` : ""}`);
  let before = undefined;
  let count = 0;

  while (true) {
    const sigs = await connConf.getSignaturesForAddress(pk, { before, limit: 100 });
    if (!sigs.length) break;
    before = sigs[sigs.length - 1].signature;

    // traiter du plus vieux au plus récent
    for (const s of sigs.reverse()) {
      if (BACKFILL_LIMIT && count >= BACKFILL_LIMIT) return;
      if (!SEEN.has(s.signature)) {
        await handleSignature(addr, DEPTH.get(addr) ?? 0, s.signature);
        count++;
      }
    }
    if (BACKFILL_LIMIT && count >= BACKFILL_LIMIT) break;
  }
  info(`Backfill terminé pour ${addr} (${count} signatures traitées).`);
}

/** ===== Boot ===== */
log("--- Rug Tracker (Backfill TOTAL → WebSocket) ---");
log("Seeds:", SEEDS.join(", "));
log(`MIN_SOL=${MIN_SOL} | MIN_SPL_UNITS=${MIN_SPL_UNITS} | TOP_CHILDREN=${TOP_CHILDREN} | MAX_DEPTH=${MAX_DEPTH}`);
if (CEX.size) log(`CEX hot wallets: ${CEX.size}`);

(async ()=>{
  // 1) Initialiser la profondeur des seeds et construire tout le graphe via backfill (sans WS)
  for (const a of SEEDS) addAddress(a, 0, false); // false = pas d'abonnement WS pendant backfill
  for (const a of SEEDS) {
    try { await backfillAllFrom(a); }
    catch(e){ err("Backfill error", a, e?.message||e); }
  }

  // 2) Quand le backfill est fini, on branche les WS sur TOUTES les adresses connues (DEPTH map)
  for (const [addr, depth] of DEPTH.entries()) {
    addAddress(addr, depth, true); // true = abonnement WS
  }
  log("✅ Backfill terminé → passage en temps réel.");
})();


import { Connection, PublicKey } from "@solana/web3.js";
import "dotenv/config";

/** ========= CONFIG ========= */
const RPC_HTTP = process.env.RPC_HTTP || process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const RPC_WSS  = process.env.RPC_WSS  || "wss://api.mainnet-beta.solana.com";

const SEEDS = (process.env.WATCH_ADDRS || process.env.SEED_ADDR || "")
  .split(",").map(s=>s.trim()).filter(Boolean);
if (!SEEDS.length) {
  console.error("❌ WATCH_ADDRS (ou SEED_ADDR) manquant.");
  process.exit(1);
}

const MIN_SOL        = Number(process.env.MIN_SOL || 0.2);
const MIN_SPL_UNITS  = Number(process.env.MIN_SPL_UNITS || 1e6);
const MAX_DEPTH      = Number(process.env.MAX_DEPTH || 6);
const TOP_CHILDREN   = Number(process.env.TOP_CHILDREN || 3);

// Backfill total (par graph), avec cap optionnel
const BACKFILL_ALL     = (process.env.BACKFILL_ALL ?? "true").toLowerCase() === "true";
const BACKFILL_LIMIT   = Number(process.env.BACKFILL_LIMIT || 0);   // 0 = illimité (signatures)
const MAX_BACKFILL_ADDRS = Number(process.env.MAX_BACKFILL_ADDRS || 0); // 0 = illimité (adresses)

/** Throttle/Anti-429 */
const PAGE_SIZE     = Number(process.env.PAGE_SIZE     || 25);
const REQ_DELAY_MS  = Number(process.env.REQ_DELAY_MS  || 250); // pause entre pages
const TX_DELAY_MS   = Number(process.env.TX_DELAY_MS   || 150); // pause entre tx
const MAX_RETRIES   = Number(process.env.MAX_RETRIES   || 3);
const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS || 500);

/** CEX ignore list */
const CEX = new Set((process.env.CEX_HOT_WALLETS || "")
  .split(",").map(s=>s.trim()).filter(Boolean));

/** Program IDs utiles */
const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL
  "TokenzQdBNbLqP5VEh9bSTBz2T9SxH3hszMpyyZHPv9"  // Token-2022
]);

/** ========= CONNEXIONS / ÉTAT ========= */
const connFast = new Connection(RPC_HTTP, { commitment: "processed", wsEndpoint: RPC_WSS });
const connConf = new Connection(RPC_HTTP, { commitment: "confirmed", wsEndpoint: RPC_WSS });

const WATCH       = new Map();   // addr -> { depth, subId }
const DEPTH       = new Map();   // addr -> depth minimal observé
const SEEN        = new Set();   // signatures déjà traitées
const ENQUEUED    = new Set();   // adresses en file d'attente de backfill
const BACKFILLED  = new Set();   // adresses déjà backfillées
let   IN_BACKFILL = true;        // tant que true, on ignore les logs live

const isCEX = (a)=>CEX.has(a);
const sleep = (ms)=>new Promise(r=>setTimeout(r, ms));

const log  = (...a)=>console.log(...a);
const info = (...a)=>console.log("[INFO]", ...a);
const warn = (...a)=>console.warn("[WARN]", ...a);
const err  = (...a)=>console.error("[ERR ]", ...a);

/** ========= HELPERS RPC avec retry/backoff ========= */
async function withRetry(fn, label="rpc") {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (e) {
      attempt++;
      const msg = e?.message || String(e);
      if (attempt >= MAX_RETRIES) {
        throw new Error(`${label} failed after ${attempt} attempts: ${msg}`);
      }
      const backoff = RETRY_BASE_MS * Math.pow(2, attempt - 1);
      warn(`${label} error (${msg}). Retry #${attempt} in ${backoff}ms`);
      await sleep(backoff);
    }
  }
}

async function getSigsPage(pk, before) {
  return await withRetry(
    () => connConf.getSignaturesForAddress(pk, { before, limit: PAGE_SIZE }),
    "getSignaturesForAddress"
  );
}

async function getParsedTx(signature) {
  return await withRetry(
    () => connConf.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 }),
    "getParsedTransaction"
  );
}

/** ========= CORE ========= */
function trackDepth(addr, depth){
  if (!DEPTH.has(addr) || depth < DEPTH.get(addr)) DEPTH.set(addr, depth);
}

function addAddress(addr, depth=0, subscribeNow=true){
  if (!addr) return;
  if (depth > MAX_DEPTH) return;
  trackDepth(addr, depth);

  if (!subscribeNow) return;        // pendant backfill, on diffère WS

  if (WATCH.has(addr)) return;
  let pk; try { pk = new PublicKey(addr); } catch { return; }
  const subId = connFast.onLogs(pk, (lg)=>onLogs(addr, DEPTH.get(addr) ?? depth, lg), "processed");
  WATCH.set(addr, { depth, subId });
  info(`Subscribed: ${addr} (depth ${depth})`);
}

async function onLogs(addr, depth, lg){
  try {
    if (IN_BACKFILL) return;        // on ignore le live tant que le backfill n'est pas fini
    const sig = lg?.signature;
    if (!sig || SEEN.has(sig)) return;
    await handleSignature(addr, depth, sig);
  } catch (e) { err(e?.message || e); }
}

async function handleSignature(fromAddr, depth, signature){
  SEEN.add(signature);

  const tx = await getParsedTx(signature);
  if (!tx?.transaction) return;

  // Signal InitializeMint
  const logsMsgs = tx?.meta?.logMessages || [];
  if (logsMsgs.some(l => l.includes("Instruction: InitializeMint"))) {
    log(`🚨 InitializeMint | signer≈${fromAddr} | sig=${signature}`);
  }

  // Extraire sorties
  const dests = new Map();
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

    // Pendant backfill: on alimente la queue (sans WS)
    addAddress(to, nextDepth, false);
    if (IN_BACKFILL && (MAX_BACKFILL_ADDRS === 0 || (BACKFILLED.size + ENQUEUED.size) < MAX_BACKFILL_ADDRS)) {
      if (!ENQUEUED.has(to) && !BACKFILLED.has(to)) {
        ENQUEUED.add(to);
        BACKFILL_QUEUE.push({ addr: to, depth: nextDepth });
      }
    }
  }
}

/** ========= BACKFILL EN LARGEUR (QUEUE) ========= */
const BACKFILL_QUEUE = [];

async function backfillOne(addr){
  if (!BACKFILL_ALL) return 0;
  if (BACKFILLED.has(addr)) return 0;

  const pk = new PublicKey(addr);
  BACKFILLED.add(addr);
  let before = undefined, count = 0;

  info(`Backfill ${addr} ...`);

  while (true) {
    const sigs = await getSigsPage(pk, before);
    if (!sigs.length) break;

    before = sigs[sigs.length - 1].signature;

    // plus vieux → plus récent
    const batch = sigs.slice().reverse();
    for (const s of batch) {
      if (BACKFILL_LIMIT && SEEN.size >= BACKFILL_LIMIT) {
        info(`Backfill interrompu (BACKFILL_LIMIT atteint)`);
        return count;
      }
      if (!SEEN.has(s.signature)) {
        try {
          await handleSignature(addr, DEPTH.get(addr) ?? 0, s.signature);
          count++;
        } catch (e) {
          const msg = e?.message || String(e);
          if (msg.includes("429")) {
            warn(`429 sur ${s.signature} → pause 1500ms`);
            await sleep(1500);
          } else {
            warn(`Erreur tx ${s.signature}: ${msg}`);
          }
        }
      }
      await sleep(TX_DELAY_MS);
    }
    await sleep(REQ_DELAY_MS);
  }

  info(`Backfill terminé pour ${addr} (${count} signatures).`);
  return count;
}

async function backfillBFS(){
  // Seeds → dans la queue
  for (const a of SEEDS) {
    trackDepth(a, 0);
    if (!ENQUEUED.has(a)) { ENQUEUED.add(a); BACKFILL_QUEUE.push({ addr: a, depth: 0 }); }
  }

  while (BACKFILL_QUEUE.length) {
    const { addr } = BACKFILL_QUEUE.shift();
    await backfillOne(addr);
  }
}

/** ========= BOOT ========= */
log("--- Rug Tracker (Backfill total en largeur → WebSocket) ---");
log("Seeds:", SEEDS.join(", "));
log(`MIN_SOL=${MIN_SOL} | MIN_SPL_UNITS=${MIN_SPL_UNITS} | TOP_CHILDREN=${TOP_CHILDREN} | MAX_DEPTH=${MAX_DEPTH}`);
log(`Throttle → PAGE_SIZE=${PAGE_SIZE} | REQ_DELAY_MS=${REQ_DELAY_MS} | TX_DELAY_MS=${TX_DELAY_MS} | RETRIES=${MAX_RETRIES}`);

(async ()=>{
  // 1) Backfill en largeur de tout le graphe (pas de WS pendant cette phase)
  await backfillBFS();

  // 2) Quand la queue est vide, on passe en temps réel : WS sur TOUTES les adresses connues
  IN_BACKFILL = false;
  for (const [addr, depth] of DEPTH.entries()) addAddress(addr, depth, true);

  log("✅ Backfill COMPLET → passage en temps réel.");
})();

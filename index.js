// index.js
import { Connection, PublicKey } from "@solana/web3.js";
import "dotenv/config";

/** ========== ENV & COMPAT ========== */
// RPC: accepte RPC_URLS (liste), sinon RPC_HTTP ou RPC_URL (unique)
const RPC_URLS = (process.env.RPC_URLS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const FALLBACK_HTTP = (process.env.RPC_HTTP || process.env.RPC_URL || "").trim();
if (!RPC_URLS.length && !FALLBACK_HTTP) {
  console.error("❌ Aucun RPC fourni. Règle l'un de ces variables :");
  console.error("   - RPC_URLS=https://a,... (recommandé)  OU");
  console.error("   - RPC_HTTP=https://ton-endpoint  (ou RPC_URL)");
  process.exit(1);
}
const HTTP_POOL = RPC_URLS.length ? RPC_URLS : [FALLBACK_HTTP];

// WebSocket optionnel
const RPC_WSS = (process.env.RPC_WSS || "").trim() || undefined;

// Seeds: accepte WATCH_ADDRS (legacy) ou SEEDS
const SEEDS = (process.env.WATCH_ADDRS || process.env.SEEDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

if (!SEEDS.length) {
  console.error("❌ Aucune adresse à suivre. Ajoute WATCH_ADDRS=addr1,addr2 (ou SEEDS=...).");
  process.exit(1);
}

/** ========== PARAMS ========== */
const MIN_SOL        = Number(process.env.MIN_SOL || 0.2);
const MIN_SPL_UNITS  = Number(process.env.MIN_SPL_UNITS || 1e6);
const MAX_DEPTH      = Number(process.env.MAX_DEPTH || 6);
const TOP_CHILDREN   = Number(process.env.TOP_CHILDREN || 3);

// Backfill total (graph) + limites
const BACKFILL_ALL       = ((process.env.BACKFILL_ALL ?? "true").toLowerCase() === "true");
const BACKFILL_LIMIT     = Number(process.env.BACKFILL_LIMIT || 0); // 0 = illimité (nb de signatures)
const MAX_BACKFILL_ADDRS = Number(process.env.MAX_BACKFILL_ADDRS || 0); // 0 = illimité (nb d'adresses)

// Throttle / anti-429
const PAGE_SIZE     = Number(process.env.PAGE_SIZE     || 25);
const REQ_DELAY_MS  = Number(process.env.REQ_DELAY_MS  || 250); // pause entre pages
const TX_DELAY_MS   = Number(process.env.TX_DELAY_MS   || 150); // pause entre tx
const MAX_RETRIES   = Number(process.env.MAX_RETRIES   || 3);
const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS || 500);

// CEX à ignorer
const CEX = new Set(
  (process.env.CEX_HOT_WALLETS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
);

// SPL Programs
const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEh9bSTBz2T9SxH3hszMpyyZHPv9",
]);

/** ========== UTILS ========== */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const info = (...x) => console.log("[INFO]", ...x);
const warn = (...x) => console.warn("[WARN]", ...x);
const err  = (...x) => console.error("[ERR ]", ...x);

// Connexions (on utilise le 1er HTTP pour créer Connection; on pourrait faire un pool si besoin)
const RPC_HTTP = HTTP_POOL[0];
const connFast = new Connection(RPC_HTTP, { commitment: "processed",  wsEndpoint: RPC_WSS });
const connConf = new Connection(RPC_HTTP, { commitment: "confirmed",  wsEndpoint: RPC_WSS });

/** ========== ÉTAT ========== */
const WATCH       = new Map();   // addr -> { depth, subId }
const DEPTH       = new Map();   // addr -> depth minimal observé
const SEEN        = new Set();   // signatures déjà traitées
const ENQUEUED    = new Set();   // adresses en file BFS
const BACKFILLED  = new Set();   // adresses déjà backfillées
const BACKFILL_QUEUE = [];
let   IN_BACKFILL = true;

/** ========== HELPERS RPC (retry/backoff) ========== */
async function withRetry(fn, label="rpc") {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (e) {
      attempt++;
      const msg = e?.message || String(e);
      if (attempt >= MAX_RETRIES) throw new Error(`${label} failed after ${attempt} attempts: ${msg}`);
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

/** ========== CORE ========== */
function trackDepth(addr, depth) {
  if (!DEPTH.has(addr) || depth < DEPTH.get(addr)) DEPTH.set(addr, depth);
}

function addAddress(addr, depth=0, subscribeNow=true){
  if (!addr) return;
  if (depth > MAX_DEPTH) return;
  trackDepth(addr, depth);

  if (!subscribeNow) return; // on diffère WS pendant backfill

  if (WATCH.has(addr)) return;
  let pk; try { pk = new PublicKey(addr); } catch { return; }
  const subId = connFast.onLogs(pk, (lg)=>onLogs(addr, DEPTH.get(addr) ?? depth, lg), "processed");
  WATCH.set(addr, { depth, subId });
  info(`Subscribed: ${addr} (depth ${depth})`);
}

async function onLogs(addr, depth, lg){
  try {
    if (IN_BACKFILL) return; // pas de live tant que backfill pas fini
    const sig = lg?.signature;
    if (!sig || SEEN.has(sig)) return;
    await handleSignature(addr, depth, sig);
  } catch (e) { err(e?.message || e); }
}

async function handleSignature(fromAddr, depth, signature){
  SEEN.add(signature);

  const tx = await getParsedTx(signature);
  if (!tx?.transaction) return;

  const logs = tx?.meta?.logMessages || [];
  if (logs.some(l => l.includes("Instruction: InitializeMint"))) {
    console.log(`🚨 InitializeMint | signer≈${fromAddr} | sig=${signature}`);
  }

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
        if (amt >= MIN_SOL && !CEX.has(destination))
          dests.set(destination, (dests.get(destination)||0) + amt);
      }
    }

    // SPL (simple) + résolution ATA → OWNER
    const isSpl = (program === "spl-token") || TOKEN_PROGRAMS.has(programId);
    if (isSpl && parsed?.type && (parsed.type === "transfer" || parsed.type === "transferChecked")) {
      const inf = parsed.info || {};
      const owners = [inf.owner, inf.sourceOwner, inf.authority].filter(Boolean);
      if (owners.includes(fromAddr)) {
        const rawTo = inf.destinationOwner || inf.destination || inf.account || null;
        const amt = Number(inf.amount || 0);
        if (rawTo && amt >= MIN_SPL_UNITS) {
          let follow = rawTo;
          try {
            // Si c'est une ATA SPL, remonter au owner du token account
            const accInfo = await connConf.getParsedAccountInfo(new PublicKey(rawTo));
            const parsedAcc = accInfo?.value?.data?.parsed;
            if (parsedAcc?.type === "account" && parsedAcc?.info?.owner) {
              follow = parsedAcc.info.owner;
              console.log(`   [ATA→OWNER] ${rawTo} → ${follow}`);
            }
          } catch {/* silencieux */}
          if (follow && !CEX.has(follow)) {
            dests.set(follow, (dests.get(follow)||0) + amt);
          }
        }
      }
    }
  }

  if (!dests.size) return;

  const top = [...dests.entries()].sort((a,b)=>b[1]-a[1]).slice(0, TOP_CHILDREN);
  for (const [to, amt] of top) {
    const nextDepth = depth + 1;
    if (nextDepth > MAX_DEPTH) { warn("Max depth:", to); continue; }
    console.log(`➡️  ${fromAddr} -> ${to} | amt≈${amt} | depth ${nextDepth} | sig=${signature}`);

    // Pendant backfill: on alimente la queue sans WS
    addAddress(to, nextDepth, false);
    if (IN_BACKFILL && (MAX_BACKFILL_ADDRS === 0 || ENQUEUED.size < MAX_BACKFILL_ADDRS)) {
      if (!ENQUEUED.has(to)) {
        ENQUEUED.add(to);
        BACKFILL_QUEUE.push({ addr: to, depth: nextDepth });
      }
    }
  }
}

/** ========== BACKFILL (BFS) ========== */
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

    const batch = sigs.slice().reverse(); // oldest → newest
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
      await sleep(TX_DELAY_MS); // throttle intra-page
    }
    await sleep(REQ_DELAY_MS);  // throttle inter-pages
  }

  info(`Backfill terminé pour ${addr} (${count} signatures).`);
  return count;
}

async function backfillBFS(){
  // initialiser la queue avec les seeds
  for (const a of SEEDS) {
    if (!ENQUEUED.has(a)) { ENQUEUED.add(a); BACKFILL_QUEUE.push({ addr: a, depth: 0 }); }
    if (!DEPTH.has(a)) DEPTH.set(a, 0);
  }

  // boucle jusqu'à vraie stabilisation de la queue
  let lastWasEmpty = false;
  while (true) {
    while (BACKFILL_QUEUE.length) {
      const { addr } = BACKFILL_QUEUE.shift();
      await backfillOne(addr);
    }

    if (BACKFILL_QUEUE.length === 0) {
      if (lastWasEmpty) break;      // deux fois de suite vide ⇒ terminé
      lastWasEmpty = true;
      await sleep(2000);            // fenêtre pour capter des adresses ajoutées "en retard"
    } else {
      lastWasEmpty = false;
    }
  }
}

/** ========== BOOT ========== */
console.log("--- Rug Tracker (Backfill total BFS → WebSocket) ---");
console.log("Seeds:", SEEDS.join(", "));
console.log(`RPC_HTTP in use: ${RPC_HTTP}`);
if (RPC_URLS.length) console.log("RPC_URLS pool:", HTTP_POOL.join(" , "));
if (RPC_WSS) console.log("RPC_WSS:", RPC_WSS);
console.log(`MIN_SOL=${MIN_SOL} | MIN_SPL_UNITS=${MIN_SPL_UNITS} | TOP_CHILDREN=${TOP_CHILDREN} | MAX_DEPTH=${MAX_DEPTH}`);
console.log(`Throttle → PAGE_SIZE=${PAGE_SIZE} | REQ_DELAY_MS=${REQ_DELAY_MS} | TX_DELAY_MS=${TX_DELAY_MS} | RETRIES=${MAX_RETRIES}`);

(async ()=>{
  // 1) Backfill complet (pas de WS pendant cette phase)
  try { await backfillBFS(); }
  catch (e) { err("Backfill global error:", e?.message || e); }

  // 2) Quand la queue est vraiment vide, on passe en temps réel : WS sur toutes les adresses connues
  IN_BACKFILL = false;
  for (const [addr, depth] of DEPTH.entries()) addAddress(addr, depth, true);

  console.log("✅ Backfill COMPLET → passage en temps réel.");
})();

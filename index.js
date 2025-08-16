import WebSocket from "ws";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

// ---------------- CONFIG ----------------
const RPCS = (process.env.RPC_URLS || "").split(",").map(x => x.trim()).filter(Boolean);
let RPC_INDEX = 0;
function rpcUrl() {
  const url = RPCS[RPC_INDEX];
  RPC_INDEX = (RPC_INDEX + 1) % RPCS.length;
  return url;
}

const SEEDS = (process.env.SEEDS || "").split(",").map(x => x.trim()).filter(Boolean);
const MIN_SOL = parseFloat(process.env.MIN_SOL || "0.2");
const MIN_SPL_UNITS = parseInt(process.env.MIN_SPL_UNITS || "1000000");
const TOP_CHILDREN = parseInt(process.env.TOP_CHILDREN || "3");
const MAX_DEPTH = parseInt(process.env.MAX_DEPTH || "6");

const BACKFILL_QUEUE = [];
const ENQUEUED = new Set();
const SUBSCRIBED = new Set();

let IN_BACKFILL = true;

// ---------------- UTILS ----------------
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function logInfo(...args) {
  console.log("[INFO]", ...args);
}
function logWarn(...args) {
  console.warn("[WARN]", ...args);
}
function logErr(...args) {
  console.error("[ERR ]", ...args);
}

// ---------------- BACKFILL ----------------
async function fetchSigs(addr) {
  let sigs = [];
  let before = null;
  let page = 0;
  while (true) {
    try {
      const body = {
        jsonrpc: "2.0",
        id: "sigs",
        method: "getSignaturesForAddress",
        params: [addr, { limit: 1000, before }]
      };
      const res = await fetch(rpcUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const json = await res.json();
      if (!json.result || json.result.length === 0) break;
      sigs.push(...json.result);
      before = json.result[json.result.length - 1].signature;
      page++;
      if (page > 5) break; // sécurité
    } catch (e) {
      logWarn("fetchSigs error", e.message);
      await sleep(1000);
    }
  }
  return sigs;
}

async function fetchTx(sig) {
  try {
    const body = {
      jsonrpc: "2.0",
      id: "tx",
      method: "getTransaction",
      params: [sig, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]
    };
    const res = await fetch(rpcUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const json = await res.json();
    return json.result || null;
  } catch (e) {
    logWarn("fetchTx error", sig, e.message);
    return null;
  }
}

async function backfillOne(addr) {
  try {
    const sigs = await fetchSigs(addr);
    for (const s of sigs) {
      const tx = await fetchTx(s.signature);
      if (!tx) continue;
      parseTx(addr, tx, s.signature);
    }
  } catch (e) {
    logErr("Backfill error", addr, e.message);
  }
}

async function backfillBFS() {
  // init
  for (const a of SEEDS) {
    if (!ENQUEUED.has(a)) {
      ENQUEUED.add(a);
      BACKFILL_QUEUE.push({ addr: a, depth: 0 });
    }
  }

  let lastSize = -1;
  while (true) {
    // traiter tout ce qu’il y a
    while (BACKFILL_QUEUE.length) {
      const { addr } = BACKFILL_QUEUE.shift();
      await backfillOne(addr);
    }

    // si vide → on attend un peu pour voir si d’autres adresses arrivent
    if (BACKFILL_QUEUE.length === 0) {
      if (lastSize === 0) {
        // deux tours de suite vide → fin
        break;
      }
      lastSize = 0;
      await sleep(2000);
    }
  }

  logInfo("✅ Backfill terminé → passage en temps réel.");
  IN_BACKFILL = false;
}

// ---------------- PARSE TX ----------------
function parseTx(parent, tx, sig) {
  try {
    const accs = tx.transaction.message.accountKeys.map(a => a.pubkey);
    const meta = tx.meta;
    if (!meta || !meta.postBalances) return;

    for (let i = 0; i < accs.length; i++) {
      const bal = meta.postBalances[i] / 1e9;
      if (bal >= MIN_SOL && !ENQUEUED.has(accs[i])) {
        ENQUEUED.add(accs[i]);
        BACKFILL_QUEUE.push({ addr: accs[i], depth: 1 });
        logInfo("➡️ ", parent, "->", accs[i], "| sig=" + sig);
      }
    }
  } catch (e) {
    logWarn("parseTx error", e.message);
  }
}

// ---------------- SUBSCRIPTION ----------------
function subscribe(addr, depth) {
  if (SUBSCRIBED.has(addr)) return;
  SUBSCRIBED.add(addr);
  logInfo("Subscribed:", addr, "(depth", depth, ")");
  // ici tu pourrais brancher un websocket vers ton RPC si dispo
}

// ---------------- MAIN ----------------
(async () => {
  logInfo("--- Rug Tracker (Backfill TOTAL → WebSocket) ---");
  logInfo("Seeds:", SEEDS.join(", "));
  logInfo(`MIN_SOL=${MIN_SOL} | MIN_SPL_UNITS=${MIN_SPL_UNITS} | TOP_CHILDREN=${TOP_CHILDREN} | MAX_DEPTH=${MAX_DEPTH}`);

  await backfillBFS();

  // après backfill, on lance les subs
  for (const a of SEEDS) {
    subscribe(a, 0);
  }
})();

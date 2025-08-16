import { Connection, PublicKey } from "@solana/web3.js";
import dotenv from "dotenv";

dotenv.config();

// RPC (gratuit par défaut, on peut changer plus tard si besoin)
const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");

// Adresse à suivre (tu pourras en mettre plusieurs ensuite)
const WATCHED_ADDRESS = new PublicKey("8X7pr6Zk1hX3r4eZ4iGDaohF9ZNpS2tUn8LccG4fSheQ");

async function checkTxs() {
  console.log("⏳ Checking transactions...");

  const sigs = await connection.getSignaturesForAddress(WATCHED_ADDRESS, { limit: 5 });
  for (let sig of sigs) {
    console.log("Tx found:", sig.signature);
  }
}

// Boucle simple toutes les 10 sec
setInterval(checkTxs, 10000);


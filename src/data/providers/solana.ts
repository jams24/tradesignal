import axios from "axios";
import { logger } from "../../utils/logger";

const SOLANA_RPCS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana-api.projectserum.com",
];

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_SOL_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_SOL_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const RAYDIUM_PROGRAM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const PUMP_FUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

const KNOWN_SOL_TOKENS: Record<string, string> = {
  [WSOL_MINT]: "SOL",
  [USDC_SOL_MINT]: "USDC",
  [USDT_SOL_MINT]: "USDT",
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": "BONK",
  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm": "WIF",
  "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU": "SAMO",
  "3S8qX1MsMqRbiwKg2cQyx7nis1oHMgaCuc9c4VfvVdPN": "MOBILE",
  "MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5": "MEW",
  "2weMjPLLybRMMva1fM3U31goWWrCpF59CHWNhnCJ9Vyh": "POPCAT",
};

export interface SolanaTransfer {
  token: string;
  symbol: string;
  amount: number;
  valueUsd: number;
  from: string;
  to: string;
  txHash: string;
  timestamp: number;
}

export interface SolanaDexSwap {
  pairAddress: string;
  tokenIn: string;
  tokenInSymbol: string;
  tokenOut: string;
  tokenOutSymbol: string;
  amount: number;
  volumeUsd: number;
  wallet: string;
  txHash: string;
  timestamp: number;
}

export class SolanaProvider {
  private rpcIndex = 0;

  private async rpcCall(method: string, params: any[]): Promise<any> {
    for (let attempt = 0; attempt < SOLANA_RPCS.length; attempt++) {
      const idx = (this.rpcIndex + attempt) % SOLANA_RPCS.length;
      try {
        const { data } = await axios.post(SOLANA_RPCS[idx], {
          jsonrpc: "2.0", id: 1, method, params,
        }, { timeout: 10000 });
        this.rpcIndex = idx;
        return data;
      } catch { /* next */ }
    }
    return null;
  }

  async fetchLargeTransfers(minSol = 100): Promise<SolanaTransfer[]> {
    const transfers: SolanaTransfer[] = [];

    try {
      // Get recent transactions from Raydium and Jupiter programs
      for (const program of [RAYDIUM_PROGRAM, PUMP_FUN_PROGRAM]) {
        const resp = await this.rpcCall("getSignaturesForAddress", [
          program,
          { limit: 10 },
        ]);

        const sigs = resp?.result || [];
        for (const sig of sigs.slice(0, 5)) {
          const txResp = await this.rpcCall("getTransaction", [
            sig.signature,
            { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
          ]);

          const tx = txResp?.result;
          if (!tx?.meta?.postTokenBalances) continue;

          for (const bal of tx.meta.postTokenBalances) {
            const change = Math.abs((bal.uiTokenAmount?.uiAmount || 0) - 0);
            const mint = bal.mint;
            const symbol = KNOWN_SOL_TOKENS[mint] || mint.slice(0, 4) + "..";

            if (change < 100 && symbol !== "SOL") continue;

            transfers.push({
              token: mint,
              symbol,
              amount: change,
              valueUsd: symbol === "SOL" ? change * 150 : symbol === "USDC" ? change : change,
              from: "",
              to: "",
              txHash: sig.signature,
              timestamp: (sig.blockTime || 0) * 1000 || Date.now(),
            });
          }
        }
      }
    } catch (err: any) {
      logger.error(`Solana transfer fetch failed: ${err.message}`);
    }

    return transfers.slice(0, 20);
  }

  async fetchTokenTransfers(tokenMint: string, limit = 10): Promise<SolanaTransfer[]> {
    const transfers: SolanaTransfer[] = [];

    try {
      const resp = await this.rpcCall("getSignaturesForAddress", [
        tokenMint,
        { limit },
      ]);

      const sigs = resp?.result || [];
      for (const sig of sigs) {
        const txResp = await this.rpcCall("getTransaction", [
          sig.signature,
          { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
        ]);

        const tx = txResp?.result;
        const instructions = tx?.transaction?.message?.instructions || [];
        for (const ix of instructions) {
          if (ix.parsed?.type === "transfer") {
            transfers.push({
              token: tokenMint,
              symbol: KNOWN_SOL_TOKENS[tokenMint] || "TOKEN",
              amount: ix.parsed.info.amount || 0,
              valueUsd: 0,
              from: ix.parsed.info.source || "",
              to: ix.parsed.info.destination || "",
              txHash: sig.signature,
              timestamp: (sig.blockTime || 0) * 1000 || Date.now(),
            });
          }
        }
      }
    } catch (err: any) {
      logger.error(`Solana token transfer fetch failed: ${err.message}`);
    }

    return transfers;
  }

  async fetchDexActivity(): Promise<SolanaDexSwap[]> {
    const swaps: SolanaDexSwap[] = [];

    try {
      for (const program of [RAYDIUM_PROGRAM]) {
        const resp = await this.rpcCall("getSignaturesForAddress", [
          program,
          { limit: 20 },
        ]);

        const sigs = resp?.result || [];
        for (const sig of sigs.slice(0, 10)) {
          const txResp = await this.rpcCall("getTransaction", [
            sig.signature,
            { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
          ]);

          const tx = txResp?.result;
          const instructions = tx?.transaction?.message?.instructions || [];
          const pre = tx?.meta?.preTokenBalances || [];
          const post = tx?.meta?.postTokenBalances || [];

          if (post.length >= 2) {
            const lastPost = post[post.length - 1];
            const mint = lastPost.mint;
            const symbol = KNOWN_SOL_TOKENS[mint] || mint.slice(0, 6) + "..";

            swaps.push({
              pairAddress: program,
              tokenIn: "",
              tokenInSymbol: "SOL",
              tokenOut: mint,
              tokenOutSymbol: symbol,
              amount: lastPost.uiTokenAmount?.uiAmount || 0,
              volumeUsd: 0,
              wallet: tx?.transaction?.message?.accountKeys?.[0]?.pubkey || "",
              txHash: sig.signature,
              timestamp: (sig.blockTime || 0) * 1000 || Date.now(),
            });
          }
        }
      }
    } catch (err: any) {
      logger.error(`Solana DEX fetch failed: ${err.message}`);
    }

    return swaps;
  }
}

export const solanaProvider = new SolanaProvider();

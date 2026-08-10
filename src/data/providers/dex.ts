import axios from "axios";
import { logger } from "../../utils/logger";
import { config } from "../../utils/config";
import type { Chain } from "../../types/signals";

export interface SwapEvent {
  chain: Chain;
  dex: string;
  pairAddress: string;
  tokenIn: string;
  tokenInSymbol: string;
  tokenOut: string;
  tokenOutSymbol: string;
  amountIn: number;
  amountOut: number;
  price: number;
  priceUsd: number;
  volumeUsd: number;
  txHash: string;
  wallet: string;
  timestamp: number;
}

export interface NewPairEvent {
  chain: Chain;
  dex: string;
  pairAddress: string;
  token0: string;
  token1: string;
  token0Symbol: string;
  token1Symbol: string;
  baseToken: string;
  baseSymbol: string;
  quoteToken: string;
  initialLiquidity: number;
  deployer: string;
  txHash: string;
  timestamp: number;
}

export interface LPEvent {
  chain: Chain;
  type: "ADD" | "REMOVE";
  pairAddress: string;
  token0: string;
  token1: string;
  amount0: number;
  amount1: number;
  valueUsd: number;
  wallet: string;
  txHash: string;
  timestamp: number;
}

export class DexDataProvider {
  private heliusUrl: string;
  private ethRpcUrl: string;
  private baseRpcUrl: string;

  constructor() {
    this.heliusUrl = config.HELIUS_RPC_URL || "";
    this.ethRpcUrl = config.ETH_RPC_URL || "";
    this.baseRpcUrl = config.BASE_RPC_URL || "";
  }

  async fetchNewPairsSolana(): Promise<NewPairEvent[]> {
    if (!this.heliusUrl) return [];
    try {
      // Helius webhook / enhanced transactions API for new Raydium/Orca pairs
      // This is a simplified polling approach — production would use webhooks
      const { data } = await axios.post(this.heliusUrl, {
        jsonrpc: "2.0",
        id: "cryptosignal",
        method: "getSignaturesForAddress",
        params: [
          "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium Liquidity Pool V4
          { limit: 20 },
        ],
      }, { timeout: 10000 });

      const signatures = data?.result || [];
      const pairs: NewPairEvent[] = [];

      for (const sig of signatures.slice(0, 10)) {
        pairs.push({
          chain: "solana",
          dex: "raydium",
          pairAddress: "",
          token0: "",
          token1: "",
          token0Symbol: "",
          token1Symbol: "",
          baseToken: "",
          baseSymbol: "UNKNOWN",
          quoteToken: "",
          initialLiquidity: 0,
          deployer: "",
          txHash: sig.signature,
          timestamp: sig.blockTime ? sig.blockTime * 1000 : Date.now(),
        });
      }

      return pairs;
    } catch (err: any) {
      logger.error(`Solana DEX pair fetch failed: ${err.message}`);
      return [];
    }
  }

  async fetchSwapsSolana(tokenAddress: string): Promise<SwapEvent[]> {
    if (!this.heliusUrl) return [];
    try {
      const { data } = await axios.get(
        `https://api.helius.xyz/v0/addresses/${tokenAddress}/transactions?api-key=${this.heliusUrl.split("api-key=")[1]}&type=SWAP&limit=20`,
        { timeout: 10000 },
      );

      return (data || []).map((tx: any) => ({
        chain: "solana" as Chain,
        dex: tx.source || "unknown",
        pairAddress: "",
        tokenIn: tx.tokenTransfers?.[0]?.mint || "",
        tokenInSymbol: "",
        tokenOut: tx.tokenTransfers?.[1]?.mint || "",
        tokenOutSymbol: "",
        amountIn: tx.tokenTransfers?.[0]?.tokenAmount || 0,
        amountOut: tx.tokenTransfers?.[1]?.tokenAmount || 0,
        price: 0,
        priceUsd: 0,
        volumeUsd: tx.nativeTransfers?.[0]?.amount || 0,
        txHash: tx.signature || "",
        wallet: tx.feePayer || "",
        timestamp: tx.timestamp * 1000 || Date.now(),
      }));
    } catch {
      return [];
    }
  }

  async fetchNewPairsEVM(chain: Chain = "ethereum"): Promise<NewPairEvent[]> {
    const rpcUrl = chain === "ethereum" ? this.ethRpcUrl : this.baseRpcUrl;
    if (!rpcUrl) return [];

    try {
      // Uniswap V2 PairCreated event topic
      const pairCreatedTopic = "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";

      const { data } = await axios.post(rpcUrl, {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getLogs",
        params: [{
          topics: [pairCreatedTopic],
          fromBlock: "latest",
          toBlock: "latest",
        }],
      }, { timeout: 10000 });

      return (data?.result || []).map((log: any) => ({
        chain,
        dex: "uniswap",
        pairAddress: `0x${log.topics?.[2]?.slice(26)}` || "",
        token0: `0x${log.topics?.[1]?.slice(26)}` || "",
        token1: `0x${log.topics?.[2]?.slice(26)}` || "",
        token0Symbol: "",
        token1Symbol: "",
        baseToken: "",
        baseSymbol: "UNKNOWN",
        quoteToken: "",
        initialLiquidity: 0,
        deployer: log.address || "",
        txHash: log.transactionHash || "",
        timestamp: Date.now(),
      }));
    } catch (err: any) {
      logger.error(`${chain} DEX pair fetch failed: ${err.message}`);
      return [];
    }
  }
}

export const dexProvider = new DexDataProvider();

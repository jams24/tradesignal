import axios from "axios";
import { logger } from "../../utils/logger";
import type { Chain } from "../../types/signals";

export interface DexVolumeSignal {
  chain: Chain;
  dex: string;
  pairAddress: string;
  token0: string;
  token1: string;
  token0Symbol: string;
  token1Symbol: string;
  volumeUsd: number;
  swaps24h: number;
  isNew: boolean;
  createdAt: number;
}

export interface NewPairSignal {
  chain: Chain;
  dex: string;
  pairAddress: string;
  token0: string;
  token1: string;
  deployer: string;
  txHash: string;
  timestamp: number;
}

const RPC_LIST: Record<string, string[]> = {
  ethereum: [
    "https://eth.drpc.org",
    "https://ethereum-rpc.publicnode.com",
    "https://1rpc.io/eth",
  ],
  base: [
    "https://mainnet.base.org",
    "https://base-rpc.publicnode.com",
  ],
};

const UNISWAP_V2_FACTORY = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
const PAIR_CREATED_TOPIC = "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";
const SWAP_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";

// Known token addresses for symbol mapping
const TOKEN_SYMBOLS: Record<string, string> = {
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "WETH",
  "0xdac17f958d2ee523a2206206994597c13d831ec7": "USDT",
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "USDC",
  "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": "WBTC",
  "0x6b175474e89094c44da98b954eedeac495271d0f": "DAI",
  "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984": "UNI",
  "0x514910771af9ca656af840dff83e8264ecf986ca": "LINK",
  "0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9": "AAVE",
  "0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce": "SHIB",
  "0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2": "MKR",
  "0x0d8775f648430679a709e98d2b0cb6250d2887ef": "BAT",
  "0x111111111117dc0aa78b770fa6a738034120c302": "1INCH",
  "0x4fabb145d64652a948d72533023f6e7a623c7c53": "BUSD",
  "0x853d955acef822db058eb8505911ed77f175b99e": "FRAX",
};

function resolveSymbol(address: string): string {
  const key = address.toLowerCase();
  return TOKEN_SYMBOLS[key] || address.slice(0, 6) + "..." + address.slice(-4);
}

export class DexDataProvider {
  private rpcIndex: Record<string, number> = {};

  private async rpcCall(chain: Chain, method: string, params: any[]): Promise<any> {
    const rpcs = RPC_LIST[chain];
    if (!rpcs || rpcs.length === 0) return null;

    const startIdx = this.rpcIndex[chain] || 0;
    for (let i = 0; i < rpcs.length; i++) {
      const idx = (startIdx + i) % rpcs.length;
      try {
        const { data } = await axios.post(rpcs[idx], {
          jsonrpc: "2.0", id: 1, method, params,
        }, { timeout: 15000 });
        this.rpcIndex[chain] = idx;
        return data;
      } catch { /* next */ }
    }
    return null;
  }

  async getLatestBlock(chain: Chain): Promise<number> {
    const result = await this.rpcCall(chain, "eth_blockNumber", []);
    return parseInt(result?.result || "0x0", 16);
  }

  async fetchNewPairs(chain: Chain = "ethereum"): Promise<NewPairSignal[]> {
    const pairs: NewPairSignal[] = [];

    try {
      const latest = await this.getLatestBlock(chain);
      if (latest === 0) return pairs;

      const fromBlock = "0x" + Math.max(latest - 500, 0).toString(16);
      const toBlock = "0x" + latest.toString(16);

      const response = await this.rpcCall(chain, "eth_getLogs", [{
        fromBlock,
        toBlock,
        address: UNISWAP_V2_FACTORY,
        topics: [PAIR_CREATED_TOPIC],
      }]);

      const logs = response?.result || [];
      if (!Array.isArray(logs)) return pairs;

      for (const log of logs) {
        const token0 = "0x" + (log.topics?.[1] || "").slice(26);
        const token1 = "0x" + (log.topics?.[2] || "").slice(26);

        pairs.push({
          chain,
          dex: "uniswap_v2",
          pairAddress: log.address,
          token0,
          token1,
          deployer: "",
          txHash: log.transactionHash || "",
          timestamp: Date.now(),
        });

        if (pairs.length >= 10) break;
      }
    } catch (err: any) {
      logger.error(`DEX pair fetch failed: ${err.message}`);
    }

    return pairs;
  }

  async fetchVolumeSpikes(chain: Chain = "ethereum"): Promise<DexVolumeSignal[]> {
    const signals: DexVolumeSignal[] = [];

    try {
      const latest = await this.getLatestBlock(chain);
      if (latest === 0) return signals;

      const fromBlock = "0x" + Math.max(latest - 300, 0).toString(16);
      const toBlock = "0x" + latest.toString(16);

      const response = await this.rpcCall(chain, "eth_getLogs", [{
        fromBlock,
        toBlock,
        topics: [SWAP_TOPIC],
      }]);

      const logs = response?.result || [];
      if (!Array.isArray(logs)) return signals;

      const pairVolumes = new Map<string, {
        swapCount: number;
        totalUsd: number;
        token0: string;
        token1: string;
        sym0: string;
        sym1: string;
      }>();

      for (const log of logs) {
        if (pairVolumes.size > 100) break;

        const data = log.data || "0x";
        if (data.length < 258) continue;

        const amount0 = parseInt("0x" + data.slice(2, 66), 16) || 0;
        const amount1 = parseInt("0x" + data.slice(66, 130), 16) || 0;
        const token0 = "0x" + (log.topics?.[1] || "0").slice(26).toLowerCase();
        const token1 = "0x" + (log.topics?.[2] || "0").slice(26).toLowerCase();

        const sym0 = TOKEN_SYMBOLS[token0];
        const sym1 = TOKEN_SYMBOLS[token1];

        // Only track pairs where at least one token has a known price
        if (!sym0 && !sym1) continue;

        // Estimate USD value
        let volumeUsd = 0;
        if (sym0 === "WETH" || sym0 === "ETH") {
          volumeUsd = (amount0 / 1e18) * 2500;
        } else if (sym0 === "USDT" || sym0 === "USDC" || sym0 === "DAI" || sym0 === "BUSD" || sym0 === "FRAX") {
          volumeUsd = amount0 / 1e6;
        } else if (sym1 === "WETH" || sym1 === "ETH") {
          volumeUsd = (amount1 / 1e18) * 2500;
        } else if (sym1 === "USDT" || sym1 === "USDC" || sym1 === "DAI" || sym1 === "BUSD" || sym1 === "FRAX") {
          volumeUsd = amount1 / 1e6;
        } else {
          continue; // couldn't estimate
        }

        if (volumeUsd < 1000) continue;

        const pairKey = token0 < token1 ? `${token0}_${token1}` : `${token1}_${token0}`;
        const existing = pairVolumes.get(pairKey) || {
          swapCount: 0, totalUsd: 0, token0, token1, sym0: sym0 || "", sym1: sym1 || "",
        };

        existing.swapCount++;
        existing.totalUsd += volumeUsd;
        pairVolumes.set(pairKey, existing);
      }

      for (const [, data] of pairVolumes) {
        if (data.totalUsd < 10000) continue; // >$10k in 1hr

        const primarySymbol = data.sym0 && data.sym0 !== "WETH" ? data.sym0 :
                              data.sym1 && data.sym1 !== "WETH" ? data.sym1 :
                              data.sym0 || resolveSymbol(data.token0);

        signals.push({
          chain,
          dex: "uniswap_v2",
          pairAddress: "",
          token0: data.token0,
          token1: data.token1,
          token0Symbol: data.sym0 || resolveSymbol(data.token0),
          token1Symbol: data.sym1 || resolveSymbol(data.token1),
          volumeUsd: data.totalUsd,
          swaps24h: data.swapCount,
          isNew: false,
          createdAt: Date.now(),
        });
      }

      signals.sort((a, b) => b.volumeUsd - a.volumeUsd);
    } catch (err: any) {
      logger.error(`DEX volume spike fetch failed: ${err.message}`);
    }

    return signals.slice(0, 15);
  }
}

export const dexProvider = new DexDataProvider();

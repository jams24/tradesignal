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
};

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

      // Look at last ~1 hour of blocks (300 blocks on ETH)
      const fromBlock = "0x" + Math.max(latest - 300, 0).toString(16);
      const toBlock = "0x" + latest.toString(16);

      const response = await this.rpcCall(chain, "eth_getLogs", [{
        fromBlock,
        toBlock,
        topics: [SWAP_TOPIC],
      }]);

      const logs = response?.result || [];
      if (!Array.isArray(logs)) return signals;

      // Aggregate volume by pair address
      const pairVolumes = new Map<string, {
        pairAddress: string;
        swapCount: number;
        totalUsd: number;
        token0: string;
        token1: string;
      }>();

      for (const log of logs) {
        const pairAddress = log.address;
        const existing = pairVolumes.get(pairAddress) || {
          pairAddress,
          swapCount: 0,
          totalUsd: 0,
          token0: "",
          token1: "",
        };

        // Parse amounts from data (amount0In, amount1In, amount0Out, amount1Out)
        const data = log.data || "0x";
        if (data.length < 130) continue; // skip malformed

        const amount0In = parseInt("0x" + data.slice(2, 66), 16) || 0;
        const amount0Out = parseInt("0x" + data.slice(130, 194), 16) || 0;
        const amount1In = parseInt("0x" + data.slice(66, 130), 16) || 0;
        const amount1Out = parseInt("0x" + data.slice(194, 258), 16) || 0;

        // Roughly estimate: if token0 is WETH/USDT, use that for USD value
        const volume0 = amount0In + amount0Out;
        const volume1 = amount1In + amount1Out;

        // Estimate USD (rough — 18 decimal tokens are likely ETH, 6 decimal are stables)
        const volumeUsd = volume0 > volume1 ? volume0 / 1e18 * 2500 : volume1 / 1e6;

        existing.swapCount++;
        existing.totalUsd += volumeUsd;
        existing.token0 = "0x" + (log.topics?.[1] || "0").slice(26);
        existing.token1 = "0x" + (log.topics?.[2] || "0").slice(26);

        pairVolumes.set(pairAddress, existing);
      }

      // Filter to pairs with > $50k volume in the last hour
      for (const [, data] of pairVolumes) {
        if (data.totalUsd < 50000) continue;

        signals.push({
          chain,
          dex: "uniswap_v2",
          pairAddress: data.pairAddress,
          token0: data.token0,
          token1: data.token1,
          token0Symbol: TOKEN_SYMBOLS[data.token0.toLowerCase()] || "TOKEN",
          token1Symbol: TOKEN_SYMBOLS[data.token1.toLowerCase()] || "TOKEN",
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

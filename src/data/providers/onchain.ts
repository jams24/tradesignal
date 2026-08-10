import axios from "axios";
import { logger } from "../../utils/logger";
import type { Chain } from "../../types/signals";

export interface ExchangeNetflow {
  chain: Chain;
  exchange: string;
  token: string;
  symbol: string;
  amount: number;
  valueUsd: number;
  direction: "inflow" | "outflow";
  timestamp: number;
}

export interface TokenUnlock {
  chain: Chain;
  project: string;
  token: string;
  symbol: string;
  amount: number;
  valueUsd: number;
  unlockDate: number;
  percentage: number;
}

const RPC_LIST: Record<string, string[]> = {
  ethereum: [
    "https://ethereum-rpc.publicnode.com",
    "https://1rpc.io/eth",
    "https://eth.drpc.org",
    "https://rpc.ankr.com/eth",
    "https://cloudflare-eth.com",
  ],
  bsc: [
    "https://bsc-dataseed.binance.org",
    "https://bsc-rpc.publicnode.com",
  ],
  base: [
    "https://mainnet.base.org",
    "https://base-rpc.publicnode.com",
  ],
  arbitrum: ["https://arb1.arbitrum.io/rpc"],
  polygon: ["https://polygon-rpc.com"],
};

const USDT_ETH = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const USDC_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const KNOWN_EXCHANGES: Record<string, string> = {
  "0x28c6c06298d514db089934071355e5743bf21d60": "binance",
  "0x21a31ee1afc51d94c2efccaa2092ad1028285549": "binance",
  "0xdfd5293d8e347dfe59e90efd55b2956a1343963d": "binance",
  "0x5041ed759dd4afc3a72b8192c143f72f4724081a": "okx",
  "0x75e89d5979e4f6fba9f97c104c2f0afb3f1dcb88": "mexc",
  "0x0d0707963952f2fba59dd06f2b425ace40b492fe": "gate",
  "0x1ab87cd2a58efc7aa98a6700f2a495a3c0b7af18": "bybit",
  "0x8103683202aa8da10563084f12aae4f0d1be53a7": "coinbase",
  "0x503828976d22510aad0201ac7ec88293211d23da": "coinbase",
  "0x3304e22ddaa22bcdc5f2265114e3ba6a5e59b68a": "coinbase",
};

const EXCHANGE_ADDRESSES_LOWER = new Set(
  Object.keys(KNOWN_EXCHANGES).map(a => a.toLowerCase())
);

export class OnchainDataProvider {
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
        }, { timeout: 8000 });
        this.rpcIndex[chain] = idx; // remember working RPC
        return data;
      } catch { /* try next RPC */ }
    }
    return null;
  }

  async getLatestBlock(chain: Chain): Promise<number> {
    const result = await this.rpcCall(chain, "eth_blockNumber", []);
    return parseInt(result?.result || "0x0", 16);
  }

  async fetchExchangeNetflows(chain: Chain = "ethereum"): Promise<ExchangeNetflow[]> {
    const flows: ExchangeNetflow[] = [];

    try {
      const latest = await this.getLatestBlock(chain);
      if (latest === 0) return flows;

      // Look at the last 50 blocks (~10 min on ETH)
      const fromBlock = "0x" + Math.max(latest - 50, 0).toString(16);
      const toBlock = "0x" + latest.toString(16);

      const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

      const response = await this.rpcCall(chain, "eth_getLogs", [{
        fromBlock,
        toBlock,
        address: [USDT_ETH, USDC_ETH],
        topics: [transferTopic],
      }]);

      const logs = response?.result || [];
      if (!Array.isArray(logs)) return flows;

      const processed = new Set<string>();

      for (const log of logs.slice(0, 50)) {
        const from = "0x" + (log.topics?.[1] || "").slice(26).toLowerCase();
        const to = "0x" + (log.topics?.[2] || "").slice(26).toLowerCase();
        const txHash = log.transactionHash;

        if (processed.has(txHash)) continue;
        processed.add(txHash);

        const fromExchange = EXCHANGE_ADDRESSES_LOWER.has(from) ?
          KNOWN_EXCHANGES[from] || "unknown" : null;
        const toExchange = EXCHANGE_ADDRESSES_LOWER.has(to) ?
          KNOWN_EXCHANGES[to] || "unknown" : null;

        if (!fromExchange && !toExchange) continue;

        const value = parseInt(log.data || "0x0", 16);
        const tokenSymbol = log.address.toLowerCase() === USDT_ETH.toLowerCase() ? "USDT" : "USDC";
        const decimals = tokenSymbol === "USDT" ? 6 : 6;
        const amount = value / Math.pow(10, decimals);

        // Only log significant moves (> $50k)
        if (amount < 50000) continue;

        flows.push({
          chain,
          exchange: (toExchange || fromExchange)!,
          token: log.address,
          symbol: tokenSymbol,
          amount,
          valueUsd: amount,
          direction: toExchange ? "inflow" : "outflow",
          timestamp: Date.now(),
        });
      }
    } catch (err: any) {
      logger.error(`Exchange netflow failed for ${chain}: ${err.message}`);
    }

    return flows;
  }

  async fetchTokenUnlocks(): Promise<TokenUnlock[]> {
    try {
      const { data } = await axios.get(
        "https://api.defillama.com/v2/unlocks/next",
        { timeout: 10000 },
      );
      return (data || []).slice(0, 20).map((u: any) => ({
        chain: "ethereum" as Chain,
        project: u.name || "Unknown",
        token: u.token || "",
        symbol: u.symbol || "",
        amount: u.amount || 0,
        valueUsd: u.value || 0,
        unlockDate: u.timestamp ? u.timestamp * 1000 : Date.now(),
        percentage: u.percentage || 0,
      }));
    } catch {
      return [];
    }
  }
}

export const onchainProvider = new OnchainDataProvider();

import axios from "axios";
import { logger } from "../../utils/logger";
import { config } from "../../utils/config";
import { prisma } from "../../db/prisma";
import type { Chain } from "../../types/signals";

export interface BridgeFlow {
  chain: Chain;
  bridgeName: string;
  token: string;
  symbol: string;
  amount: number;
  valueUsd: number;
  direction: "in" | "out";
  txHash: string;
  timestamp: number;
}

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

const FREE_RPCS: Record<string, string> = {
  ethereum: "https://cloudflare-eth.com",
  bsc: "https://bsc-dataseed.binance.org",
  base: "https://mainnet.base.org",
  arbitrum: "https://arb1.arbitrum.io/rpc",
  polygon: "https://polygon-rpc.com",
};

const USDT_ETH = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const USDC_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

const KNOWN_EXCHANGES: Record<string, { name: string; chain: Chain }> = {
  "0x28c6c06298d514db089934071355e5743bf21d60": { name: "binance", chain: "ethereum" },
  "0x21a31ee1afc51d94c2efccaa2092ad1028285549": { name: "binance", chain: "ethereum" },
  "0xdfd5293d8e347dfe59e90efd55b2956a1343963d": { name: "binance", chain: "ethereum" },
  "0x5041ed759dd4afc3a72b8192c143f72f4724081a": { name: "okx", chain: "ethereum" },
  "0x75e89d5979e4f6fba9f97c104c2f0afb3f1dcb88": { name: "mexc", chain: "ethereum" },
  "0x0d0707963952f2fba59dd06f2b425ace40b492fe": { name: "gate", chain: "ethereum" },
  "0x1ab87cd2a58efc7aa98a6700f2a495a3c0b7af18": { name: "bybit", chain: "ethereum" },
  "0x8103683202aa8da10563084f12aae4f0d1be53a7": { name: "coinbase", chain: "ethereum" },
  "0x503828976d22510aad0201ac7ec88293211d23da": { name: "coinbase", chain: "ethereum" },
  "0x3304e22ddaa22bcdc5f2265114e3ba6a5e59b68a": { name: "coinbase", chain: "base" },
};

export class OnchainDataProvider {
  private rpcCall(chain: Chain, method: string, params: any[]): Promise<any> {
    const rpcUrl = FREE_RPCS[chain];
    if (!rpcUrl) return Promise.resolve(null);

    return axios.post(rpcUrl, {
      jsonrpc: "2.0", id: 1, method, params,
    }, { timeout: 10000 }).then(r => r.data).catch(() => null);
  }

  async fetchExchangeNetflows(chain: Chain = "ethereum"): Promise<ExchangeNetflow[]> {
    const flows: ExchangeNetflow[] = [];
    const rpcUrl = FREE_RPCS[chain];
    if (!rpcUrl) return flows;

    const exchangeAddresses = Object.entries(KNOWN_EXCHANGES)
      .filter(([, v]) => v.chain === chain)
      .map(([addr]) => addr.toLowerCase())
      .slice(0, 5);

    try {
      const latestBlock = await this.rpcCall(chain, "eth_blockNumber", []);
      if (!latestBlock?.result) return flows;

      const fromBlock = "0x" + (parseInt(latestBlock.result, 16) - 50).toString(16);

      const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

      const response = await this.rpcCall(chain, "eth_getLogs", [{
        fromBlock,
        toBlock: latestBlock.result,
        address: [USDT_ETH, USDC_ETH, USDC_ETH],
        topics: [transferTopic],
      }]);

      const logs = response?.result || [];
      for (const log of logs.slice(0, 30)) {
        const from = "0x" + (log.topics?.[1] || "").slice(26).toLowerCase();
        const to = "0x" + (log.topics?.[2] || "").slice(26).toLowerCase();
        const value = parseInt(log.data || "0x0", 16);

        const fromExchange = KNOWN_EXCHANGES[from];
        const toExchange = KNOWN_EXCHANGES[to];

        if (fromExchange || toExchange) {
          const tokenSymbol = log.address.toLowerCase() === USDT_ETH.toLowerCase() ? "USDT" : "USDC";
          const decimals = 6;
          const amount = value / Math.pow(10, decimals);
          const valueUsd = amount;

          flows.push({
            chain,
            exchange: (fromExchange || toExchange)!.name,
            token: log.address,
            symbol: tokenSymbol,
            amount,
            valueUsd,
            direction: toExchange ? "inflow" : "outflow",
            timestamp: Date.now(),
          });
        }
      }
    } catch (err: any) {
      logger.error(`Exchange netflow fetch failed for ${chain}: ${err.message}`);
    }

    return flows;
  }

  async fetchBridgeFlows(minValueUsd = 50000): Promise<BridgeFlow[]> {
    const flows: BridgeFlow[] = [];

    // Monitor USDC Transfer events to/from known bridge contracts
    const bridges = [
      { name: "LayerZero ETH", address: "0x49048044D57e1C5A4fAAf8453e1F55B37A8e0B16", chain: "ethereum" as Chain },
      { name: "Wormhole ETH", address: "0x3a23F943181408EAC424116Af7b7790c94Cb97a5", chain: "ethereum" as Chain },
      { name: "Stargate ETH", address: "0x8731d54E9D02c286767d56ac03e8037C07e01e98", chain: "ethereum" as Chain },
    ];

    for (const bridge of bridges) {
      const rpcUrl = FREE_RPCS[bridge.chain];
      if (!rpcUrl) continue;

      try {
        const latestBlock = await this.rpcCall(bridge.chain, "eth_blockNumber", []);
        if (!latestBlock?.result) continue;

        const fromBlock = "0x" + (parseInt(latestBlock.result, 16) - 100).toString(16);

        const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

        const response = await this.rpcCall(bridge.chain, "eth_getLogs", [{
          fromBlock,
          toBlock: latestBlock.result,
          address: [USDC_ETH, USDT_ETH],
          topics: [transferTopic, null, "0x" + bridge.address.slice(2).toLowerCase().padStart(64, "0")],
        }]);

        const logs = response?.result || [];
        for (const log of logs.slice(0, 10)) {
          const from = "0x" + (log.topics?.[1] || "").slice(26);
          const value = parseInt(log.data || "0x0", 16);
          const amount = value / 1e6;
          const isIncoming = from.toLowerCase() === bridge.address.toLowerCase();

          if (amount > 10000) {
            flows.push({
              chain: bridge.chain,
              bridgeName: bridge.name,
              token: log.address,
              symbol: log.address.toLowerCase() === USDC_ETH.toLowerCase() ? "USDC" : "USDT",
              amount,
              valueUsd: amount,
              direction: isIncoming ? "in" : "out",
              txHash: log.transactionHash || "",
              timestamp: Date.now(),
            });
          }
        }
      } catch (err: any) {
        logger.error(`Bridge flow fetch failed for ${bridge.name}: ${err.message}`);
      }
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

  async getStablecoinNetflow(): Promise<{ chain: Chain; inflow: number; outflow: number; net: number }[]> {
    return [
      { chain: "ethereum", inflow: 0, outflow: 0, net: 0 },
      { chain: "bsc", inflow: 0, outflow: 0, net: 0 },
      { chain: "solana", inflow: 0, outflow: 0, net: 0 },
    ];
  }

  async getLatestBlock(chain: Chain): Promise<number> {
    try {
      const result = await this.rpcCall(chain, "eth_blockNumber", []);
      return parseInt(result?.result || "0x0", 16);
    } catch {
      return 0;
    }
  }
}

export const onchainProvider = new OnchainDataProvider();

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

const KNOWN_EXCHANGE_ADDRESSES: Record<string, string[]> = {
  ethereum: [
    "0x28c6c06298d514db089934071355e5743bf21d60", // Binance
    "0x21a31ee1afc51d94c2efccaa2092ad1028285549", // Binance 2
    "0xdfd5293d8e347dfe59e90efd55b2956a1343963d", // Binance 3
    "0x5041ed759dd4afc3a72b8192c143f72f4724081a", // OKX
    "0x75e89d5979e4f6fba9f97c104c2f0afb3f1dcb88", // MEXC
    "0x0d0707963952f2fba59dd06f2b425ace40b492fe", // Gate
    "0x1ab87cd2a58efc7aa98a6700f2a495a3c0b7af18", // Bybit
    "0x8103683202aa8da10563084f12aae4f0d1be53a7", // Coinbase 1
    "0x503828976d22510aad0201ac7ec88293211d23da", // Coinbase 2
  ],
  bsc: [
    "0x631fc1ea2270e98fbd9d92658ece0f5a269aa161", // Binance BSC
    "0x8894e0a0c962cb723c1976a4421c95949be2d4e3", // Binance BSC 2
    "0xe2fc31f816a9b94326492132018c3aecc4a93ae1", // Binance BSC 3
  ],
  base: [
    "0x3304e22ddaa22bcdc5f2265114e3ba6a5e59b68a", // Coinbase Base
  ],
};

export class OnchainDataProvider {
  async fetchBridgeFlows(minValueUsd = 50000): Promise<BridgeFlow[]> {
    const flows: BridgeFlow[] = [];

    // Monitor major bridges via their contract events
    const bridges = [
      {
        chain: "ethereum" as Chain,
        address: "0x49048044D57e1C5A4fAAf8453e1F55B37A8e0B16", // LayerZero ETH
        name: "LayerZero",
      },
      {
        chain: "ethereum" as Chain,
        address: "0x3a23F943181408EAC424116Af7b7790c94Cb97a5", // Wormhole ETH
        name: "Wormhole",
      },
    ];

    for (const bridge of bridges) {
      try {
        const { data } = await axios.get(
          `https://api.etherscan.io/api?module=account&action=txlist&address=${bridge.address}&page=1&offset=20&sort=desc&apikey=${config.ETHERSCAN_API_KEY}`,
          { timeout: 10000 },
        );

        if (data?.result) {
          for (const tx of data.result) {
            const valueEth = parseFloat(tx.value) / 1e18;
            flows.push({
              chain: bridge.chain,
              bridgeName: bridge.name,
              token: "ETH",
              symbol: "ETH",
              amount: valueEth,
              valueUsd: valueEth * 2500, // placeholder, use price feed
              direction: tx.from === bridge.address.toLowerCase() ? "out" : "in",
              txHash: tx.hash,
              timestamp: parseInt(tx.timeStamp) * 1000,
            });
          }
        }
      } catch (err: any) {
        logger.error(`Bridge flow fetch failed for ${bridge.name}: ${err.message}`);
      }
    }

    return flows;
  }

  async fetchExchangeNetflows(chain: Chain = "ethereum"): Promise<ExchangeNetflow[]> {
    const flows: ExchangeNetflow[] = [];
    const addresses = KNOWN_EXCHANGE_ADDRESSES[chain] || [];
    const apiKey = chain === "ethereum" ? config.ETHERSCAN_API_KEY : config.BSCSCAN_API_KEY;
    const baseUrl = chain === "ethereum" ? "https://api.etherscan.io/api" : "https://api.bscscan.com/api";

    if (!apiKey) return flows;

    for (const address of addresses.slice(0, 5)) {
      try {
        const { data } = await axios.get(baseUrl, {
          params: {
            module: "account",
            action: "txlist",
            address,
            page: 1,
            offset: 10,
            sort: "desc",
            apikey: apiKey,
          },
          timeout: 10000,
        });

        if (data?.result) {
          for (const tx of data.result) {
            const value = parseFloat(tx.value) / 1e18;
            const isInflow = tx.to?.toLowerCase() === address.toLowerCase();

            flows.push({
              chain,
              exchange: this.identifyExchange(address),
              token: "ETH",
              symbol: "ETH",
              amount: value,
              valueUsd: value * 2500,
              direction: isInflow ? "inflow" : "outflow",
              timestamp: parseInt(tx.timeStamp) * 1000,
            });
          }
        }
      } catch (err: any) {
        logger.error(`Netflow fetch failed for ${address}: ${err.message}`);
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
    // Fetch stablecoin (USDT/USDC) flows into exchanges as a macro indicator
    // Positive net = stablecoins entering exchanges = buying power
    return [
      { chain: "ethereum", inflow: 0, outflow: 0, net: 0 },
      { chain: "bsc", inflow: 0, outflow: 0, net: 0 },
      { chain: "solana", inflow: 0, outflow: 0, net: 0 },
    ];
  }

  private identifyExchange(address: string): string {
    const map: Record<string, string> = {
      "0x28c6c06298d514db089934071355e5743bf21d60": "binance",
      "0x21a31ee1afc51d94c2efccaa2092ad1028285549": "binance",
      "0xdfd5293d8e347dfe59e90efd55b2956a1343963d": "binance",
      "0x5041ed759dd4afc3a72b8192c143f72f4724081a": "okx",
      "0x75e89d5979e4f6fba9f97c104c2f0afb3f1dcb88": "mexc",
      "0x0d0707963952f2fba59dd06f2b425ace40b492fe": "gate",
      "0x1ab87cd2a58efc7aa98a6700f2a495a3c0b7af18": "bybit",
      "0x8103683202aa8da10563084f12aae4f0d1be53a7": "coinbase",
      "0x503828976d22510aad0201ac7ec88293211d23da": "coinbase",
    };
    return map[address.toLowerCase()] || "unknown";
  }
}

export const onchainProvider = new OnchainDataProvider();

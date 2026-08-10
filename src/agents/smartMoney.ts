import { logger } from "../utils/logger";
import { config } from "../utils/config";
import { prisma } from "../db/prisma";
import type { TradeSignal, AgentResult } from "../types/signals";

interface SmartWallet {
  id: string;
  address: string;
  chain: string;
  label: string;
  roi: number;
  winRate: number;
  tradeCount: number;
  recentTrades: Array<{
    tokenAddress: string;
    tokenSymbol: string;
    direction: "buy" | "sell";
    amount: number;
    valueUsd: number;
    timestamp: number;
  }>;
  weight: number; // how much we weight this wallet's signals
}

export class SmartMoneyAgent {
  private name = "SMART_MONEY";
  private readonly MIN_SMART_WALLETS = 2; // min # smart wallets buying same token
  private readonly MIN_WALLET_ROI = 50; // min ROI % to be considered
  private readonly MIN_TRADE_COUNT = 10;

  async analyze(): Promise<AgentResult<TradeSignal>> {
    const startTime = Date.now();
    const signals: TradeSignal[] = [];

    try {
      const smartWallets = await this.getSmartWallets();
      const tokenBuys = new Map<string, {
        symbol: string;
        wallets: SmartWallet[];
        totalValue: number;
        avgWalletWeight: number;
      }>();

      for (const wallet of smartWallets) {
        const trades: any[] = await this.getRecentTrades(wallet.id);

        for (const trade of trades) {
          if (trade.direction !== "buy") continue;

          const key = `${trade.chain || wallet.chain}:${trade.tokenAddress}`;
          const existing = tokenBuys.get(key) || {
            symbol: trade.tokenSymbol,
            wallets: [] as SmartWallet[],
            totalValue: 0,
            avgWalletWeight: 0,
          };

          existing.wallets.push(wallet);
          existing.totalValue += trade.valueUsd;
          tokenBuys.set(key, existing);
        }
      }

      // Generate signals where 2+ smart wallets buying the same token
      for (const [key, data] of tokenBuys) {
        if (data.wallets.length < this.MIN_SMART_WALLETS) continue;

        const avgWeight = data.wallets.reduce((s, w) => s + w.weight, 0) / data.wallets.length;
        const score = this.calculateSmartMoneyScore(data.wallets.length, data.totalValue, avgWeight);

        if (score >= 50) {
          signals.push(this.buildSignal(key, data, score));
        }
      }

      logger.info({
        agent: this.name,
        smartWallets: smartWallets.length,
        uniqueTokens: tokenBuys.size,
        signalsGenerated: signals.length,
      }, `${this.name} scan complete`);
    } catch (err: any) {
      logger.error({ agent: this.name, err: err.message }, `${this.name} failed`);
    }

    return {
      agent: this.name,
      signals,
      metrics: {
        candidatesAnalyzed: 0,
        signalsGenerated: signals.length,
        durationMs: Date.now() - startTime,
      },
    };
  }

  private async getSmartWallets(): Promise<SmartWallet[]> {
    try {
      const wallets = await prisma.wallet.findMany({
        where: {
          category: "smart_money",
          roi: { gte: this.MIN_WALLET_ROI },
          tradeCount: { gte: this.MIN_TRADE_COUNT },
        },
        orderBy: { roi: "desc" },
        take: 100,
      });

      return wallets.map(w => ({
        id: w.id,
        address: w.address,
        chain: w.chain,
        label: w.label || w.address.slice(0, 8),
        roi: w.roi || 0,
        winRate: w.winRate || 0,
        tradeCount: w.tradeCount,
        recentTrades: [],
        weight: this.calculateWalletWeight(w.roi || 0, w.winRate || 0, w.tradeCount),
      }));
    } catch {
      return [];
    }
  }

  private calculateWalletWeight(roi: number, winRate: number, tradeCount: number): number {
    let weight = 0;
    weight += Math.min(roi / 100, 1) * 0.4;   // ROI contribution
    weight += (winRate / 100) * 0.3;           // Win rate contribution
    weight += Math.min(tradeCount / 100, 1) * 0.3; // Experience
    return Math.min(weight, 1);
  }

  private async getRecentTrades(walletId: string): Promise<any[]> {
    try {
      return await prisma.walletTrade.findMany({
        where: { walletId },
        orderBy: { timestamp: "desc" },
        take: 50,
      });
    } catch {
      return [];
    }
  }

  private calculateSmartMoneyScore(
    walletCount: number,
    totalValue: number,
    avgWeight: number,
  ): number {
    let score = 0;
    score += Math.min(walletCount * 15, 45);   // 15 pts per wallet, max 45
    score += Math.min(totalValue / 1000, 30);   // value contribution, max 30
    score += avgWeight * 25;                     // wallet quality, max 25
    return Math.min(score, 100);
  }

  private buildSignal(
    key: string,
    data: { symbol: string; wallets: SmartWallet[]; totalValue: number },
    score: number,
  ): TradeSignal {
    const [chain] = key.split(":");
    const walletNames = data.wallets.map(w => w.label).join(", ");
    const confidence = Math.min(score + 10, 95);

    return {
      type: "SMART_MONEY",
      symbol: data.symbol,
      chain: chain as any,
      direction: "long",
      confidence,
      score,
      leverage: 3,
      positionSize: Math.min(data.totalValue, config.MAX_POSITION_SIZE_USD),
      catalyst: `${data.wallets.length} profitable wallets buying ${data.symbol}`,
      thesis: `Smart wallets (${walletNames}) accumulating ${data.symbol}. ` +
             `Total buy volume: $${data.totalValue.toLocaleString()}. ` +
             `Following high-ROI traders with proven track records.`,
      sources: ["SMART_MONEY"],
      agentScores: { SMART_MONEY: score },
      smartWalletsBuying: data.wallets.length,
      smartWalletConfidence: confidence,
      rawData: {
        wallets: data.wallets.map(w => ({ address: w.address, roi: w.roi, winRate: w.winRate })),
      },
    };
  }
}

export const smartMoneyAgent = new SmartMoneyAgent();

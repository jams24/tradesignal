import { logger } from "../utils/logger";
import { config } from "../utils/config";
import { onchainProvider } from "../data/providers/onchain";
import { prisma } from "../db/prisma";
import type { TradeSignal, AgentResult, Chain } from "../types/signals";

interface OnchainSignal {
  symbol: string;
  chain: Chain;
  signalType: "EXCHANGE_OUTFLOW" | "EXCHANGE_INFLOW" | "TOKEN_UNLOCK";
  direction: "long" | "short";
  confidence: number;
  score: number;
  details: string;
  valueUsd: number;
}

export class OnchainIntelAgent {
  private name = "ONCHAIN_INTEL";
  private processedTxHashes = new Set<string>();

  async analyze(): Promise<AgentResult<TradeSignal>> {
    const startTime = Date.now();
    const signals: TradeSignal[] = [];
    const candidates: OnchainSignal[] = [];

    try {
      // 1. Exchange netflows (bulk USDT/USDC transfers)
      const exchangeFlows = await onchainProvider.fetchExchangeNetflows("ethereum");

      for (const flow of exchangeFlows) {
        if (this.processedTxHashes.has(flow.token + flow.amount)) continue;
        this.processedTxHashes.add(flow.token + flow.amount);

        if (flow.direction === "outflow" && flow.valueUsd > 50000) {
          candidates.push({
            symbol: flow.symbol,
            chain: flow.chain,
            signalType: "EXCHANGE_OUTFLOW",
            direction: "long",
            confidence: 65,
            score: 60,
            details: `${flow.symbol} outflow from ${flow.exchange}: $${(flow.amount / 1000000).toFixed(1)}M`,
            valueUsd: flow.valueUsd,
          });
        } else if (flow.direction === "inflow" && flow.valueUsd > 200000) {
          candidates.push({
            symbol: flow.symbol,
            chain: flow.chain,
            signalType: "EXCHANGE_INFLOW",
            direction: "short",
            confidence: 60,
            score: 55,
            details: `${flow.symbol} inflow to ${flow.exchange}: $${(flow.amount / 1000000).toFixed(1)}M`,
            valueUsd: flow.valueUsd,
          });
        }
      }

      // 2. Token unlocks
      const tokenUnlocks = await onchainProvider.fetchTokenUnlocks();
      for (const unlock of tokenUnlocks) {
        if (unlock.valueUsd > 500000) {
          const daysUntil = (unlock.unlockDate - Date.now()) / (86400 * 1000);
          if (daysUntil <= 7 && daysUntil >= 0) {
            candidates.push({
              symbol: unlock.symbol,
              chain: unlock.chain,
              signalType: "TOKEN_UNLOCK",
              direction: "short",
              confidence: 70,
              score: 65,
              details: `${unlock.project}: $${(unlock.valueUsd / 1000000).toFixed(1)}M unlock in ${daysUntil.toFixed(0)}d (${unlock.percentage}% supply)`,
              valueUsd: unlock.valueUsd,
            });
          }
        }
      }

      // Convert to signals
      for (const c of candidates) {
        signals.push(this.buildSignal(c));
      }

      // Persist events to DB
      for (const flow of exchangeFlows.slice(0, 20)) {
        try {
          await prisma.onchainEvent.create({
            data: {
              chain: flow.chain,
              eventType: flow.direction === "outflow" ? "exchange_outflow" : "exchange_inflow",
              symbol: flow.symbol,
              amount: flow.amount,
              valueUsd: flow.valueUsd,
              fromAddress: "",
              toAddress: "",
              txHash: "",
              timestamp: new Date(flow.timestamp),
            },
          });
        } catch { /* skip duplicates */ }
      }

      const metrics = {
        candidatesAnalyzed: candidates.length,
        signalsGenerated: signals.length,
        durationMs: Date.now() - startTime,
      };

      const totalFlows = exchangeFlows.length + tokenUnlocks.length;
      if (totalFlows > 0 || signals.length > 0) {
        logger.info({
          agent: this.name,
          exchangeFlows: exchangeFlows.length,
          tokenUnlocks: tokenUnlocks.length,
          signalsGenerated: signals.length,
        }, `${this.name} scan complete`);
      }

      return { agent: this.name, signals, metrics };
    } catch (err: any) {
      logger.error({ agent: this.name, err: err.message }, `${this.name} failed`);
      return {
        agent: this.name,
        signals: [],
        metrics: { candidatesAnalyzed: 0, signalsGenerated: 0, durationMs: Date.now() - startTime },
      };
    }
  }

  private buildSignal(c: OnchainSignal): TradeSignal {
    const flowDesc = c.signalType === "EXCHANGE_OUTFLOW"
      ? `${c.symbol} WITHDRAWAL from ${c.details.split(": ")[1] || ""}`
      : c.signalType === "EXCHANGE_INFLOW"
        ? `${c.symbol} DEPOSIT to ${c.details.split(": ")[1] || ""}`
        : c.details;

    return {
      type: "ONCHAIN",
      symbol: c.symbol,
      chain: c.chain,
      direction: c.direction,
      confidence: c.confidence,
      score: c.score,
      leverage: 2,
      catalyst: flowDesc,
      thesis: "",
      sources: ["ONCHAIN"],
      agentScores: { ONCHAIN_INTEL: c.score },
      exchangeNetflow: c.signalType.includes("EXCHANGE") ? c.valueUsd : undefined,
      rawData: {
        signalType: c.signalType,
        valueUsd: c.valueUsd,
        details: c.details,
      },
    };
  }
}

export const onchainIntelAgent = new OnchainIntelAgent();

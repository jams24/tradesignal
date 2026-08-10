import { logger } from "../utils/logger";
import { config } from "../utils/config";
import { onchainProvider } from "../data/providers/onchain";
import { prisma } from "../db/prisma";
import type { TradeSignal, AgentResult, Chain } from "../types/signals";

interface OnchainSignal {
  symbol: string;
  chain: Chain;
  signalType: "BRIDGE_INFLOW" | "EXCHANGE_OUTFLOW" | "TOKEN_UNLOCK" | "ACCUMULATION" | "WHALE_BUY";
  confidence: number;
  score: number;
  details: string;
  valueUsd: number;
}

export class OnchainIntelAgent {
  private name = "ONCHAIN_INTEL";

  async analyze(): Promise<AgentResult<TradeSignal>> {
    const startTime = Date.now();
    const signals: TradeSignal[] = [];
    const candidates: OnchainSignal[] = [];

    try {
      const [bridgeFlows, exchangeFlows, tokenUnlocks] = await Promise.all([
        onchainProvider.fetchBridgeFlows(),
        onchainProvider.fetchExchangeNetflows("ethereum"),
        onchainProvider.fetchTokenUnlocks(),
      ]);

      // 1. Bridge inflows = money entering chain = bullish chain narrative
      const chainFlows = new Map<string, { inflow: number; outflow: number }>();
      for (const flow of bridgeFlows) {
        const curr = chainFlows.get(flow.chain) || { inflow: 0, outflow: 0 };
        if (flow.direction === "in") curr.inflow += flow.valueUsd;
        else curr.outflow += flow.valueUsd;
        chainFlows.set(flow.chain, curr);
      }

      for (const [chain, flows] of chainFlows) {
        const net = flows.inflow - flows.outflow;
        if (net > 100000) {
          candidates.push({
            symbol: chain.toUpperCase(),
            chain: chain as Chain,
            signalType: "BRIDGE_INFLOW",
            confidence: 60,
            score: Math.min(50 + (net / 100000), 80),
            details: `${chain} receiving ${(net / 1000000).toFixed(1)}M in bridge inflows`,
            valueUsd: net,
          });
        }
      }

      // 2. Exchange outflows = accumulation = bullish
      const outflows = exchangeFlows.filter(f => f.direction === "outflow" && f.valueUsd > 50000);
      for (const outflow of outflows) {
        candidates.push({
          symbol: outflow.symbol,
          chain: outflow.chain,
          signalType: "EXCHANGE_OUTFLOW",
          confidence: 65,
          score: Math.min(50 + (outflow.valueUsd / 10000), 75),
          details: `Large ${outflow.symbol} outflow from ${outflow.exchange}: $${outflow.amount.toLocaleString()}`,
          valueUsd: outflow.valueUsd,
        });
      }

      // 3. Token unlocks = sell pressure = bearish
      for (const unlock of tokenUnlocks) {
        if (unlock.valueUsd > 500000) {
          const daysUntilUnlock = (unlock.unlockDate - Date.now()) / (86400 * 1000);
          if (daysUntilUnlock <= 7) {
            candidates.push({
              symbol: unlock.symbol,
              chain: unlock.chain,
              signalType: "TOKEN_UNLOCK",
              confidence: 70,
              score: 60,
              details: `${unlock.project}: $${(unlock.valueUsd / 1000000).toFixed(1)}M unlock in ${daysUntilUnlock.toFixed(0)}d (${unlock.percentage}% supply)`,
              valueUsd: unlock.valueUsd,
            });
          }
        }
      }

      // Convert candidates to signals
      for (const c of candidates) {
        const signal = this.buildSignal(c);
        if (signal.confidence >= config.MIN_CONVICTION_SCORE) {
          signals.push(signal);
        }
      }

      logger.info({
        agent: this.name,
        bridgeFlows: bridgeFlows.length,
        exchangeFlows: exchangeFlows.length,
        tokenUnlocks: tokenUnlocks.length,
        signalsGenerated: signals.length,
      }, `${this.name} scan complete`);
    } catch (err: any) {
      logger.error({ agent: this.name, err: err.message }, `${this.name} failed`);
    }

    return {
      agent: this.name,
      signals,
      metrics: {
        candidatesAnalyzed: candidates.length,
        signalsGenerated: signals.length,
        durationMs: Date.now() - startTime,
      },
    };
  }

  private buildSignal(c: OnchainSignal): TradeSignal {
    const isBearish = c.signalType === "TOKEN_UNLOCK";

    return {
      type: "ONCHAIN",
      symbol: c.symbol,
      chain: c.chain,
      direction: isBearish ? "short" : "long",
      confidence: c.confidence,
      score: c.score,
      leverage: 3,
      catalyst: c.details,
      thesis: `On-chain intelligence detected ${c.signalType.replace("_", " ").toLowerCase()}. ${c.details}`,
      sources: ["ONCHAIN"],
      agentScores: { ONCHAIN_INTEL: c.score },
      bridgeFlowUsd: c.signalType === "BRIDGE_INFLOW" ? c.valueUsd : undefined,
      exchangeNetflow: c.signalType === "EXCHANGE_OUTFLOW" ? -c.valueUsd : c.valueUsd,
    };
  }
}

export const onchainIntelAgent = new OnchainIntelAgent();

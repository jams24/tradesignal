import { logger } from "../utils/logger";
import { config } from "../utils/config";
import { onchainProvider } from "../data/providers/onchain";
import { dexProvider } from "../data/providers/dex";
import { prisma } from "../db/prisma";
import type { TradeSignal, AgentResult, Chain } from "../types/signals";

interface OnchainSignal {
  symbol: string;
  chain: Chain;
  signalType: "EXCHANGE_OUTFLOW" | "EXCHANGE_INFLOW" | "TOKEN_UNLOCK" | "DEX_VOLUME" | "NEW_PAIR";
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
      // 1. Exchange netflows (bulk stablecoin + ETH/BTC transfers)
      const exchangeFlows = await onchainProvider.fetchExchangeNetflows("ethereum");

      for (const flow of exchangeFlows) {
        if (this.processedTxHashes.has(flow.token + flow.amount)) continue;
        this.processedTxHashes.add(flow.token + flow.amount);

        const isStable = flow.symbol === "USDT" || flow.symbol === "USDC";
        const isAsset = flow.symbol === "ETH" || flow.symbol === "BTC";

        if (flow.direction === "outflow") {
          // Outflow = withdrawal from exchange
          // Stablecoins leaving = neutral/slightly bearish for stablecoin demand
          // ETH/BTC leaving = BULLISH (whale accumulation, moving to cold storage/DeFi)
          const threshold = isAsset ? 10 : 50000;
          if (flow.valueUsd > threshold) {
            candidates.push({
              symbol: flow.symbol,
              chain: flow.chain,
              signalType: "EXCHANGE_OUTFLOW",
              direction: isAsset ? "long" : "long",
              confidence: isAsset ? 75 : 65,
              score: isAsset ? 70 : 60,
              details: `${isAsset ? "🚀 " : ""}${flow.symbol} WITHDRAWAL from ${flow.exchange}: $${(flow.amount).toLocaleString(undefined, {maximumFractionDigits: 2})}`,
              valueUsd: flow.valueUsd,
            });
          }
        } else if (flow.direction === "inflow") {
          // Inflow = deposit to exchange
          // Stablecoins entering = buying power, bullish for market
          // ETH/BTC entering = BEARISH (whale preparing to sell)
          const threshold = isAsset ? 25 : 200000;
          if (flow.valueUsd > threshold) {
            candidates.push({
              symbol: flow.symbol,
              chain: flow.chain,
              signalType: "EXCHANGE_INFLOW",
              direction: isAsset ? "short" : "long",
              confidence: isAsset ? 70 : 60,
              score: isAsset ? 65 : 55,
              details: `${isAsset ? "⚠️ " : ""}${flow.symbol} DEPOSIT to ${flow.exchange}: $${(flow.amount).toLocaleString(undefined, {maximumFractionDigits: 2})}`,
              valueUsd: flow.valueUsd,
            });
          }
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

      // 3. Bridge flows + Whale transfers (cross-chain and large movements)
      let bridgeCount = 0;
      let whaleCount = 0;

      try {
        const bridgeFlows = await onchainProvider.fetchBridgeFlows("ethereum");
        bridgeCount = bridgeFlows.length;
        for (const flow of bridgeFlows) {
          candidates.push({
            symbol: flow.symbol,
            chain: flow.chain,
            signalType: flow.direction === "in" ? "EXCHANGE_INFLOW" : "EXCHANGE_OUTFLOW",
            direction: flow.direction === "in" ? "long" : "short",
            confidence: 55,
            score: 50,
            details: `${flow.symbol} bridged ${flow.direction === "in" ? "into" : "out of"} Ethereum via ${flow.bridgeName}: $${(flow.amount / 1e6).toFixed(1)}M`,
            valueUsd: flow.valueUsd,
          });
        }
      } catch { /* bridge detection is best-effort */ }

      try {
        const whaleXfers = await onchainProvider.fetchWhaleTransfers("ethereum");
        whaleCount = whaleXfers.length;
        for (const wt of whaleXfers) {
          candidates.push({
            symbol: wt.symbol,
            chain: wt.chain,
            signalType: "EXCHANGE_OUTFLOW",
            direction: "long",
            confidence: 60,
            score: 55,
            details: `🐋 Whale moved ${wt.symbol === "ETH" ? wt.amount.toFixed(2) + " ETH" : "$" + (wt.amount / 1e6).toFixed(1) + "M " + wt.symbol} ($${wt.valueUsd >= 1e6 ? (wt.valueUsd / 1e6).toFixed(1) + "M" : (wt.valueUsd / 1000).toFixed(0) + "K"})`,
            valueUsd: wt.valueUsd,
          });
        }
      } catch (err: any) {
        logger.warn(`Whale scan failed: ${err.message}`);
      }

      if (bridgeCount + whaleCount > 0) {
        logger.info({ bridgeFlows: bridgeCount, whaleXfers: whaleCount }, "Bridge/whale data scanned");
      }

      // 5. DEX volume spikes + new pairs
      try {
        const dexSpikes = await dexProvider.fetchVolumeSpikes("ethereum");
        for (const spike of dexSpikes.slice(0, 10)) {
          const tokenSymbol = spike.token0Symbol !== "WETH" && spike.token0Symbol !== "USDT" && spike.token0Symbol !== "USDC"
            ? spike.token0Symbol
            : spike.token1Symbol !== "WETH" && spike.token1Symbol !== "USDT" && spike.token1Symbol !== "USDC"
              ? spike.token1Symbol
              : spike.token0Symbol;

          if (!tokenSymbol) continue;

          candidates.push({
            symbol: tokenSymbol,
            chain: spike.chain,
            signalType: "DEX_VOLUME",
            direction: "long",
            confidence: 70,
            score: 65,
            details: `DEX volume spike: $${(spike.volumeUsd / 1000).toFixed(0)}k on Uniswap V2 (${spike.swaps24h} swaps in ~1hr)`,
            valueUsd: spike.volumeUsd,
          });
        }

        // 4. New Uniswap pairs (potential new token launches)
        const newPairs = await dexProvider.fetchNewPairs("ethereum");
        for (const pair of newPairs.slice(0, 5)) {
          candidates.push({
            symbol: "NEW_TOKEN",
            chain: pair.chain,
            signalType: "DEX_VOLUME",
            direction: "long",
            confidence: 55,
            score: 50,
            details: `New Uniswap V2 pair created: ${pair.token0.slice(0, 10)}.../${pair.token1.slice(0, 10)}...`,
            valueUsd: 0,
          });
        }

        if (dexSpikes.length + newPairs.length > 0) {
          logger.info({ dexSpikes: dexSpikes.length, newPairs: newPairs.length }, "DEX data scanned");
        }
      } catch (err: any) {
        logger.warn(`DEX scan failed: ${err.message}`);
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
    const flowDesc = c.details;

    let tokenTypeHint = "";
    if (c.signalType === "DEX_VOLUME") {
      tokenTypeHint = `DEX volume spike detected. ` +
        `This token is seeing unusual trading activity on Uniswap — often a precursor to CEX listing or major announcement. ` +
        `Monitor for continuation.`;
    } else if (c.signalType === "NEW_PAIR") {
      tokenTypeHint = `New Uniswap pair deployed. Early-stage token launches often see initial pumps. ` +
        `Exercise caution — verify LP lock status and deployer history before entering.`;
    } else if (c.symbol === "ETH" || c.symbol === "BTC") {
      tokenTypeHint = `Large ${c.symbol} movement detected. ${c.direction === "long" ? "Withdrawals from exchanges suggest whale accumulation — historically precedes price increases." : "Deposits to exchanges suggest whales preparing to sell — historically precedes price drops."}`;
    } else if (c.symbol === "USDT" || c.symbol === "USDC") {
      tokenTypeHint = `${c.symbol} flow detected. ${c.direction === "long" ? "Stablecoins entering exchanges = buying power deploying — bullish for market." : "Stablecoins leaving exchanges — capital rotating out, neutral to slightly bearish."}`;
    }

    return {
      type: "ONCHAIN",
      symbol: c.symbol,
      chain: c.chain,
      direction: c.direction,
      confidence: c.confidence,
      score: c.score,
      leverage: c.signalType === "DEX_VOLUME" ? 2 : 2,
      catalyst: flowDesc,
      thesis: tokenTypeHint,
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

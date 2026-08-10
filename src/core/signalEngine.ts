import { EventEmitter } from "events";
import { logger } from "../utils/logger";
import { prisma } from "../db/prisma";
import { config } from "../utils/config";
import type { TradeSignal, AgentResult, SignalType } from "../types/signals";

interface ConfluenceGroup {
  key: string;
  symbol: string;
  chain: string;
  direction: "long" | "short";
  signals: TradeSignal[];
  individualScores: number[];
  compositeScore: number;
  confidence: number;
  consensus: number; // 0-1, how aligned the agents are
  sourceAgents: SignalType[];
}

export class SignalEngine extends EventEmitter {
  private readonly MAX_CONFLUENCE_SIGNALS = 10;
  private readonly CONFLUENCE_BONUS = 15; // bonus points per additional agent

  async processAgentResults(results: AgentResult[]): Promise<TradeSignal[]> {
    const allSignals: TradeSignal[] = [];

    for (const result of results) {
      for (const signal of result.signals) {
        allSignals.push(signal);
      }
    }

    if (allSignals.length === 0) return [];

    // Group signals by symbol+chain+direction to find confluence
    const groups = this.groupForConfluence(allSignals);

    // Generate composite signals
    const compositeSignals: TradeSignal[] = [];

    for (const group of groups) {
      if (group.signals.length === 0) continue;

      const signal = this.createCompositeSignal(group);
      compositeSignals.push(signal);
    }

    // Also include strong solo signals that didn't have confluence
    const groupedSymbols = new Set(groups.map(g => g.key));
    const soloSignals = allSignals.filter(s => {
      const key = `${s.symbol}:${s.chain}:${s.direction}`;
      return !groupedSymbols.has(key) && s.confidence >= 50;
    });

    const finalSignals = [...compositeSignals, ...soloSignals]
      .sort((a, b) => b.score - a.score)
      .slice(0, 30);

    // Persist signals (dedup by symbol — only first alert per symbol)
    const seenSymbols = new Set<string>();
    for (const signal of finalSignals) {
      const key = `${signal.symbol}:${signal.direction}`;
      if (seenSymbols.has(key)) continue;
      seenSymbols.add(key);

      try {
        await prisma.signal.create({
          data: {
            type: signal.type,
            symbol: signal.symbol,
            chain: signal.chain,
            direction: signal.direction,
            confidence: signal.confidence,
            score: signal.score,
            price: signal.price,
            entryLow: signal.entryLow,
            entryHigh: signal.entryHigh,
            tp1: signal.tp1,
            tp2: signal.tp2,
            tp3: signal.tp3,
            stopLoss: signal.stopLoss,
            tp1Pct: signal.tp1Pct,
            tp2Pct: signal.tp2Pct,
            tp3Pct: signal.tp3Pct,
            slPct: signal.slPct,
            leverage: signal.leverage,
            positionSize: signal.positionSize,
            catalyst: signal.catalyst,
            thesis: signal.thesis,
            exchange: signal.exchange,
            sources: signal.sources as any,
            agentScores: signal.agentScores as any,
            rawData: (signal.rawData || {}) as any,
            status: "ACTIVE",
          },
        });
      } catch (err: any) {
        logger.error({ symbol: signal.symbol, err: err.message }, "Failed to save signal");
      }
    }

    logger.info({
      totalSignals: allSignals.length,
      compositeSignals: compositeSignals.length,
      soloSignals: soloSignals.length,
      finalSignals: finalSignals.length,
    }, "Signal engine processing complete");

    return finalSignals;
  }

  private groupForConfluence(signals: TradeSignal[]): ConfluenceGroup[] {
    const groups = new Map<string, ConfluenceGroup>();

    for (const signal of signals) {
      const key = `${signal.symbol}:${signal.chain}:${signal.direction}`;
      let group = groups.get(key);

      if (!group) {
        group = {
          key,
          symbol: signal.symbol,
          chain: signal.chain,
          direction: signal.direction,
          signals: [],
          individualScores: [],
          compositeScore: 0,
          confidence: 0,
          consensus: 0,
          sourceAgents: [],
        };
        groups.set(key, group);
      }

      group.signals.push(signal);

      for (const [agent, score] of Object.entries(signal.agentScores)) {
        group.individualScores.push(score);
        if (!group.sourceAgents.includes(agent as SignalType)) {
          group.sourceAgents.push(agent as SignalType);
        }
      }
    }

    // Calculate composite scores for each group
    for (const group of groups.values()) {
      const scores = group.individualScores;
      if (scores.length === 0) continue;

      // Base score: weighted average, weight increases with each additional agent
      const baseScore = scores.reduce((s, sc) => s + sc, 0) / scores.length;

      // Confluence bonus: more agents = more confidence in the signal
      const agentCount = group.sourceAgents.length;
      const confluenceBonus = agentCount >= 3
        ? this.CONFLUENCE_BONUS * 2
        : agentCount >= 2
          ? this.CONFLUENCE_BONUS
          : 0;

      group.compositeScore = Math.min(baseScore + confluenceBonus, 100);

      // Consensus: how tightly the agents agree
      const maxDiff = Math.max(...scores) - Math.min(...scores);
      group.consensus = Math.max(0, 1 - (maxDiff / 100));

      // Confidence: blend of composite score and consensus
      group.confidence = Math.min(
        group.compositeScore * group.consensus + 10,
        95,
      );
    }

    // Return groups with 2+ agents or very high single-agent scores
    return Array.from(groups.values())
      .filter(g => g.sourceAgents.length >= 2 || g.compositeScore >= 80)
      .sort((a, b) => b.compositeScore - a.compositeScore)
      .slice(0, this.MAX_CONFLUENCE_SIGNALS);
  }

  private createCompositeSignal(group: ConfluenceGroup): TradeSignal {
    const primarySignal = group.signals.sort((a, b) => b.score - a.score)[0];
    const isConfluence = group.sourceAgents.length >= 2;

    const type: SignalType = isConfluence
      ? "RESEARCH" // conflusion signals get RESEARCH label for priority
      : primarySignal.type;

    // Merge TP/SL from the highest scoring signal
    const entryPoint = primarySignal.price || 0;
    const bestSignal = group.signals.sort((a, b) =>
      (b.agentScores[Object.keys(b.agentScores)[0]] || 0) -
      (a.agentScores[Object.keys(a.agentScores)[0]] || 0),
    )[0];

    const sourceAgents = group.sourceAgents.join(", ");
    const signalTypes = group.signals.map(s => s.type).join(", ");

    return {
      type,
      symbol: group.symbol,
      chain: group.chain as any,
      direction: group.direction,
      confidence: Math.round(group.confidence),
      score: Math.round(group.compositeScore),
      price: entryPoint || bestSignal.price,
      entryLow: bestSignal.entryLow,
      entryHigh: bestSignal.entryHigh,
      tp1: bestSignal.tp1,
      tp2: bestSignal.tp2,
      tp3: bestSignal.tp3,
      stopLoss: bestSignal.stopLoss,
      tp1Pct: bestSignal.tp1Pct,
      tp2Pct: bestSignal.tp2Pct,
      tp3Pct: bestSignal.tp3Pct,
      slPct: bestSignal.slPct,
      leverage: primarySignal.leverage,
      positionSize: primarySignal.positionSize,
      exchange: primarySignal.exchange,
      catalyst: `CONFLUENCE: ${sourceAgents} — ${signalTypes}`,
      thesis: isConfluence
        ? `Multi-agent confluence detected for ${group.symbol}. ` +
          `${group.sourceAgents.length} agents agree (consensus: ${(group.consensus * 100).toFixed(0)}%). ` +
          `Agent scores: ${group.individualScores.map(s => s.toFixed(0)).join("/")}. ` +
          `${primarySignal.thesis || ""}`
        : primarySignal.thesis || "",
      sources: group.sourceAgents,
      agentScores: Object.fromEntries(group.sourceAgents.map((agent, i) =>
        [agent.replace("_", "_"), group.individualScores[i] || group.compositeScore],
      )),
      // Carry forward any special fields
      deployerRisk: primarySignal.deployerRisk,
      lpLocked: primarySignal.lpLocked,
      lpBurned: primarySignal.lpBurned,
      smartWalletsBuying: primarySignal.smartWalletsBuying,
      sentimentScore: primarySignal.sentimentScore,
      kolMentions: primarySignal.kolMentions,
      narrativeMatch: primarySignal.narrativeMatch,
      redFlags: primarySignal.redFlags,
    };
  }
}

export const signalEngine = new SignalEngine();

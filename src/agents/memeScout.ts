import { logger } from "../utils/logger";
import { config } from "../utils/config";
import { dexProvider } from "../data/providers/dex";
import { onchainProvider } from "../data/providers/onchain";
import type { TradeSignal, AgentResult } from "../types/signals";

interface MemeCandidate {
  symbol: string;
  tokenAddress: string;
  chain: "solana" | "base" | "ethereum" | "bsc";
  deployer: string;
  pairAddress: string;
  initialLiquidity: number;
  age: number;
  holders: number;
  deployerRisk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  lpLocked: boolean;
  lpBurned: boolean;
  hasSnipers: boolean;
  sniperCount: number;
  socialMentions: number;
  score: number;
}

export class MemeScoutAgent {
  private name = "MEME_SCOUT";

  async analyze(): Promise<AgentResult<TradeSignal>> {
    const startTime = Date.now();
    const candidates: MemeCandidate[] = [];
    const signals: TradeSignal[] = [];

    try {
      // Scan new pairs on Solana and Base
      const [solanaPairs, basePairs] = await Promise.all([
        dexProvider.fetchNewPairsSolana(),
        dexProvider.fetchNewPairsEVM("base"),
      ]);

      for (const pair of solanaPairs) {
        const candidate = await this.evaluateMemeCandidate(pair, "solana");
        if (candidate && candidate.score >= 50) candidates.push(candidate);
      }

      for (const pair of basePairs) {
        const candidate = await this.evaluateMemeCandidate(pair, "base");
        if (candidate && candidate.score >= 50) candidates.push(candidate);
      }

      // Generate signals from high-scoring candidates
      for (const c of candidates.filter(c => c.score >= 70)) {
        const signal = this.buildSignal(c);
        if (signal.confidence >= config.MIN_CONVICTION_SCORE) {
          signals.push(signal);
        }
      }

      logger.info({
        agent: this.name,
        candidatesAnalyzed: candidates.length,
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

  private async evaluateMemeCandidate(
    pair: any,
    chain: "solana" | "base",
  ): Promise<MemeCandidate | null> {
    const candidate: MemeCandidate = {
      symbol: pair.baseSymbol || pair.token0Symbol || "UNKNOWN",
      tokenAddress: pair.baseToken || pair.token0 || "",
      chain,
      deployer: pair.deployer || "",
      pairAddress: pair.pairAddress || "",
      initialLiquidity: pair.initialLiquidity || 0,
      age: Date.now() - (pair.timestamp || Date.now()),
      holders: 0,
      deployerRisk: "MEDIUM",
      lpLocked: false,
      lpBurned: false,
      hasSnipers: false,
      sniperCount: 0,
      socialMentions: 0,
      score: 0,
    };

    // Check deployer history
    if (candidate.deployer) {
      candidate.deployerRisk = await this.assessDeployerRisk(candidate.deployer, chain);
    }

    // Check LP status (would need dedicated LP check — simplified here)
    candidate.lpLocked = true; // placeholder — would check lockers like Unicrypt, FlokiFi
    candidate.lpBurned = candidate.initialLiquidity > 1000; // heuristic

    // Score the candidate
    candidate.score = this.scoreCandidate(candidate);

    return candidate;
  }

  private async assessDeployerRisk(
    deployer: string,
    chain: string,
  ): Promise<"LOW" | "MEDIUM" | "HIGH" | "CRITICAL"> {
    // Check if this deployer has previously rugged tokens
    // In production, maintain a DB of deployer addresses + outcomes
    const knownRuggers: Set<string> = new Set([
      // Would be populated from known rug pull addresses
    ]);

    if (knownRuggers.has(deployer.toLowerCase())) return "CRITICAL";

    if (deployer.length < 5) return "HIGH"; // unknown deployer

    return "MEDIUM";
  }

  private scoreCandidate(c: MemeCandidate): number {
    let score = 0;

    // Liquidity
    if (c.initialLiquidity > 100000) score += 25;
    else if (c.initialLiquidity > 10000) score += 15;
    else if (c.initialLiquidity > 1000) score += 5;
    else score -= 10; // too low liquidity = risk

    // LP status
    if (c.lpBurned) score += 20;
    if (c.lpLocked) score += 10;

    // Deployer risk
    switch (c.deployerRisk) {
      case "LOW": score += 20; break;
      case "MEDIUM": score += 0; break;
      case "HIGH": score -= 20; break;
      case "CRITICAL": score -= 50; break;
    }

    // No snipers = better entry
    if (!c.hasSnipers) score += 10;
    else if (c.sniperCount > 3) score -= 15;

    // Very new = better price
    const ageMinutes = c.age / 60000;
    if (ageMinutes < 5) score += 15;
    else if (ageMinutes < 30) score += 10;
    else if (ageMinutes > 60) score += 0;

    // Social buzz
    if (c.socialMentions > 50) score += 10;

    return Math.max(0, Math.min(100, score));
  }

  private buildSignal(candidate: MemeCandidate): TradeSignal {
    const isRug = candidate.deployerRisk === "CRITICAL" || candidate.deployerRisk === "HIGH";

    return {
      type: "MEME",
      symbol: candidate.symbol,
      chain: candidate.chain,
      direction: "long",
      confidence: isRug ? 0 : Math.min(candidate.score, 80),
      score: candidate.score,
      leverage: 1, // no leverage on memecoins
      positionSize: config.MAX_POSITION_SIZE_USD * 0.1, // 10% allocation for memes
      catalyst: `New ${candidate.chain} meme token detected — ${candidate.initialLiquidity > 10000 ? "strong" : "moderate"} initial liquidity`,
      thesis: `${candidate.symbol} deployed on ${candidate.chain}. ` +
             `LP: ${candidate.lpBurned ? "burned" : "not burned"}, ` +
             `${candidate.lpLocked ? "locked" : "unlocked"}. ` +
             `Deployer risk: ${candidate.deployerRisk}. ` +
             `Age: ${candidate.age / 60000}m`,
      sources: ["MEME"],
      agentScores: { MEME_SCOUT: candidate.score },
      deployerRisk: candidate.deployerRisk,
      lpLocked: candidate.lpLocked,
      lpBurned: candidate.lpBurned,
      sniperCount: candidate.sniperCount,
      redFlags: this.collectRedFlags(candidate),
    };
  }

  private collectRedFlags(c: MemeCandidate): string[] {
    const flags: string[] = [];
    if (c.deployerRisk === "CRITICAL") flags.push("Known rug pull deployer");
    if (c.deployerRisk === "HIGH") flags.push("Untrusted deployer");
    if (!c.lpLocked && !c.lpBurned) flags.push("LP not locked or burned");
    if (c.initialLiquidity < 500) flags.push("Extremely low liquidity");
    if (c.sniperCount > 5) flags.push("Heavy sniper activity");
    return flags;
  }
}

export const memeScoutAgent = new MemeScoutAgent();

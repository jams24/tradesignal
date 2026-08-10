import { logger } from "../utils/logger";
import { config } from "../utils/config";
import { socialProvider } from "../data/providers/social";
import { prisma } from "../db/prisma";
import type { TradeSignal, AgentResult } from "../types/signals";

interface NarrativeSignal {
  symbol: string;
  narrative: string;
  mentionCount: number;
  kolMentions: number;
  sentimentScore: number;
  engagementScore: number;
  socialVolume: number;
  trendDirection: "rising" | "falling" | "stable";
  score: number;
}

interface DetectedNarrative {
  name: string;
  keywords: string[];
  tokens: string[];
  weight: number;
  mentions: number;
  sentiment: number;
}

export class SocialNarrativeAgent {
  private name = "SOCIAL_NARRATIVE";
  private deepseekAvailable: boolean;

  constructor() {
    this.deepseekAvailable = !!config.DEEPSEEK_API_KEY;
  }

  async analyze(): Promise<AgentResult<TradeSignal>> {
    const startTime = Date.now();
    const signals: TradeSignal[] = [];
    const candidates: NarrativeSignal[] = [];

    try {
      const trendingCoins = await socialProvider.fetchTrendingCoins();
      const symbols = trendingCoins.slice(0, 20).map(c => c.symbol).filter(Boolean);

      if (symbols.length === 0) {
        return { agent: this.name, signals: [], metrics: { candidatesAnalyzed: 0, signalsGenerated: 0, durationMs: Date.now() - startTime } };
      }

      const twitterSignals = await socialProvider.searchTwitterCashtags(symbols);

      // Aggregate social metrics per symbol
      const symbolMetrics = new Map<string, {
        mentions: number;
        kolMentions: number;
        totalEngagement: number;
        sentimentSum: number;
        sentimentCount: number;
        authors: Set<string>;
      }>();

      for (const s of twitterSignals) {
        const metrics = symbolMetrics.get(s.symbol) || {
          mentions: 0, kolMentions: 0, totalEngagement: 0,
          sentimentSum: 0, sentimentCount: 0, authors: new Set(),
        };

        metrics.mentions++;
        metrics.totalEngagement += s.engagement;
        metrics.authors.add(s.authorId);

        if (s.isKOL) metrics.kolMentions++;

        symbolMetrics.set(s.symbol, metrics);
      }

      // Score each symbol
      for (const [symbol, metrics] of symbolMetrics) {
        const sentimentScore = 0; // Will be filled by LLM analysis below
        const avgEngagement = metrics.mentions > 0 ? metrics.totalEngagement / metrics.mentions : 0;
        const uniqueAuthors = metrics.authors.size;

        let score = 0;
        score += Math.min(metrics.mentions * 3, 30);    // volume
        score += Math.min(metrics.kolMentions * 10, 30); // KOL signal
        score += Math.min(avgEngagement / 10, 20);        // engagement quality
        score += Math.min(uniqueAuthors * 2, 20);         // breadth

        if (score >= 50) {
          candidates.push({
            symbol,
            narrative: "",
            mentionCount: metrics.mentions,
            kolMentions: metrics.kolMentions,
            sentimentScore,
            engagementScore: avgEngagement,
            socialVolume: metrics.mentions,
            trendDirection: "rising",
            score,
          });
        }
      }

      // Detect dominant narratives
      const narratives = this.detectNarratives(twitterSignals);

      // Generate signals
      for (const c of candidates) {
        const signal = await this.buildSignal(c, narratives);
        if (signal && signal.confidence >= config.MIN_CONVICTION_SCORE) {
          signals.push(signal);
        }
      }

      // Store narratives in DB
      for (const n of narratives.slice(0, 10)) {
        try {
          await prisma.narrative.upsert({
            where: { id: n.name.toLowerCase().replace(/\s+/g, "-") },
            update: { weight: n.weight, mentions: n.mentions, sentiment: n.sentiment, lastSeen: new Date() },
            create: {
              id: n.name.toLowerCase().replace(/\s+/g, "-"),
              name: n.name,
              weight: n.weight,
              keywords: n.keywords as any,
              mentions: n.mentions,
              sentiment: n.sentiment,
            },
          });
        } catch { /* skip */ }
      }

      logger.info({
        agent: this.name,
        trendingCoins: trendingCoins.length,
        twitterSignals: twitterSignals.length,
        narratives: narratives.length,
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

  private detectNarratives(tweets: any[]): DetectedNarrative[] {
    const narrativePatterns: DetectedNarrative[] = [
      { name: "AI Agents", keywords: ["ai agent", "autonomous", "agent", "eliza", "virtuals", "ai16z"], tokens: [], weight: 0, mentions: 0, sentiment: 0 },
      { name: "Memecoins", keywords: ["meme", "memecoin", "degen", "pepe", "wojak", "dog", "cat"], tokens: [], weight: 0, mentions: 0, sentiment: 0 },
      { name: "RWA", keywords: ["rwa", "real world asset", "tokenization", "ondo", "blackrock"], tokens: [], weight: 0, mentions: 0, sentiment: 0 },
      { name: "DePIN", keywords: ["depin", "decentralized infrastructure", "render", "hnt", "iot", "hivemapper"], tokens: [], weight: 0, mentions: 0, sentiment: 0 },
      { name: "Layer 2", keywords: ["layer 2", "l2", "rollup", "arbitrum", "optimism", "base", "zksync", "starknet"], tokens: [], weight: 0, mentions: 0, sentiment: 0 },
      { name: "Gaming", keywords: ["gaming", "gamefi", "web3 gaming", "immutable", "ronin", "pixels"], tokens: [], weight: 0, mentions: 0, sentiment: 0 },
      { name: "DeFi", keywords: ["defi", "yield", "aave", "uniswap", "lending", "staking"], tokens: [], weight: 0, mentions: 0, sentiment: 0 },
      { name: "Solana Ecosystem", keywords: ["solana", "sol", "raydium", "jupiter", "jito", "phantom"], tokens: [], weight: 0, mentions: 0, sentiment: 0 },
    ];

    for (const tweet of tweets) {
      const text = (tweet.content || "").toLowerCase();
      for (const narrative of narrativePatterns) {
        const matches = narrative.keywords.filter(kw => text.includes(kw));
        if (matches.length > 0) {
          narrative.mentions += matches.length;
          narrative.weight += 0.01;
          if (tweet.isKOL) narrative.weight += 0.03;
        }
      }
    }

    return narrativePatterns
      .filter(n => n.mentions > 0)
      .sort((a, b) => b.weight - a.weight);
  }

  private async buildSignal(
    c: NarrativeSignal,
    narratives: DetectedNarrative[],
  ): Promise<TradeSignal | null> {
    const matchedNarrative = narratives.find(n =>
      n.keywords.some(kw => c.symbol.toLowerCase().includes(kw)),
    );

    return {
      type: "SOCIAL",
      symbol: c.symbol,
      chain: "unknown",
      direction: "long",
      confidence: Math.min(c.score, 80),
      score: c.score,
      leverage: 3,
      catalyst: `Social volume surge: ${c.mentionCount} mentions, ${c.kolMentions} KOL mentions`,
      thesis: `${c.symbol} is trending on social media. ` +
             `${c.mentionCount} recent mentions with ${c.kolMentions} from KOLs/influencers. ` +
             `${matchedNarrative ? `Aligned with "${matchedNarrative.name}" narrative. ` : ""}` +
             `Engagement score: ${c.engagementScore.toFixed(0)}. Monitor for continuation.`,
      sources: ["SOCIAL"],
      agentScores: { SOCIAL_NARRATIVE: c.score },
      sentimentScore: c.sentimentScore,
      kolMentions: c.kolMentions,
      narrativeMatch: matchedNarrative?.name,
    };
  }
}

export const socialNarrativeAgent = new SocialNarrativeAgent();

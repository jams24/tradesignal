import OpenAI from "openai";
import { logger } from "../utils/logger";
import { config } from "../utils/config";
import type { TradeSignal, AgentResult } from "../types/signals";

interface ResearchResult {
  symbol: string;
  chain: string;
  convictionScore: number;
  thesis: string;
  redFlags: string[];
  greenFlags: string[];
  technicalScore: number;
  fundamentalScore: number;
  socialScore: number;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "EXTREME";
  summary: string;
}

export class ResearchAgent {
  private name = "RESEARCH";
  private client: OpenAI | null = null;
  private enabled: boolean;

  constructor() {
    this.enabled = !!config.DEEPSEEK_API_KEY;
    if (this.enabled) {
      this.client = new OpenAI({
        apiKey: config.DEEPSEEK_API_KEY,
        baseURL: "https://api.deepseek.com/v1",
      });
      logger.info("DeepSeek research agent initialized");
    } else {
      logger.warn("DeepSeek API key not set — research agent disabled");
    }
  }

  async deepResearch(inputSignals: TradeSignal[]): Promise<AgentResult<TradeSignal>> {
    const startTime = Date.now();
    const resolvedSignals: TradeSignal[] = [];

    if (!this.enabled || !this.client) {
      return {
        agent: this.name,
        signals: inputSignals.map(s => ({ ...s, thesis: s.thesis || "Research agent disabled. Thesis unavailable." })),
        metrics: { candidatesAnalyzed: inputSignals.length, signalsGenerated: inputSignals.length, durationMs: 0 },
      };
    }

    // Only deep-research top signals by score (to manage costs)
    const topSignals = inputSignals
      .sort((a, b) => b.score - a.score)
      .slice(0, 15);

    for (const signal of topSignals) {
      try {
        const research = await this.analyzeToken(signal);
        const enrichedSignal: TradeSignal = {
          ...signal,
          thesis: research.thesis || signal.thesis,
          researchConviction: research.convictionScore,
          redFlags: [...(signal.redFlags || []), ...research.redFlags],
          agentScores: {
            ...signal.agentScores,
            RESEARCH: research.convictionScore,
          },
          confidence: Math.round(
            (signal.confidence * 0.6) + (research.convictionScore * 0.4),
          ), // blended confidence
          score: Math.round(
            (signal.score * 0.5) + (research.convictionScore * 0.5),
          ), // blended score
          sources: [...signal.sources, "RESEARCH"],
        };
        resolvedSignals.push(enrichedSignal);
      } catch (err: any) {
        logger.error({ symbol: signal.symbol, err: err.message }, "Research failed for signal, using original");
        resolvedSignals.push(signal); // fall back to original signal
      }
    }

    // Include lower-scored signals as-is (no research to save costs)
    const remaining = inputSignals.slice(15);
    resolvedSignals.push(...remaining);

    logger.info({
      agent: this.name,
      researched: topSignals.length,
      total: resolvedSignals.length,
    }, `${this.name} research complete`);

    return {
      agent: this.name,
      signals: resolvedSignals,
      metrics: {
        candidatesAnalyzed: inputSignals.length,
        signalsGenerated: resolvedSignals.length,
        durationMs: Date.now() - startTime,
      },
    };
  }

  private async analyzeToken(signal: TradeSignal): Promise<ResearchResult> {
    if (!this.client) throw new Error("DeepSeek client not initialized");

    const prompt = `You are an elite crypto trading analyst agent. Analyze this trading signal and provide your professional assessment.

TRADING SIGNAL:
- Symbol: ${signal.symbol}
- Signal Type: ${signal.type}
- Chain: ${signal.chain}
- Direction: ${signal.direction}
- Confidence: ${signal.confidence}/100
- Score: ${signal.score}/100
- Catalyst: ${signal.catalyst}
${signal.price ? `- Price: $${signal.price}` : ""}
${signal.leverage ? `- Suggested Leverage: ${signal.leverage}x` : ""}

PROVIDE YOUR ANALYSIS IN THIS EXACT JSON FORMAT (no other text):
{
  "convictionScore": <number 0-100, your confidence in this trade>,
  "thesis": "<2-4 sentence trading thesis explaining WHY this might work>",
  "redFlags": ["<concrete risk>", ...] (at least 1, max 5),
  "greenFlags": ["<bullish factor>", ...] (at least 1, max 5),
  "technicalScore": <number 0-100>,
  "fundamentalScore": <number 0-100>,
  "socialScore": <number 0-100>,
  "riskLevel": "<LOW|MEDIUM|HIGH|EXTREME>",
  "summary": "<1 sentence verdict>"
}

Important:
- Be HONEST. If this looks like a bad trade, give low scores.
- Consider: tokenomics, liquidity depth, past listing patterns, market conditions
- For memecoins: especially check deployer risk, LP status, sniper activity
- For technical signals: check if RSI/volume patterns are reliable
- For smart money: consider if wallets might be coordinated/insider
- Red flags should be CONCRETE and ACTIONABLE`;

    try {
      const response = await this.client.chat.completions.create({
        model: "deepseek-v4-flash",
        messages: [
          { role: "system", content: "You are a crypto trading analyst AI. You MUST respond in valid JSON format only. No markdown, no explanations outside the JSON." },
          { role: "user", content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 1000,
      });

      const text = response.choices[0]?.message?.content?.trim() || "{}";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? jsonMatch[0] : text;

      const result = JSON.parse(jsonStr);

      return {
        symbol: signal.symbol,
        chain: signal.chain,
        convictionScore: Math.min(100, Math.max(0, result.convictionScore || 50)),
        thesis: result.thesis || "Unable to generate thesis",
        redFlags: result.redFlags || [],
        greenFlags: result.greenFlags || [],
        technicalScore: result.technicalScore || 50,
        fundamentalScore: result.fundamentalScore || 50,
        socialScore: result.socialScore || 50,
        riskLevel: result.riskLevel || "MEDIUM",
        summary: result.summary || "",
      };
    } catch (err: any) {
      logger.error({ err: err.message }, "DeepSeek API call failed");
      throw err;
    }
  }
}

export const researchAgent = new ResearchAgent();

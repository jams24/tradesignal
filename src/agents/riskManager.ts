import { logger } from "../utils/logger";
import { config } from "../utils/config";
import { prisma } from "../db/prisma";
import type { TradeSignal, AgentResult, PortfolioState } from "../types/signals";

interface RiskAssessment {
  signalId: string;
  symbol: string;
  approved: boolean;
  maxPositionSize: number;
  suggestedLeverage: number;
  riskScore: number; // 0-100, higher = riskier
  stopLoss: number;
  reason: string;
  warnings: string[];
}

export class RiskManagerAgent {
  private name = "RISK_MANAGER";

  async assessSignals(signals: TradeSignal[]): Promise<AgentResult<RiskAssessment>> {
    const startTime = Date.now();
    const assessments: RiskAssessment[] = [];
    const portfolio = await this.getPortfolioState();

    for (const signal of signals) {
      const assessment = this.assessSignal(signal, portfolio);
      assessments.push(assessment);
    }

    logger.info({
      agent: this.name,
      signalsAssessed: signals.length,
      approved: assessments.filter(a => a.approved).length,
      rejected: assessments.filter(a => !a.approved).length,
    }, `${this.name} assessment complete`);

    return {
      agent: this.name,
      signals: assessments as any,
      metrics: {
        candidatesAnalyzed: signals.length,
        signalsGenerated: assessments.length,
        durationMs: Date.now() - startTime,
      },
    };
  }

  private async getPortfolioState(): Promise<PortfolioState> {
    try {
      const positions = await prisma.position.findMany({
        where: { status: "OPEN" },
      });

      const allocatedCapital = positions.reduce((s, p) => s + p.size, 0);
      // Assume total portfolio value — in production would pull from exchange balance
      const totalValue = 10000;

      return {
        totalValue,
        availableCapital: totalValue - allocatedCapital,
        allocatedCapital,
        totalPnl: positions.reduce((s, p) => s + (p.pnl || 0), 0),
        totalPnlPct: positions.length > 0 ? (positions.reduce((s, p) => s + (p.pnl || 0), 0) / totalValue) * 100 : 0,
        positions: positions as any,
        dailyPnl: 0,
        dailyDrawdown: 0,
        maxDrawdown: 0,
        heat: allocatedCapital / totalValue,
      };
    } catch {
      return {
        totalValue: 10000, availableCapital: 10000, allocatedCapital: 0,
        totalPnl: 0, totalPnlPct: 0, positions: [],
        dailyPnl: 0, dailyDrawdown: 0, maxDrawdown: 0, heat: 0,
      };
    }
  }

  private assessSignal(signal: TradeSignal, portfolio: PortfolioState): RiskAssessment {
    const warnings: string[] = [];
    let approved = true;
    let riskScore = 30; // base risk

    // 1. Portfolio heat check
    const openPositions = portfolio.positions.filter(p =>
      p.symbol === signal.symbol && p.direction === signal.direction,
    );

    if (openPositions.length > 0) {
      warnings.push(`Already holding ${signal.symbol} ${signal.direction}`);
      approved = false;
    }

    if (portfolio.heat > config.MAX_PORTFOLIO_HEAT) {
      warnings.push(`Portfolio heat too high: ${(portfolio.heat * 100).toFixed(0)}%`);
      approved = false;
    }

    // 2. Kelly Criterion for position sizing
    const winRate = 0.55; // assumed — would be calculated from historical data
    const avgWinPct = 0.15; // 15% average win
    const avgLossPct = 0.05; // 5% average loss
    const kellyFraction = winRate - ((1 - winRate) / (avgWinPct / avgLossPct));
    const positionSize = portfolio.totalValue * Math.max(kellyFraction * 0.25, 0.01); // quarter-Kelly

    const maxPositionSize = Math.min(
      positionSize,
      config.MAX_POSITION_SIZE_USD,
      portfolio.availableCapital * 0.8,
    );

    if (maxPositionSize < 50) {
      warnings.push("Position size too small — insufficient capital");
      approved = false;
    }

    // 3. Leverage check
    let suggestedLeverage = signal.leverage;
    if (signal.type === "MEME") suggestedLeverage = 1; // no leverage on memes
    if (suggestedLeverage > 10 && signal.confidence < 80) {
      suggestedLeverage = 10;
      warnings.push("Leverage reduced from high to 10x due to confidence");
    }

    // 4. Correlation check (avoid correlated positions)
    const correlatedPositions = portfolio.positions.filter(p =>
      p.direction === signal.direction && p.symbol !== signal.symbol,
    );
    if (correlatedPositions.length >= 3) {
      riskScore += 20;
      warnings.push(`${correlatedPositions.length} correlated ${signal.direction} positions open`);
      if (signal.confidence < 80) approved = false;
    }

    // 5. Drawdown protection
    if (portfolio.maxDrawdown > config.MAX_DRAWDOWN_PCT) {
      warnings.push(`Max drawdown exceeded: ${portfolio.maxDrawdown.toFixed(1)}%`);
      approved = false;
    }

    // 6. Risk from signal type
    switch (signal.type) {
      case "MEME": riskScore += 25; break;
      case "SMART_MONEY": riskScore += 5; break;
      case "TECHNICAL": riskScore += 10; break;
      case "ONCHAIN": riskScore += 15; break;
      case "SOCIAL": riskScore += 20; break;
      case "RESEARCH": riskScore += 5; break;
    }

    // 7. Red flags from research agent
    if (signal.redFlags && signal.redFlags.length > 0) {
      riskScore += signal.redFlags.length * 10;
      warnings.push(...signal.redFlags.map(f => `Red flag: ${f}`));
      if (signal.redFlags.includes("Known rug pull deployer")) approved = false;
    }

    // 8. Final risk check
    if (riskScore >= 80) {
      warnings.push(`Risk score too high: ${riskScore}/100`);
      approved = false;
    }

    // 9. Stop loss validation
    const stopLoss = signal.stopLoss || (signal.price ? (signal.direction === "long" ? signal.price * 0.93 : signal.price * 1.07) : 0);
    const slPct = signal.price ? Math.abs(stopLoss - signal.price) / signal.price * 100 : 7;
    if (slPct > 15) {
      warnings.push(`Stop loss too wide: ${slPct.toFixed(1)}%`);
    }

    return {
      signalId: "",
      symbol: signal.symbol,
      approved,
      maxPositionSize,
      suggestedLeverage,
      riskScore,
      stopLoss,
      reason: approved ? "Risk assessment passed" : `Rejected: ${warnings.join(". ")}`,
      warnings,
    };
  }
}

export const riskManagerAgent = new RiskManagerAgent();

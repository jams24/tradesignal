import ccxt from "ccxt";
import {
  RSI, EMA, BollingerBands, MACD, ATR,
} from "technicalindicators";
import { logger } from "../utils/logger";
import { config } from "../utils/config";
import { cexProvider } from "../data/providers/cex";
import { prisma } from "../db/prisma";
import type { TradeSignal, AgentResult, Direction, ExchangeId } from "../types/signals";

interface TechnicalCandidate {
  symbol: string;
  exchange: ExchangeId;
  direction: Direction;
  currentPrice: number;
  change24h: number;
  volumeRatio: number;
  rsi: number;
  score: number;
  signals: string[];
  atr: number;
  entryLow: number;
  entryHigh: number;
  tp1: number; tp2: number; tp3: number;
  stopLoss: number;
  tp1Pct: string; tp2Pct: string; tp3Pct: string; slPct: string;

  // Advanced
  emaAlignment: boolean;
  bbPosition: string;
  macdSignal: string;
  orderbookImbalance: number;
  oiChange24h: number;
  fundingRate: number;
}

export class TechnicalAlphaAgent {
  private name = "TECHNICAL_ALPHA";
  private timeframes = ["5m", "15m", "1h", "4h"];

  async analyze(): Promise<AgentResult<TradeSignal>> {
    const startTime = Date.now();
    const signals: TradeSignal[] = [];
    const candidates: TechnicalCandidate[] = [];

    try {
      const tickers = await cexProvider.getAllPerpTickers();

      for (const ticker of tickers) {
        try {
          const candidate = await this.deepAnalyze(ticker);
          if (candidate && candidate.score >= 55) {
            candidates.push(candidate);
          }
        } catch {
          // skip individual failures
        }
      }

      // Sort by score and take top candidates
      candidates.sort((a, b) => b.score - a.score);

      for (const c of candidates.slice(0, 20)) {
        const signal = this.buildSignal(c);
        if (signal.confidence >= config.MIN_CONVICTION_SCORE) {
          signals.push(signal);
        }
      }

      // Also check funding rate extremes on a slower cadence
      const fundingSignals = await this.checkFundingExtremes();
      signals.push(...fundingSignals);

      logger.info({
        agent: this.name,
        tickersScanned: tickers.length,
        candidatesFound: candidates.length,
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

  private async deepAnalyze(ticker: any): Promise<TechnicalCandidate | null> {
    try {
      const ohlcv: any[][] = await cexProvider.getOHLCV(ticker.exchange, ticker.symbol, "1h", 100);
      if (ohlcv.length < 50) return null;

      const closes = ohlcv.map((c: any[]) => c[4]);
      const highs = ohlcv.map((c: any[]) => c[2]);
      const lows = ohlcv.map((c: any[]) => c[3]);
      const volumes = ohlcv.map((c: any[]) => c[5]);

      const currentPrice = closes[closes.length - 1];

      // Indicators
      const rsiArr = RSI.calculate({ values: closes, period: 14 });
      const ema20Arr = EMA.calculate({ values: closes, period: 20 });
      const ema50Arr = EMA.calculate({ values: closes, period: 50 });
      const bbArr = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
      const macdArr = MACD.calculate({
        values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
        SimpleMAOscillator: false, SimpleMASignal: false,
      });
      const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });

      const currentRSI = rsiArr[rsiArr.length - 1];
      const currentMACD = macdArr[macdArr.length - 1];
      const currentATR = atrArr[atrArr.length - 1];
      const currentBB = bbArr[bbArr.length - 1];

      // Volume analysis
      const avgVolume = volumes.slice(-20).reduce((a: number, b: number) => a + b, 0) / 20;
      const currentVolume = volumes[volumes.length - 1];
      const volumeRatio = currentVolume / avgVolume;

      // Multi-timeframe EMA alignment
      const ema20 = ema20Arr[ema20Arr.length - 1];
      const ema50 = ema50Arr[ema50Arr.length - 1];
      const emaAlignment = ema20 > ema50;

      // BB position
      let bbPosition = "mid";
      if (currentBB && currentPrice > currentBB.upper) bbPosition = "above";
      else if (currentBB && currentPrice < currentBB.lower) bbPosition = "below";

      // MACD signal
      let macdSignal = "neutral";
      if (currentMACD && currentMACD.MACD! > currentMACD.signal!) macdSignal = "bullish";
      else if (currentMACD) macdSignal = "bearish";

      // Scoring system
      let score = 0;
      let direction: Direction = "long";
      const signals: string[] = [];

      // Trend
      if (emaAlignment) { score += 12; signals.push("EMA20>EMA50 (bullish trend)"); }
      else { score += 4; signals.push("EMA20<EMA50 (bearish trend)"); }

      // RSI
      if (currentRSI > 70) { score += 8; direction = "short"; signals.push(`RSI ${currentRSI.toFixed(0)} overbought`); }
      else if (currentRSI < 30) { score += 18; signals.push(`RSI ${currentRSI.toFixed(0)} oversold — bounce play`); }
      else if (currentRSI >= 50 && currentRSI <= 65) { score += 8; signals.push(`RSI ${currentRSI.toFixed(0)} bullish zone`); }
      else if (currentRSI > 65) { score += 3; signals.push(`RSI ${currentRSI.toFixed(0)} strong momentum`); }
      else signals.push(`RSI ${currentRSI.toFixed(0)} neutral`);

      // Volume
      if (volumeRatio > 3) { score += 25; signals.push(`🧨 Volume ${volumeRatio.toFixed(1)}x avg — MAJOR spike`); }
      else if (volumeRatio > 2) { score += 18; signals.push(`📊 Volume ${volumeRatio.toFixed(1)}x avg — breakout`); }
      else if (volumeRatio > 1.5) { score += 10; signals.push(`Volume ${volumeRatio.toFixed(1)}x avg`); }
      else if (volumeRatio > 1) { score += 4; signals.push(`Above average volume`); }

      // BB
      if (bbPosition === "above") { score += 12; signals.push("BB upper breakout — strong momentum"); }
      else if (bbPosition === "below") { score += 15; signals.push("BB lower touch — reversal potential"); }

      // MACD
      if (macdSignal === "bullish") { score += 10; signals.push("MACD bullish"); }
      else if (macdSignal === "bearish") { score += 8; direction = "short"; signals.push("MACD bearish"); }

      // 24h change
      const change = Math.abs(ticker.percentage);
      if (change > 20) { score += 12; signals.push(`Volatile: ${change.toFixed(1)}% 24h`); }
      else if (change > 10) score += 8;
      else if (change > 5) score += 4;

      // Funding rate consideration
      if (ticker.fundingRate > 0.0005) {
        score += 5; direction = "short";
        signals.push("Funding rate elevated — short bias");
      } else if (ticker.fundingRate < -0.0003) {
        score += 5;
        signals.push("Funding rate negative — long bias");
      }

      if (score < 45) return null;

      // Calculate TP/SL using ATR
      const atrValue = currentATR || currentPrice * 0.025;
      const isLong = direction === "long";

      const entryLow = isLong ? currentPrice * 0.993 : currentPrice * 1.007;
      const entryHigh = isLong ? currentPrice * 1.007 : currentPrice * 0.993;
      const tp1 = isLong ? currentPrice + atrValue * 1.5 : currentPrice - atrValue * 1.5;
      const tp2 = isLong ? currentPrice + atrValue * 3 : currentPrice - atrValue * 3;
      const tp3 = isLong ? currentPrice + atrValue * 5 : currentPrice - atrValue * 5;
      const stopLoss = isLong ? currentPrice - atrValue * 1.5 : currentPrice + atrValue * 1.5;

      return {
        symbol: ticker.symbol,
        exchange: ticker.exchange,
        direction,
        currentPrice,
        change24h: ticker.percentage,
        volumeRatio,
        rsi: currentRSI,
        score,
        signals,
        atr: atrValue,
        entryLow: parseFloat(entryLow.toPrecision(6)),
        entryHigh: parseFloat(entryHigh.toPrecision(6)),
        tp1: parseFloat(tp1.toPrecision(6)),
        tp2: parseFloat(tp2.toPrecision(6)),
        tp3: parseFloat(tp3.toPrecision(6)),
        stopLoss: parseFloat(stopLoss.toPrecision(6)),
        tp1Pct: ((Math.abs(tp1 - currentPrice) / currentPrice) * 100).toFixed(1),
        tp2Pct: ((Math.abs(tp2 - currentPrice) / currentPrice) * 100).toFixed(1),
        tp3Pct: ((Math.abs(tp3 - currentPrice) / currentPrice) * 100).toFixed(1),
        slPct: ((Math.abs(stopLoss - currentPrice) / currentPrice) * 100).toFixed(1),
        emaAlignment,
        bbPosition,
        macdSignal,
        orderbookImbalance: 0,
        oiChange24h: 0,
        fundingRate: ticker.fundingRate,
      };
    } catch {
      return null;
    }
  }

  private async checkFundingExtremes(): Promise<TradeSignal[]> {
    const signals: TradeSignal[] = [];

    try {
      const rates = await cexProvider.getFundingRates();

      for (const { symbol, exchange, rate } of rates) {
        const cleanSymbol = symbol.replace("/USDT:USDT", "").replace("/USDT", "");

        if (rate > 0.002) {
          signals.push({
            type: "TECHNICAL",
            symbol: cleanSymbol,
            chain: "unknown",
            direction: "short",
            confidence: 55,
            score: 55,
            leverage: 3,
            exchange,
            catalyst: `Extreme funding rate ${(rate * 100).toFixed(3)}% — crowded longs on ${exchange}`,
            thesis: `Funding rate at ${(rate * 100).toFixed(3)}% indicates overcrowded longs. ` +
                   `Mean reversion expected. Short with tight stop.`,
            sources: ["TECHNICAL"],
            agentScores: { TECHNICAL_ALPHA: 55 },
          });
        } else if (rate < -0.0015) {
          signals.push({
            type: "TECHNICAL",
            symbol: cleanSymbol,
            chain: "unknown",
            direction: "long",
            confidence: 55,
            score: 55,
            leverage: 3,
            exchange,
            catalyst: `Negative funding ${(rate * 100).toFixed(3)}% — crowded shorts on ${exchange}`,
            thesis: `Negative funding at ${(rate * 100).toFixed(3)}% suggests crowded shorts. ` +
                   `Potential short squeeze.`,
            sources: ["TECHNICAL"],
            agentScores: { TECHNICAL_ALPHA: 55 },
          });
        }
      }
    } catch (err: any) {
      logger.error(`Funding rate analysis failed: ${err.message}`);
    }

    return signals;
  }

  private buildSignal(c: TechnicalCandidate): TradeSignal {
    const confidence = c.score >= 80 ? 5 : c.score >= 65 ? 4 : 3;

    return {
      type: "TECHNICAL",
      symbol: c.symbol,
      chain: "unknown",
      direction: c.direction,
      confidence: Math.min(c.score + 5, 90),
      score: c.score,
      price: c.currentPrice,
      entryLow: c.entryLow,
      entryHigh: c.entryHigh,
      tp1: c.tp1, tp2: c.tp2, tp3: c.tp3,
      stopLoss: c.stopLoss,
      tp1Pct: c.tp1Pct, tp2Pct: c.tp2Pct, tp3Pct: c.tp3Pct, slPct: c.slPct,
      leverage: c.score >= 70 ? 10 : 5,
      exchange: c.exchange,
      catalyst: c.signals.join(" | "),
      thesis: `Technical confluence on ${c.exchange}: ${c.signals.slice(0, 4).join(", ")}. ` +
             `RSI: ${c.rsi.toFixed(0)}, Vol: ${c.volumeRatio.toFixed(1)}x, ` +
             `BB: ${c.bbPosition}, MACD: ${c.macdSignal}. Score: ${c.score}/100`,
      sources: ["TECHNICAL"],
      agentScores: { TECHNICAL_ALPHA: c.score },
    };
  }
}

export const technicalAlphaAgent = new TechnicalAlphaAgent();

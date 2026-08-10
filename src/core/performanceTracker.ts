import { logger } from "../utils/logger";
import { prisma } from "../db/prisma";
import { cexProvider } from "../data/providers/cex";
import type { ExchangeId, Direction } from "../types/signals";

export interface TrackedSignal {
  id: string;
  symbol: string;
  type: string;
  direction: Direction;
  confidence: number;
  alertPrice: number | null;
  currentPrice: number | null;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  stopLoss: number | null;
  pnlPct: number | null;
  hitTp1: boolean;
  hitSl: boolean;
  createdAt: Date;
  age: string;
}

export class PerformanceTracker {
  private activeSignals: Map<string, TrackedSignal> = new Map();

  async refresh(): Promise<TrackedSignal[]> {
    try {
      // Load all active signals, dedup by symbol (keep first alert only)
      const dbSignals = await prisma.signal.findMany({
        where: { status: "ACTIVE" },
        orderBy: { createdAt: "asc" },
      });

      // Deduplicate + filter: only tradeable symbols with alert price
      const seen = new Set<string>();
      const uniqueSignals = dbSignals.filter(s => {
        const key = s.symbol;
        if (seen.has(key)) return false;
        seen.add(key);
        // Filter out contract addresses (40+ char hex) and symbols without price
        if (!s.price) return false;
        if (s.symbol.length > 20) return false;
        if (s.symbol.includes("..")) return false;
        if (s.symbol === "TOKEN" || s.symbol === "NEW_TOKEN") return false;
        return true;
      });

      // Fetch current prices — try Binance, Gate, Bybit
      const symbols = uniqueSignals.map(s => s.symbol);
      const priceMap = new Map<string, number>();

      const exchanges = ["binance", "gate", "bybit", "mexc", "bitget"] as const;
      for (const exId of exchanges) {
        const ex = cexProvider.getExchange(exId);
        if (!ex) continue;
        try {
          const remaining = symbols.filter(s => !priceMap.has(s));
          if (remaining.length === 0) break;

          // Try both spot (/USDT) and perp (/USDT:USDT) formats
          const spotPairs = remaining.map(s => `${s}/USDT`);
          const perpPairs = remaining.map(s => `${s}/USDT:USDT`);
          const allPairs = [...spotPairs, ...perpPairs].slice(0, 50);

          const tickers = await ex.fetchTickers(allPairs) as Record<string, any>;
          for (const [pair, ticker] of Object.entries(tickers)) {
            const sym = pair.replace("/USDT:USDT", "").replace("/USDT", "");
            if (ticker.last && !priceMap.has(sym)) {
              priceMap.set(sym, ticker.last);
            }
          }
        } catch { /* next exchange */ }
      }

      // Build tracked signals
      const result: TrackedSignal[] = [];
      const now = Date.now();

      for (const db of uniqueSignals) {
        const currentPrice = priceMap.get(db.symbol) || null;
        const alertPrice = db.price || null;
        const direction = db.direction as Direction;

        let pnlPct: number | null = null;
        let hitTp1 = false;
        let hitSl = false;

        if (alertPrice && currentPrice && alertPrice > 0) {
          if (direction === "long") {
            pnlPct = ((currentPrice - alertPrice) / alertPrice) * 100;
            if (db.tp1 && currentPrice >= db.tp1) hitTp1 = true;
            if (db.stopLoss && currentPrice <= db.stopLoss) hitSl = true;
          } else {
            pnlPct = ((alertPrice - currentPrice) / alertPrice) * 100;
            if (db.tp1 && currentPrice <= db.tp1) hitTp1 = true;
            if (db.stopLoss && currentPrice >= db.stopLoss) hitSl = true;
          }
        }

        const ageMs = now - db.createdAt.getTime();
        const ageHours = Math.floor(ageMs / 3600000);
        const ageMins = Math.floor((ageMs % 3600000) / 60000);
        const age = ageHours > 0 ? `${ageHours}h ${ageMins}m` : `${ageMins}m`;

        const t: TrackedSignal = {
          id: db.id,
          symbol: db.symbol,
          type: db.type,
          direction,
          confidence: db.confidence,
          alertPrice,
          currentPrice,
          tp1: db.tp1 || null,
          tp2: db.tp2 || null,
          tp3: db.tp3 || null,
          stopLoss: db.stopLoss || null,
          pnlPct,
          hitTp1,
          hitSl,
          createdAt: db.createdAt,
          age,
        };

        this.activeSignals.set(db.symbol, t);
        result.push(t);
      }

      return result;
    } catch (err: any) {
      logger.error({ err: err.message }, "Performance refresh failed");
      return [];
    }
  }

  getTracked(): TrackedSignal[] {
    return [...this.activeSignals.values()].sort((a, b) =>
      b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  getSummary(): {
    total: number;
    profitable: number;
    unprofitable: number;
    avgPnl: number;
    bestPerformer: TrackedSignal | null;
    worstPerformer: TrackedSignal | null;
    tp1Hit: number;
    slHit: number;
  } {
    const all = this.getTracked().filter(s => s.pnlPct !== null);
    const profitable = all.filter(s => (s.pnlPct || 0) > 0);
    const sorted = [...all].sort((a, b) => (b.pnlPct || 0) - (a.pnlPct || 0));

    return {
      total: all.length,
      profitable: profitable.length,
      unprofitable: all.length - profitable.length,
      avgPnl: all.length > 0 ? all.reduce((s, t) => s + (t.pnlPct || 0), 0) / all.length : 0,
      bestPerformer: sorted[0] || null,
      worstPerformer: sorted[sorted.length - 1] || null,
      tp1Hit: all.filter(s => s.hitTp1).length,
      slHit: all.filter(s => s.hitSl).length,
    };
  }
}

export const performanceTracker = new PerformanceTracker();

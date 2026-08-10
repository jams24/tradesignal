import { logger } from "../utils/logger";
import { prisma } from "../db/prisma";
import type { Direction } from "../types/signals";

async function fetchPricesFromBinance(symbols: string[]): Promise<Map<string, number>> {
  const priceMap = new Map<string, number>();
  try {
    const axios = require("axios");

    // Binance spot
    const { data: binanceData } = await axios.get("https://api.binance.com/api/v3/ticker/price", { timeout: 5000 });
    for (const item of binanceData || []) {
      if (item.symbol.endsWith("USDT")) {
        const sym = item.symbol.replace("USDT", "");
        if (symbols.includes(sym)) priceMap.set(sym, parseFloat(item.price));
      }
    }
  } catch { /* silent */ }

  // Gate for symbols not on Binance
  const missing = symbols.filter(s => !priceMap.has(s));
  if (missing.length > 0) {
    try {
      const axios = require("axios");
      const { data: gateData } = await axios.get("https://api.gate.io/api2/1/tickers", { timeout: 5000 });
      for (const item of gateData || []) {
        if (item.currency_pair?.endsWith("_USDT")) {
          const sym = item.currency_pair.replace("_USDT", "").toUpperCase();
          if (missing.includes(sym) && item.last) {
            priceMap.set(sym, parseFloat(item.last));
          }
        }
      }
    } catch { /* silent */ }
  }

  // Bybit for remaining
  const stillMissing = symbols.filter(s => !priceMap.has(s));
  if (stillMissing.length > 0) {
    try {
      const axios = require("axios");
      const { data: bybitData } = await axios.get(
        "https://api.bybit.com/v5/market/tickers?category=spot",
        { timeout: 5000 },
      );
      const list = bybitData?.result?.list || [];
      for (const item of list) {
        if (item.symbol?.endsWith("USDT")) {
          const sym = item.symbol.replace("USDT", "");
          if (stillMissing.includes(sym) && item.lastPrice) {
            priceMap.set(sym, parseFloat(item.lastPrice));
          }
        }
      }
    } catch { /* silent */ }
  }

  return priceMap;
}

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
  hitTp2: boolean;
  hitTp3: boolean;
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
        orderBy: [{ price: { sort: "desc", nulls: "last" } }, { createdAt: "asc" }],
      });

      // Deduplicate: first signal per symbol, prefer ones with price
      const seen = new Set<string>();
      const uniqueSignals = dbSignals.filter(s => {
        const key = s.symbol;
        if (seen.has(key)) return false;
        // Skip this unpriced signal if we already have a priced one for same symbol
        if (!s.price) {
          // Check if a priced version exists later
          const hasPriced = dbSignals.some(other => other.symbol === s.symbol && other.price && other.id !== s.id);
          if (hasPriced) return false;
        }
        seen.add(key);
        // Filter out contract addresses
        if (s.symbol.length > 15) return false;
        if (s.symbol.includes("..")) return false;
        if (s.symbol === "TOKEN" || s.symbol === "NEW_TOKEN") return false;
        return true;
      });

      // Fetch current prices using Binance public API (instant, no auth)
      const symbols = uniqueSignals.map(s => s.symbol);
      const priceMap = await fetchPricesFromBinance(symbols);

      // Build tracked signals
      const result: TrackedSignal[] = [];
      const now = Date.now();

      for (const db of uniqueSignals) {
        const currentPrice = priceMap.get(db.symbol) || null;
        const alertPrice = db.price || null;
        const direction = db.direction as Direction;

        let pnlPct: number | null = null;
        let hitTp1 = false;
        let hitTp2 = false;
        let hitTp3 = false;
        let hitSl = false;

        if (alertPrice && currentPrice && alertPrice > 0) {
          if (direction === "long") {
            pnlPct = ((currentPrice - alertPrice) / alertPrice) * 100;
            if (db.tp1 && currentPrice >= db.tp1) hitTp1 = true;
            if (db.tp2 && currentPrice >= db.tp2) hitTp2 = true;
            if (db.tp3 && currentPrice >= db.tp3) hitTp3 = true;
            if (db.stopLoss && currentPrice <= db.stopLoss) hitSl = true;
          } else {
            pnlPct = ((alertPrice - currentPrice) / alertPrice) * 100;
            if (db.tp1 && currentPrice <= db.tp1) hitTp1 = true;
            if (db.tp2 && currentPrice <= db.tp2) hitTp2 = true;
            if (db.tp3 && currentPrice <= db.tp3) hitTp3 = true;
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
          hitTp2,
          hitTp3,
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
    tp2Hit: number;
    tp3Hit: number;
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
      tp2Hit: all.filter(s => s.hitTp2).length,
      tp3Hit: all.filter(s => s.hitTp3).length,
      slHit: all.filter(s => s.hitSl).length,
    };
  }
}

export const performanceTracker = new PerformanceTracker();

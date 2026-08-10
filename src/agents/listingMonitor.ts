import axios from "axios";
import { logger } from "../utils/logger";
import { config } from "../utils/config";
import { prisma } from "../db/prisma";
import { cexProvider } from "../data/providers/cex";
import type { TradeSignal, AgentResult, ExchangeId } from "../types/signals";

interface ListingCandidate {
  symbol: string;
  exchange: ExchangeId;
  type: "spot" | "perp";
  detectedAt: number;
  isNew: boolean;
  source: "api" | "announcement";
  announcementTitle?: string;
  confidence: number;
}

export class ListingMonitorAgent {
  private name = "LISTING_MONITOR";
  private knownPairs: Set<string> = new Set();
  private seeded = false;

  async analyze(): Promise<AgentResult<TradeSignal>> {
    const startTime = Date.now();
    const candidates: ListingCandidate[] = [];
    const signals: TradeSignal[] = [];

    try {
      const exchangeIds: ExchangeId[] = ["binance", "mexc", "bybit", "bitget", "okx", "gate"];

      // Seed known pairs on first run (load all existing markets without alerting)
      if (!this.seeded) {
        for (const exchangeId of exchangeIds) {
          const exchange = cexProvider.getExchange(exchangeId);
          if (!exchange) continue;
          try {
            for (const [symbol, market] of Object.entries(exchange.markets || {})) {
              const m = market as any;
              if (m.active && m.quote === "USDT") {
                const key = `${exchangeId}:${m.swap ? "perp" : "spot"}:${symbol}`;
                this.knownPairs.add(key);
              }
            }
          } catch { /* skip */ }
        }
        this.seeded = true;
        logger.info(`Seeded ${this.knownPairs.size} known pairs across ${exchangeIds.length} exchanges`);
      }

      // 1. Check for truly new pairs via CCXT
      for (const exchangeId of exchangeIds) {
        const exchange = cexProvider.getExchange(exchangeId);
        if (!exchange) continue;

        try {
          await exchange.loadMarkets(true);
          const markets = exchange.markets;
          let newThisRun = 0;

          for (const [symbol, market] of Object.entries(markets || {})) {
            const m = market as any;
            if (!m.active) continue;
            if (!m.quote || m.quote !== "USDT") continue;

            const marketType = m.swap ? "perp" : "spot";
            const key = `${exchangeId}:${marketType}:${symbol}`;

            if (!this.knownPairs.has(key)) {
              this.knownPairs.add(key);
              newThisRun++;

              candidates.push({
                symbol: m.base as string,
                exchange: exchangeId,
                type: marketType as "spot" | "perp",
                detectedAt: Date.now(),
                isNew: true,
                source: "api",
                confidence: marketType === "perp" ? 85 : 70,
              });
            }
          }

          if (newThisRun > 0) {
            logger.info(`Found ${newThisRun} new pairs on ${exchangeId}`);
          }
        } catch (err: any) {
          logger.error(`Listing check failed for ${exchangeId}: ${err.message}`);
        }
      }

      // 2. Check Binance announcement feed for upcoming listings
      const binanceAnnouncements = await this.scrapeBinanceAnnouncements();
      for (const ann of binanceAnnouncements) {
        const key = `binance:announcement:${ann.symbol}`;
        if (this.knownPairs.has(key)) continue;
        this.knownPairs.add(key);

        candidates.push({
          symbol: ann.symbol,
          exchange: "binance",
          type: "perp",
          detectedAt: Date.now(),
          isNew: true,
          source: "announcement",
          announcementTitle: ann.title,
          confidence: 90,
        });
      }

      // Generate signals from ACTUALLY new listings
      for (const c of candidates) {
        const signal = this.buildListingSignal(c);
        if (signal.confidence >= config.MIN_CONVICTION_SCORE) {
          signals.push(signal);
        }
      }

      if (candidates.length > 0 || signals.length > 0) {
        logger.info({
          agent: this.name,
          newPairs: candidates.length,
          signals: signals.length,
          knownTotal: this.knownPairs.size,
        }, `${this.name} scan complete`);
      }
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

  private async scrapeBinanceAnnouncements(): Promise<Array<{ symbol: string; title: string }>> {
    const results: Array<{ symbol: string; title: string }> = [];
    const skipWords = new Set(["multiple", "new", "usd", "margined", "tradfi", "perpetual", "contracts", "futures", "will", "launch", "list", "lists"]);

    try {
      const { data } = await axios.get(
        "https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&catalogId=48&pageNo=1&pageSize=10",
        {
          headers: {
            "User-Agent": "Mozilla/5.0",
            "Accept": "application/json",
            "Accept-Language": "en-US,en;q=0.9",
          },
          timeout: 10000,
        },
      );

      const articles = data?.data?.catalogs?.[0]?.articles || [];
      const now = Date.now();
      for (const article of articles) {
        const title = article.title || "";
        // Skip articles older than 2 days (172800000 ms)
        const releaseDate = article.releaseDate || 0;
        if (releaseDate > 0 && now - releaseDate > 172800000) continue;

        const listingMatch = title.match(/(?:Binance\s+)?(?:Will\s+List|Lists?|Launches?)\s+(\w+)/i);
        const perpetualMatch = title.match(/(?:USD[Ⓢ]-M\s+)?(\w+)\s+(?:Perpetual|PERP)/i);
        const futuresMatch = title.match(/(?:Futures\s+)?(?:Will\s+List|Lists?)\s+(\w+)/i);

        const symbol = listingMatch?.[1] || perpetualMatch?.[1] || futuresMatch?.[1];
        if (symbol && !skipWords.has(symbol.toLowerCase())) {
          results.push({ symbol: symbol.toUpperCase(), title });
          logger.info(`Binance announcement: ${title}`);
        }
      }
    } catch (err: any) {
      // Silently fail — announcement pages often block scrapers
    }

    return results;
  }

  private buildListingSignal(c: ListingCandidate): TradeSignal {
    const type = c.type === "perp" ? "PERPETUAL" : "SPOT";
    const sourceLabel = c.source === "announcement" ? "official announcement" : "exchange API";

    return {
      type: "LISTING",
      symbol: c.symbol,
      chain: "unknown",
      direction: "long",
      confidence: c.confidence,
      score: c.confidence - 5,
      leverage: c.type === "perp" ? 5 : 1,
      exchange: c.exchange,
      catalyst: `\u{1F680} New ${type} listing on ${c.exchange.toUpperCase()} via ${sourceLabel}`,
      thesis: `${c.symbol} just listed on ${c.exchange.toUpperCase()} as a ${type} market. ` +
             `New CEX listings on ${c.exchange} typically see high volatility in the first 30 minutes. ` +
             `${c.type === "perp" ? "Can trade with leverage." : "Spot only — consider capital allocation timing."} ` +
             `${c.announcementTitle ? "Title: " + c.announcementTitle : ""}`.trim(),
      sources: ["LISTING"],
      agentScores: { LISTING_MONITOR: c.confidence },
    };
  }
}

export const listingMonitorAgent = new ListingMonitorAgent();

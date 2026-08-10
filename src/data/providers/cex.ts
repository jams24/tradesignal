import ccxt, { Exchange } from "ccxt";
import { logger } from "../../utils/logger";
import { config } from "../../utils/config";
import type { ExchangeId } from "../../types/signals";

export interface CexTicker {
  symbol: string;
  exchange: ExchangeId;
  last: number;
  bid: number;
  ask: number;
  high: number;
  low: number;
  baseVolume: number;
  quoteVolume: number;
  percentage: number;
  spread: number;
  timestamp: number;
}

export interface PerpMarket extends CexTicker {
  fundingRate: number;
  openInterest: number;
  markPrice: number;
  indexPrice: number;
}

interface ExchangeCredentials {
  apiKey: string | undefined;
  secret: string | undefined;
}

export class CexDataProvider {
  private exchanges: Map<ExchangeId, Exchange> = new Map();
  private readonly targetExchanges: { id: ExchangeId; klass: any; creds: ExchangeCredentials }[];

  constructor() {
    this.targetExchanges = [
      { id: "binance", klass: ccxt.binance, creds: { apiKey: config.BINANCE_API_KEY, secret: config.BINANCE_SECRET } },
      { id: "bybit", klass: ccxt.bybit, creds: { apiKey: config.BYBIT_API_KEY, secret: config.BYBIT_SECRET } },
      { id: "mexc", klass: ccxt.mexc, creds: { apiKey: config.MEXC_API_KEY, secret: config.MEXC_SECRET } },
      { id: "bitget", klass: ccxt.bitget, creds: { apiKey: config.BITGET_API_KEY, secret: config.BITGET_SECRET } },
      { id: "okx", klass: ccxt.okx, creds: { apiKey: undefined, secret: undefined } },
      { id: "gate", klass: ccxt.gate, creds: { apiKey: undefined, secret: undefined } },
    ];
  }

  async init(): Promise<void> {
    for (const { id, klass, creds } of this.targetExchanges) {
      try {
        const exchange: Exchange = new klass({
          apiKey: creds.apiKey,
          secret: creds.secret,
          enableRateLimit: true,
        });
        await exchange.loadMarkets();
        this.exchanges.set(id, exchange);
        logger.info(`CEX provider initialized: ${id}`);
      } catch (err: any) {
        logger.warn(`CEX ${id} init failed: ${err.message}`);
      }
    }
    logger.info(`CEX provider ready: ${this.exchanges.size} exchanges`);
  }

  async getAllPerpTickers(): Promise<PerpMarket[]> {
    const results: PerpMarket[] = [];

    for (const [exchangeId, exchange] of this.exchanges) {
      try {
        const perpSymbols: string[] = (Object.values(exchange.markets || {}) as any[])
          .filter((m: any) => m.swap && m.quote === "USDT" && m.active)
          .map((m: any) => m.symbol);

        if (perpSymbols.length === 0) continue;

        const rawTickers: any = await exchange.fetchTickers(perpSymbols.slice(0, 200));
        const tickers = rawTickers as Record<string, any>;

        for (const [symbol, ticker] of Object.entries(tickers)) {
          const t = ticker as any;
          results.push({
            symbol: symbol.replace("/USDT:USDT", "").replace("/USDT", ""),
            exchange: exchangeId,
            last: t.last || 0,
            bid: t.bid || 0,
            ask: t.ask || 0,
            high: t.high || 0,
            low: t.low || 0,
            baseVolume: t.baseVolume || 0,
            quoteVolume: t.quoteVolume || 0,
            percentage: t.percentage || 0,
            spread: t.bid && t.ask ? ((t.ask - t.bid) / t.ask) * 100 : 0,
            timestamp: t.timestamp || Date.now(),
            fundingRate: t.info?.fundingRate || t.fundingRate || 0,
            openInterest: t.info?.openInterest || 0,
            markPrice: t.info?.markPrice || t.last || 0,
            indexPrice: t.info?.indexPrice || t.last || 0,
          });
        }
      } catch (err: any) {
        logger.error(`Ticker fetch failed for ${exchangeId}: ${err.message}`);
      }
    }

    return results;
  }

  async getNewListings(exchangeId: ExchangeId): Promise<Array<{ symbol: string; type: "spot" | "perp" }>> {
    const exchange = this.exchanges.get(exchangeId);
    if (!exchange) return [];

    try {
      await exchange.loadMarkets(true);
      const markets: any = exchange.markets;

      return (Object.values(markets) as any[])
        .filter((m: any) => m.active)
        .map((m: any) => ({
          symbol: m.base as string,
          type: m.swap ? "perp" as const : "spot" as const,
        }));
    } catch (err: any) {
      logger.error(`Listing fetch failed for ${exchangeId}: ${err.message}`);
      return [];
    }
  }

  async getOHLCV(exchangeId: ExchangeId, symbol: string, timeframe = "1h", limit = 100): Promise<any[][]> {
    const exchange = this.exchanges.get(exchangeId);
    if (!exchange) return [];

    try {
      return (await exchange.fetchOHLCV(symbol, timeframe, undefined, limit)) as any[][];
    } catch {
      return [];
    }
  }

  async getOrderBook(exchangeId: ExchangeId, symbol: string, depth = 20): Promise<any> {
    const exchange = this.exchanges.get(exchangeId);
    if (!exchange) return null;

    try {
      return await exchange.fetchOrderBook(symbol, depth);
    } catch {
      return null;
    }
  }

  async getFundingRates(): Promise<Array<{ symbol: string; exchange: ExchangeId; rate: number }>> {
    const results: Array<{ symbol: string; exchange: ExchangeId; rate: number }> = [];

    for (const [exchangeId, exchange] of this.exchanges) {
      try {
        if (!exchange.has.fetchFundingRates) continue;
        const rates = await exchange.fetchFundingRates();

        for (const [symbol, info] of Object.entries(rates)) {
          const rate = (info as any).fundingRate;
          if (rate !== undefined && rate !== null) {
            results.push({ symbol, exchange: exchangeId, rate });
          }
        }
      } catch (err: any) {
        logger.error(`Funding rate fetch failed for ${exchangeId}: ${err.message}`);
      }
    }

    return results;
  }

  getExchange(exchangeId: ExchangeId): Exchange | undefined {
    return this.exchanges.get(exchangeId);
  }

  getExchangeIds(): ExchangeId[] {
    return Array.from(this.exchanges.keys());
  }
}

export const cexProvider = new CexDataProvider();

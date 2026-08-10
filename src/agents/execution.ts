import { logger } from "../utils/logger";
import { config } from "../utils/config";
import { cexProvider } from "../data/providers/cex";
import { prisma } from "../db/prisma";
import type { TradeSignal, AgentResult, ExchangeId, Direction } from "../types/signals";

interface ExecutionOrder {
  signalId: string;
  symbol: string;
  exchange: ExchangeId;
  direction: Direction;
  size: number;
  leverage: number;
  entryPrice: number;
  stopLoss: number;
  tp1?: number;
  tp2?: number;
  tp3?: number;
  type: "MARKET" | "LIMIT";
  limitPrice?: number;
  slippagePct: number;
  status: "PENDING" | "APPROVED" | "EXECUTING" | "FILLED" | "CANCELLED" | "REJECTED";
  approvalKey: string; // unique key for Telegram approval
  executedAt?: number;
  fillPrice?: number;
  txId?: string;
  error?: string;
}

export class ExecutionAgent {
  private name = "EXECUTION";
  private pendingOrders: Map<string, ExecutionOrder> = new Map();
  private approvedOrders: Set<string> = new Set();

  createOrder(signal: TradeSignal, positionSize: number, leverage: number): ExecutionOrder | null {
    const exchange = signal.exchange || "binance";

    if (!cexProvider.getExchange(exchange)) {
      logger.warn(`No credentials for exchange ${exchange}`);
      return null;
    }

    const approvalKey = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const direction = signal.direction as Direction;
    const currentPrice = signal.price || 0;

    let entryPrice = currentPrice;
    let type: "MARKET" | "LIMIT" = "LIMIT";

    // Use limit orders for most executions (better price, less slippage)
    const limitPrice = direction === "long"
      ? currentPrice * (1 - 0.001)  // bid slightly below
      : currentPrice * (1 + 0.001);  // ask slightly above

    // Market order for urgent/volatile signals
    if (signal.type === "SMART_MONEY" || signal.confidence >= 85) {
      type = "MARKET";
    }

    const order: ExecutionOrder = {
      signalId: "",
      symbol: signal.symbol,
      exchange,
      direction,
      size: positionSize,
      leverage,
      entryPrice: currentPrice,
      stopLoss: signal.stopLoss || (direction === "long" ? currentPrice * 0.93 : currentPrice * 1.07),
      tp1: signal.tp1,
      tp2: signal.tp2,
      tp3: signal.tp3,
      type,
      limitPrice: type === "LIMIT" ? parseFloat(limitPrice.toPrecision(6)) : undefined,
      slippagePct: config.MAX_SLIPPAGE_PCT,
      status: "PENDING",
      approvalKey,
    };

    this.pendingOrders.set(approvalKey, order);
    logger.info({ order: { symbol: signal.symbol, direction, size: positionSize, key: approvalKey } }, "Execution order created — awaiting approval");

    return order;
  }

  approveOrder(approvalKey: string): boolean {
    if (this.approvedOrders.has(approvalKey)) return true;

    const order = this.pendingOrders.get(approvalKey);
    if (!order) {
      logger.warn(`Order not found: ${approvalKey}`);
      return false;
    }

    this.approvedOrders.add(approvalKey);
    order.status = "APPROVED";

    // Execute in background
    this.execute(order).catch(err => {
      logger.error({ order: order.symbol, err: err.message }, "Order execution failed");
    });

    return true;
  }

  rejectOrder(approvalKey: string, reason: string): boolean {
    const order = this.pendingOrders.get(approvalKey);
    if (!order) return false;

    order.status = "REJECTED";
    order.error = reason;
    logger.info({ order: order.symbol, reason }, "Order rejected");
    return true;
  }

  private async execute(order: ExecutionOrder): Promise<void> {
    order.status = "EXECUTING";
    const exchange = cexProvider.getExchange(order.exchange);
    if (!exchange) {
      order.status = "REJECTED";
      order.error = "Exchange not available";
      return;
    }

    try {
      const symbol = `${order.symbol}/USDT`;
      const params: any = {};

      if (order.leverage > 1) {
        // Set leverage
        try {
          await exchange.setLeverage(order.leverage, symbol);
        } catch (e: any) {
          logger.warn(`Failed to set leverage: ${e.message}`);
        }
      }

      if (order.type === "LIMIT" && order.limitPrice) {
        // Place limit order
        const result = await exchange.createOrder(
          symbol,
          "limit",
          order.direction === "long" ? "buy" : "sell",
          order.size / order.entryPrice, // convert USD to quantity
          order.limitPrice,
          params,
        );

        order.fillPrice = order.limitPrice;
        order.txId = result.id;
        order.executedAt = Date.now();
        order.status = "FILLED";
        logger.info({ order: { symbol: order.symbol, price: order.fillPrice, id: order.txId } }, "Limit order filled");
      } else {
        // Market order — simplified: use current price for semi-auto
        const ticker = await exchange.fetchTicker(symbol);
        order.fillPrice = order.direction === "long" ? ticker.ask : ticker.bid;
        order.executedAt = Date.now();
        order.status = "FILLED";
        logger.info({ order: { symbol: order.symbol, price: order.fillPrice } }, "Market order filled (current price used)");
      }

      // Record position in DB
      await prisma.position.create({
        data: {
          signalId: order.signalId,
          symbol: order.symbol,
          exchange: order.exchange,
          chain: "cex",
          direction: order.direction,
          entryPrice: order.fillPrice || order.entryPrice,
          size: order.size,
          leverage: order.leverage,
          tp1: order.tp1,
          tp2: order.tp2,
          tp3: order.tp3,
          stopLoss: order.stopLoss,
          status: "OPEN",
        },
      });

    } catch (err: any) {
      order.status = "REJECTED";
      order.error = err.message;
      logger.error({ order: order.symbol, err: err.message }, "Order execution failed");
    }
  }

  async checkStopLosses(): Promise<void> {
    try {
      const positions = await prisma.position.findMany({ where: { status: "OPEN" } });

      for (const pos of positions) {
        const exchange = cexProvider.getExchange(pos.exchange as ExchangeId);
        if (!exchange) continue;

        try {
          const ticker = await exchange.fetchTicker(`${pos.symbol}/USDT`);
          const currentPrice = ticker.last || 0;

          if (currentPrice <= 0) continue;

          const isLong = pos.direction === "long";
          const slHit = isLong ? currentPrice <= pos.stopLoss : currentPrice >= pos.stopLoss;

          if (slHit) {
            const pnl = isLong
              ? (currentPrice - pos.entryPrice) / pos.entryPrice * pos.size * pos.leverage
              : (pos.entryPrice - currentPrice) / pos.entryPrice * pos.size * pos.leverage;

            const pnlPct = ((pnl / pos.size) * 100);

            await prisma.position.update({
              where: { id: pos.id },
              data: { status: "STOPPED_OUT", pnl, pnlPct, currentPrice, closedAt: new Date() },
            });

            logger.warn({ position: pos.symbol, pnl: pnl.toFixed(2), exitPrice: currentPrice }, "Stop loss hit");
          } else {
            // Update current price / PnL
            const pnl = isLong
              ? (currentPrice - pos.entryPrice) / pos.entryPrice * pos.size * pos.leverage
              : (pos.entryPrice - currentPrice) / pos.entryPrice * pos.size * pos.leverage;

            await prisma.position.update({
              where: { id: pos.id },
              data: { currentPrice, pnl, pnlPct: (pnl / pos.size) * 100 },
            });
          }
        } catch {
          // skip individual position errors
        }
      }
    } catch (err: any) {
      logger.error(`Stop loss check failed: ${err.message}`);
    }
  }

  getPendingOrder(key: string): ExecutionOrder | undefined {
    return this.pendingOrders.get(key);
  }
}

export const executionAgent = new ExecutionAgent();

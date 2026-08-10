import { EventEmitter } from "events";
import { logger } from "../utils/logger";

export interface DataFeed<T> {
  start(): Promise<void>;
  stop(): void;
  on(event: "data", handler: (data: T) => void): void;
  on(event: "error", handler: (error: Error) => void): void;
}

export abstract class BaseDataFeed<T> extends EventEmitter {
  protected running = false;
  protected interval?: NodeJS.Timeout;
  protected abstract intervalMs: number;
  protected abstract name: string;

  abstract fetch(): Promise<T[]>;

  async start(): Promise<void> {
    this.running = true;
    logger.info({ feed: this.name }, "Data feed starting");

    const poll = async () => {
      if (!this.running) return;
      try {
        const data = await this.fetch();
        for (const item of data) {
          this.emit("data", item);
        }
      } catch (err: any) {
        logger.error({ feed: this.name, err: err.message }, "Feed fetch error");
        this.emit("error", err);
      }
    };

    await poll(); // initial fetch
    this.interval = setInterval(poll, this.intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    logger.info({ feed: this.name }, "Data feed stopped");
  }
}

export abstract class WebSocketFeed<T> extends EventEmitter {
  protected ws?: any;
  protected running = false;
  protected abstract name: string;
  protected abstract url: string;
  protected reconnectDelay = 1000;

  abstract handleMessage(data: any): T[];

  abstract start(): Promise<void>;

  stop(): void {
    this.running = false;
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
  }

  protected scheduleReconnect(): void {
    if (!this.running) return;
    setTimeout(() => {
      if (this.running) this.start();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  }
}

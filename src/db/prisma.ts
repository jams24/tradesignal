import { PrismaClient } from "@prisma/client";
import { logger } from "../utils/logger";

export const prisma = new PrismaClient({
  log: [
    { level: "warn", emit: "event" },
    { level: "error", emit: "event" },
  ],
});

prisma.$on("error" as never, (e: any) => {
  logger.error({ err: e }, "Prisma error");
});

prisma.$on("warn" as never, (e: any) => {
  logger.warn({ message: e.message }, "Prisma warn");
});

export async function connectDB(): Promise<void> {
  try {
    await prisma.$connect();
    logger.info("Database connected");
  } catch (err) {
    logger.fatal({ err }, "Failed to connect to database");
    process.exit(1);
  }
}

export async function disconnectDB(): Promise<void> {
  await prisma.$disconnect();
  logger.info("Database disconnected");
}

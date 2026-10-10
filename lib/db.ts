import { PrismaClient } from "@prisma/client";

// Next.js dev server hot-reloads modules, which would otherwise open a new
// pool on every reload until Postgres refuses connections. Cache the client on
// globalThis outside production.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
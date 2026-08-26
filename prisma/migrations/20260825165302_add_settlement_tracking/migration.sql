-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('PENDING', 'STORED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'SETTLEMENT_PENDING';
ALTER TYPE "NotificationType" ADD VALUE 'SETTLEMENT_READY';
ALTER TYPE "NotificationType" ADD VALUE 'MONTH_SETTLED';
ALTER TYPE "NotificationType" ADD VALUE 'SETTLEMENT_WAIVED';

-- AlterTable
ALTER TABLE "MonthClosure" ADD COLUMN     "settledAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Settlement" (
    "id" TEXT NOT NULL,
    "closureId" INTEGER NOT NULL,
    "payerId" INTEGER NOT NULL,
    "receiverId" INTEGER NOT NULL,
    "amountInCents" INTEGER NOT NULL,
    "paidAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "waivedAt" TIMESTAMP(3),
    "waivedById" INTEGER,
    "waiveReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentReceipt" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "status" "ReceiptStatus" NOT NULL DEFAULT 'PENDING',
    "declaredContentType" TEXT NOT NULL,
    "contentType" TEXT,
    "sizeInBytes" INTEGER,
    "originalName" TEXT,
    "uploadedById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "storedAt" TIMESTAMP(3),

    CONSTRAINT "PaymentReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Settlement_payerId_paidAt_idx" ON "Settlement"("payerId", "paidAt");

-- CreateIndex
CREATE INDEX "Settlement_receiverId_confirmedAt_idx" ON "Settlement"("receiverId", "confirmedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Settlement_closureId_payerId_receiverId_key" ON "Settlement"("closureId", "payerId", "receiverId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentReceipt_storageKey_key" ON "PaymentReceipt"("storageKey");

-- CreateIndex
CREATE INDEX "PaymentReceipt_settlementId_status_idx" ON "PaymentReceipt"("settlementId", "status");

-- CreateIndex
CREATE INDEX "PaymentReceipt_status_createdAt_idx" ON "PaymentReceipt"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_closureId_fkey" FOREIGN KEY ("closureId") REFERENCES "MonthClosure"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_waivedById_fkey" FOREIGN KEY ("waivedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentReceipt" ADD CONSTRAINT "PaymentReceipt_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentReceipt" ADD CONSTRAINT "PaymentReceipt_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

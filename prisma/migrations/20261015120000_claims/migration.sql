-- CreateTable
CREATE TABLE "claims" (
    "source" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "claimant" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "fulfilledBy" TEXT,
    "fulfilledAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "claims_pkey" PRIMARY KEY ("source","sessionId")
);

-- AlterTable
ALTER TABLE "archives" ADD COLUMN "supersededBy" TEXT;

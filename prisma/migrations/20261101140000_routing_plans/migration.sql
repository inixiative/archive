-- CreateTable
CREATE TABLE "routing_plans" (
    "archiveId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "plan" JSONB,
    "attempt" JSONB,
    "issues" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "key" TEXT NOT NULL,
    "by" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "entries" INTEGER NOT NULL,
    "overrides" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "at" DOUBLE PRECISION NOT NULL,
    "reviewedAt" DOUBLE PRECISION,

    CONSTRAINT "routing_plans_pkey" PRIMARY KEY ("archiveId")
);

-- AddForeignKey
ALTER TABLE "routing_plans" ADD CONSTRAINT "routing_plans_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "archives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "routing_plans" ADD COLUMN "wholeTo" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "wholeDigests" TEXT[] DEFAULT ARRAY[]::TEXT[];

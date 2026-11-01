-- AlterTable
ALTER TABLE "archive_tombstones" ADD COLUMN "pending" TEXT[] DEFAULT ARRAY[]::TEXT[];

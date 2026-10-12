-- AlterTable
ALTER TABLE "archives" ADD COLUMN     "accessPath" TEXT,
ADD COLUMN     "provider" TEXT;

-- CreateIndex
CREATE INDEX "archives_provider_idx" ON "archives"("provider");

-- CreateIndex
CREATE INDEX "archives_accessPath_idx" ON "archives"("accessPath");


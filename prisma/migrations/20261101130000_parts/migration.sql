-- AlterTable
ALTER TABLE "archives" ADD COLUMN "partOf" TEXT,
ADD COLUMN "routedTo" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "archives_partOf_idx" ON "archives"("partOf");

-- AddForeignKey
ALTER TABLE "archives" ADD CONSTRAINT "archives_partOf_fkey" FOREIGN KEY ("partOf") REFERENCES "archives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

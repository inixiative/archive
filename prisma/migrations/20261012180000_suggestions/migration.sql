-- CreateTable
CREATE TABLE "suggestions" (
    "archiveId" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "by" TEXT NOT NULL,
    "tags" TEXT[],
    "at" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "suggestions_pkey" PRIMARY KEY ("archiveId")
);

-- AddForeignKey
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "archives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

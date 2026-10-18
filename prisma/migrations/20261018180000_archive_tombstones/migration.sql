-- CreateTable
CREATE TABLE "archive_tombstones" (
    "id" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "projectId" TEXT,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "archive_tombstones_pkey" PRIMARY KEY ("id")
);

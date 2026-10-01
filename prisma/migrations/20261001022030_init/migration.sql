-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "archives" (
    "id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "digest" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "projectId" TEXT,
    "actorId" TEXT,
    "capturedAt" DOUBLE PRECISION NOT NULL,
    "summary" JSONB NOT NULL,

    CONSTRAINT "archives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revisions" (
    "archiveId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "digest" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,

    CONSTRAINT "revisions_pkey" PRIMARY KEY ("archiveId","revision")
);

-- CreateTable
CREATE TABLE "chunks" (
    "archiveId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "start" INTEGER NOT NULL,
    "end" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "tokenCount" INTEGER NOT NULL,
    "embedding" vector(1536),

    CONSTRAINT "chunks_pkey" PRIMARY KEY ("archiveId","revision","position")
);

-- CreateTable
CREATE TABLE "tag_edits" (
    "archiveId" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "added" BOOLEAN NOT NULL,

    CONSTRAINT "tag_edits_pkey" PRIMARY KEY ("archiveId","tag")
);

-- CreateTable
CREATE TABLE "tag_definitions" (
    "actorId" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "tag_definitions_pkey" PRIMARY KEY ("actorId","tag")
);

-- CreateTable
CREATE TABLE "receipts" (
    "archiveId" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "digest" TEXT NOT NULL,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("archiveId","destination")
);

-- CreateTable
CREATE TABLE "outbox" (
    "archiveId" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("archiveId","destination")
);

-- CreateIndex
CREATE UNIQUE INDEX "archives_seq_key" ON "archives"("seq");

-- CreateIndex
CREATE INDEX "archives_projectId_idx" ON "archives"("projectId");

-- CreateIndex
CREATE INDEX "archives_actorId_idx" ON "archives"("actorId");

-- CreateIndex
CREATE INDEX "chunks_text_idx" ON "chunks" USING GIN ("text" gin_trgm_ops);

-- AddForeignKey
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "archives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_archiveId_revision_fkey" FOREIGN KEY ("archiveId", "revision") REFERENCES "revisions"("archiveId", "revision") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_edits" ADD CONSTRAINT "tag_edits_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "archives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "archives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "archives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "archives" ADD COLUMN "storedDigest" TEXT;
UPDATE "archives" SET "storedDigest" = "digest";
ALTER TABLE "archives" ALTER COLUMN "storedDigest" SET NOT NULL;

-- A part outlives its deleted session until its copies are deleted at the destinations.
ALTER TABLE "archives" DROP CONSTRAINT "archives_partOf_fkey";

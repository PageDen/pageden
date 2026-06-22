-- CreateEnum
CREATE TYPE "AttachmentStatus" AS ENUM ('SCANNING', 'READY', 'QUARANTINED');

-- AlterTable: add status column with SCANNING as the default for new rows
ALTER TABLE "Attachment" ADD COLUMN "status" "AttachmentStatus" NOT NULL DEFAULT 'SCANNING';

-- Backfill: existing rows are already stored and clean; promote them all to READY
UPDATE "Attachment" SET "status" = 'READY';

-- AlterTable
ALTER TABLE "SavingsGroup" ADD COLUMN     "groupType" TEXT NOT NULL DEFAULT 'Rotational',
ADD COLUMN     "targetAmount" DECIMAL(65,30),
ADD COLUMN     "lockUntilTarget" BOOLEAN NOT NULL DEFAULT false;

/*
  Warnings:

  - You are about to drop the column `user_id` on the `accounts` table. All the data in the column will be lost.
  - You are about to drop the column `user_id` on the `budgets` table. All the data in the column will be lost.
  - You are about to drop the column `user_id` on the `transaction_sessions` table. All the data in the column will be lost.
  - You are about to drop the column `wa_message_id` on the `transaction_sessions` table. All the data in the column will be lost.
  - You are about to drop the column `user_id` on the `transactions` table. All the data in the column will be lost.
  - You are about to drop the column `google_drive_folder_id` on the `users` table. All the data in the column will be lost.
  - You are about to drop the column `is_onboarded` on the `users` table. All the data in the column will be lost.
  - You are about to drop the column `spreadsheet_id` on the `users` table. All the data in the column will be lost.
  - You are about to drop the column `whatsapp_number` on the `users` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[messaging_account_id,category_id,month,year]` on the table `budgets` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[external_message_id]` on the table `transaction_sessions` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `messaging_account_id` to the `accounts` table without a default value. This is not possible if the table is not empty.
  - Added the required column `messaging_account_id` to the `budgets` table without a default value. This is not possible if the table is not empty.
  - Added the required column `messaging_account_id` to the `transaction_sessions` table without a default value. This is not possible if the table is not empty.
  - Added the required column `platform` to the `transaction_sessions` table without a default value. This is not possible if the table is not empty.
  - Added the required column `messaging_account_id` to the `transactions` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('WHATSAPP', 'TELEGRAM');

-- CreateEnum
CREATE TYPE "ExpenseFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'ANNUALLY');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TransactionSource" ADD VALUE 'TELEGRAM_OCR';
ALTER TYPE "TransactionSource" ADD VALUE 'TELEGRAM_TEXT';

-- DropForeignKey
ALTER TABLE "accounts" DROP CONSTRAINT "accounts_user_id_fkey";

-- DropForeignKey
ALTER TABLE "budgets" DROP CONSTRAINT "budgets_user_id_fkey";

-- DropForeignKey
ALTER TABLE "transaction_sessions" DROP CONSTRAINT "transaction_sessions_user_id_fkey";

-- DropForeignKey
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_user_id_fkey";

-- DropIndex
DROP INDEX "budgets_user_id_category_id_month_year_key";

-- DropIndex
DROP INDEX "transaction_sessions_user_id_status_idx";

-- DropIndex
DROP INDEX "transaction_sessions_wa_message_id_key";

-- DropIndex
DROP INDEX "transactions_user_id_category_id_idx";

-- DropIndex
DROP INDEX "transactions_user_id_deleted_at_idx";

-- DropIndex
DROP INDEX "transactions_user_id_transaction_date_idx";

-- DropIndex
DROP INDEX "users_whatsapp_number_key";

-- AlterTable
ALTER TABLE "accounts" DROP COLUMN "user_id",
ADD COLUMN     "messaging_account_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "budgets" DROP COLUMN "user_id",
ADD COLUMN     "messaging_account_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "transaction_sessions" DROP COLUMN "user_id",
DROP COLUMN "wa_message_id",
ADD COLUMN     "external_message_id" TEXT,
ADD COLUMN     "messaging_account_id" TEXT NOT NULL,
ADD COLUMN     "platform" "Platform" NOT NULL;

-- AlterTable
ALTER TABLE "transactions" DROP COLUMN "user_id",
ADD COLUMN     "messaging_account_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "users" DROP COLUMN "google_drive_folder_id",
DROP COLUMN "is_onboarded",
DROP COLUMN "spreadsheet_id",
DROP COLUMN "whatsapp_number";

-- CreateTable
CREATE TABLE "messaging_accounts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "external_id" TEXT NOT NULL,
    "spreadsheet_id" TEXT,
    "google_drive_folder_id" TEXT,
    "is_onboarded" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "messaging_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "routine_expenses" (
    "id" TEXT NOT NULL,
    "messaging_account_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "category_id" TEXT,
    "title" TEXT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "frequency" "ExpenseFrequency" NOT NULL,
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3),
    "last_processed_at" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "routine_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "messaging_accounts_platform_external_id_key" ON "messaging_accounts"("platform", "external_id");

-- CreateIndex
CREATE INDEX "routine_expenses_messaging_account_id_is_active_idx" ON "routine_expenses"("messaging_account_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "budgets_messaging_account_id_category_id_month_year_key" ON "budgets"("messaging_account_id", "category_id", "month", "year");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_sessions_external_message_id_key" ON "transaction_sessions"("external_message_id");

-- CreateIndex
CREATE INDEX "transaction_sessions_messaging_account_id_status_idx" ON "transaction_sessions"("messaging_account_id", "status");

-- CreateIndex
CREATE INDEX "transactions_messaging_account_id_transaction_date_idx" ON "transactions"("messaging_account_id", "transaction_date");

-- CreateIndex
CREATE INDEX "transactions_messaging_account_id_category_id_idx" ON "transactions"("messaging_account_id", "category_id");

-- CreateIndex
CREATE INDEX "transactions_messaging_account_id_deleted_at_idx" ON "transactions"("messaging_account_id", "deleted_at");

-- AddForeignKey
ALTER TABLE "messaging_accounts" ADD CONSTRAINT "messaging_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_messaging_account_id_fkey" FOREIGN KEY ("messaging_account_id") REFERENCES "messaging_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_messaging_account_id_fkey" FOREIGN KEY ("messaging_account_id") REFERENCES "messaging_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_messaging_account_id_fkey" FOREIGN KEY ("messaging_account_id") REFERENCES "messaging_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routine_expenses" ADD CONSTRAINT "routine_expenses_messaging_account_id_fkey" FOREIGN KEY ("messaging_account_id") REFERENCES "messaging_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routine_expenses" ADD CONSTRAINT "routine_expenses_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routine_expenses" ADD CONSTRAINT "routine_expenses_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_sessions" ADD CONSTRAINT "transaction_sessions_messaging_account_id_fkey" FOREIGN KEY ("messaging_account_id") REFERENCES "messaging_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

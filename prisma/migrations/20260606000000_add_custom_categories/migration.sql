-- AlterTable
ALTER TABLE "categories" ADD COLUMN "messaging_account_id" TEXT;

-- DropIndex
DROP INDEX IF EXISTS "categories_name_key";

-- CreateIndex
CREATE UNIQUE INDEX "categories_name_messaging_account_id_key" ON "categories"("name", "messaging_account_id");

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_messaging_account_id_fkey" FOREIGN KEY ("messaging_account_id") REFERENCES "messaging_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RedefineBudgetRelation
ALTER TABLE "budgets" DROP CONSTRAINT IF EXISTS "budgets_category_id_fkey";
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

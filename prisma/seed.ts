import { PrismaClient, CategoryType } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const categories = [
    { name: 'Makan & Minum', icon: '🍔', color: '#FF6B35', type: CategoryType.EXPENSE, isSystem: true,
      keywords: ['bakso','warteg','makan','lunch','dinner','starbucks','kopi','restoran','cafe'] },
    { name: 'Transportasi', icon: '🚗', color: '#3B82F6', type: CategoryType.EXPENSE, isSystem: true,
      keywords: ['bensin','bbm','grab','gojek','toll','parkir','busway','ojek','taksi'] },
    { name: 'Belanja', icon: '🛒', color: '#8B5CF6', type: CategoryType.EXPENSE, isSystem: true,
      keywords: ['indomaret','alfamart','supermarket','mall','tokopedia','shopee','beli'] },
    { name: 'Kesehatan', icon: '💊', color: '#EF4444', type: CategoryType.EXPENSE, isSystem: true,
      keywords: ['apotek','dokter','rumah sakit','obat','klinik','vitamin','bpjs'] },
    { name: 'Pendidikan', icon: '📚', color: '#F59E0B', type: CategoryType.EXPENSE, isSystem: true,
      keywords: ['buku','kursus','les','kampus','spp','sekolah','seminar'] },
    { name: 'Hiburan', icon: '🎮', color: '#10B981', type: CategoryType.EXPENSE, isSystem: true,
      keywords: ['netflix','spotify','bioskop','game','konser','wisata'] },
    { name: 'Tagihan & Utilitas', icon: '💡', color: '#6366F1', type: CategoryType.EXPENSE, isSystem: true,
      keywords: ['listrik','air','internet','pln','pdam','telkom','indihome','wifi'] },
    { name: 'Lainnya', icon: '📦', color: '#9CA3AF', type: CategoryType.EXPENSE, isSystem: true, keywords: [] },
    { name: 'Gaji', icon: '💼', color: '#059669', type: CategoryType.INCOME, isSystem: true,
      keywords: ['gaji','salary','payroll','thr'] },
    { name: 'Freelance', icon: '💻', color: '#0284C7', type: CategoryType.INCOME, isSystem: true,
      keywords: ['freelance','project','honor','fee','jasa'] },
    { name: 'Bisnis', icon: '🏪', color: '#7C3AED', type: CategoryType.INCOME, isSystem: true,
      keywords: ['bisnis','omzet','penjualan','jualan','dagangan'] },
    { name: 'Investasi', icon: '📈', color: '#B45309', type: CategoryType.INCOME, isSystem: true,
      keywords: ['dividen','saham','reksa dana','bunga','deposito'] },
    { name: 'Lainnya (Income)', icon: '💰', color: '#6B7280', type: CategoryType.INCOME, isSystem: true, keywords: [] },
  ];

  for (const cat of categories) {
    await prisma.category.upsert({ 
      where: { name: cat.name }, 
      update: cat, 
      create: cat 
    });
  }
  console.log('Seed selesai: 13 kategori sistem berhasil di-insert.');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

/**
 * Bổ sung dữ liệu còn thiếu cho các trận đấu được tạo bởi seed:
 *  - slug (giống MatchService.generateUniqueSlug)
 *  - bản ghi screen_controls (giống MatchController.create)
 * Chạy: node scripts/fix-seed-matches.js
 */
const { PrismaClient } = require("@prisma/client");
const slugify = require("slugify");

const prisma = new PrismaClient();

async function uniqueSlug(name, id) {
  const base = slugify(name, { lower: true, locale: "vi", strict: true });
  let slug = base;
  let suffix = 1;
  while (await prisma.match.findFirst({ where: { slug, NOT: { id } } })) {
    slug = `${base}-${suffix++}`;
  }
  return slug;
}

async function main() {
  const matches = await prisma.match.findMany({ orderBy: { id: "asc" } });
  for (const m of matches) {
    if (!m.slug) {
      const slug = await uniqueSlug(m.name, m.id);
      await prisma.match.update({ where: { id: m.id }, data: { slug } });
      console.log(`#${m.id} ${m.name} -> ${slug}`);
    }
    const screen = await prisma.screenControl.findUnique({ where: { matchId: m.id } });
    if (!screen) await prisma.screenControl.create({ data: { matchId: m.id } });
  }
  console.log("Xong.");
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

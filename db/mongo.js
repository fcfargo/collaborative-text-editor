const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  // 데이터 초기화
  const collections = await mongoose.connection.db.collections();
  collections.forEach(async (collection) => {
    collection.deleteMany();
  });
}

module.exports = {
  main,
};

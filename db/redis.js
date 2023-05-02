const redis = require('redis');
const client = redis.createClient(process.env.REDIS_URL);

async function init() {
  client.on('error', (err) => console.log('Rdis Client Error', err));
  await client.connect();
  await client.flushAll();
}

module.exports = {
  init,
  client,
};

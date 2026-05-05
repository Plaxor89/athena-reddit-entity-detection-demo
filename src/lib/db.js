const { Pool } = require("pg");
const { getDbConfig } = require("./config");

let pool;

function getPool() {
  if (!pool) {
    const dbConfig = getDbConfig();

    pool = new Pool({
      user: dbConfig.user,
      password: dbConfig.password,
      database: dbConfig.database,
      host: dbConfig.host,
      port: dbConfig.port,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
  }

  return pool;
}

async function query(text, params = []) {
  const activePool = getPool();
  return activePool.query(text, params);
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

module.exports = {
  getPool,
  query,
  closePool,
};
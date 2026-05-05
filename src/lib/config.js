const isDeployed = Boolean(process.env.K_SERVICE || process.env.FUNCTION_TARGET);
const isLocal = !isDeployed;

function required(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name, fallback = undefined) {
  const value = process.env[name];
  return value && String(value).trim() ? value : fallback;
}

function getDbConfig() {
  const dbUser = required("DB_USER");
  const dbPassword = required("DB_PASSWORD");
  const dbName = required("DB_NAME");

  if (isDeployed) {
    const dbInstanceName = required("DB_INSTANCE_NAME");
    return {
      mode: "deployed",
      user: dbUser,
      password: dbPassword,
      database: dbName,
      host: `/cloudsql/${dbInstanceName}`,
    };
  }

  return {
    mode: "local",
    user: dbUser,
    password: dbPassword,
    database: dbName,
    host: optional("DB_HOST", "127.0.0.1"),
    port: Number(optional("DB_PORT", "5432")),
  };
}

module.exports = {
  isLocal,
  isDeployed,
  getDbConfig,
};
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Pool } = pg;

let pool;
let cachedPassword = null;

async function resolveDbPassword() {
  if (cachedPassword !== null) return cachedPassword;

  if (process.env.DB_PASSWORD) {
    cachedPassword = process.env.DB_PASSWORD;
    return cachedPassword;
  }

  if (process.env.DB_SECRET_ARN) {
    const client = new SecretsManagerClient({
      region: process.env.AWS_REGION || 'us-east-1',
    });
    const response = await client.send(
      new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN })
    );
    const raw = response.SecretString;
    try {
      const parsed = JSON.parse(raw);
      cachedPassword = parsed.password ?? parsed.DB_PASSWORD ?? raw;
    } catch {
      cachedPassword = raw;
    }
    return cachedPassword;
  }

  throw new Error('No DB password configured. Set DB_PASSWORD or DB_SECRET_ARN.');
}

export async function getPool() {
  if (!pool) {
    const password = await resolveDbPassword();
    pool = new Pool({
      host:     process.env.DB_HOST,
      port:     parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME,
      user:     process.env.DB_USER,
      password,
      ssl:      { rejectUnauthorized: false },
      max:      5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }
  return pool;
}

export async function query(sql, params = []) {
  const p = await getPool();
  const client = await p.connect();
  try {
    const result = await client.query(sql, params);
    return result;
  } finally {
    client.release();
  }
}

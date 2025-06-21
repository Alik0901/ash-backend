// db.js — PostgreSQL pool с отключённой проверкой сертификата
// Должен быть загружен первым в процессе, до любых попыток подключения к БД

// 1) Отключаем проверку корневых сертификатов (Node.js)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;

import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import { parse } from 'pg-connection-string';

// 2) Парсим DATABASE_URL в отдельные параметры
const config = parse(process.env.DATABASE_URL);

// 3) Включаем SSL без проверки цепочки
config.ssl = { rejectUnauthorized: false };

// 4) Создаём пул
const pool = new Pool({
  ...config,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  keepAlive: true
});

// 5) Обработка неожиданных ошибок на idle-клиентах
pool.on('error', err => {
  console.error('Unexpected PG client error', err);
  // при желании можно process.exit(1) тут вызывать,
  // чтобы контейнер перезапустился
});

export default pool;

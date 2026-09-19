/**
 * Точка входа сервера Twonky Grabber.
 * M0: каркас Express + /api/health. Сканер, очередь и превью-прокси подключаются на следующих шагах.
 */
import express from 'express';
import { PORT } from './config';

const app = express();

app.use(express.json());

// Проверка живости (M0-контракт).
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  // Тексты логов — на русском, чтобы совпадали с языком проекта.
  console.log(`[server] Twonky Grabber API запущен: http://localhost:${PORT}`);
});

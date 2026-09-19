/**
 * Точка входа сервера Twonky Grabber.
 * Собирает зависимости (сканер + реальный пробер + хранилище состояния),
 * восстанавливает состояние при старте и подключает API-роутер.
 */
import express from 'express';
import { PORT } from './config';
import { probeUrl } from './lib/probe';
import { fileUrl } from './lib/url-parser';
import { Scanner } from './lib/scanner';
import type { Prober } from './lib/scanner';
import { createApiRouter } from './lib/routes';
import { Store } from './lib/store';
import type { PersistedState } from './lib/store';

// Пробер строит URL от текущего подключения сканера (связывание после создания,
// чтобы избежать циклической ссылки в инициализаторе).
let scannerRef: Scanner | null = null;

const nodeProber: Prober = {
    probe: (number) => {
        const conn = scannerRef?.getConnection() ?? null;
        if (conn === null) {
            return Promise.resolve({
                kind: 'neterr' as const,
                media: null,
                contentType: null,
                size: null,
                detail: 'нет подключения',
            });
        }
        return probeUrl(fileUrl(conn, number));
    },
};

const scanner = new Scanner(nodeProber);
scannerRef = scanner;

const app = express();
app.use(express.json());
app.use('/api', createApiRouter({ scanner }));

const store = new Store();

/** Снимок состояния для записи в state.json (очередь добавится в M4). */
const snapshot = (): PersistedState => ({ version: 1, scan: scanner.serialize() });

// Восстановление состояния до открытия порта; wasRunning → автопродолжение скана.
void (async () => {
    const state = await store.load();
    if (state !== null && state.scan !== null) {
        const wasRunning = scanner.restore(state.scan);
        console.log(`[server] состояние восстановлено: найдено файлов — ${scanner.progress().found}`);
        if (wasRunning) {
            const conn = scanner.getConnection();
            if (conn !== null) {
                scanner.start(conn);
                console.log('[server] скан был активен до перезапуска — продолжаем');
            }
        }
    }
    store.startAutoSave(snapshot);

    app.listen(PORT, () => {
        // Тексты логов — на русском, чтобы совпадать с языком проекта.
        console.log(`[server] Twonky Grabber API запущен: http://localhost:${PORT}`);
    });
})();

// Сохранение состояния при завершении процесса (Ctrl+C, остановка менеджером).
function shutdown(): void {
    store.stop();
    void store.saveNow(snapshot()).finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

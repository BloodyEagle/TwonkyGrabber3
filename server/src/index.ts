/**
 * Точка входа сервера Twonky Grabber.
 * Собирает зависимости (сканер + загрузчик + хранилище состояния),
 * восстанавливает состояние при старте и подключает API-роутер.
 */
import express from 'express';
import { DOWNLOAD_DIR, PORT } from './config';
import { probeUrl } from './lib/probe';
import { fileUrl } from './lib/url-parser';
import { Scanner } from './lib/scanner';
import type { Prober } from './lib/scanner';
import { Downloader, createNodeDownloaderDeps } from './lib/downloader';
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

const downloader = new Downloader(createNodeDownloaderDeps(DOWNLOAD_DIR), scanner);
// autoAll: новые находки автоматически попадают в очередь.
scanner.addOnFound((files) => {
    downloader.handleFound(files);
});

const app = express();
app.use(express.json());
app.use('/api', createApiRouter({ scanner, downloader }));

const store = new Store();

/** Снимок состояния для записи в state.json. */
const snapshot = (): PersistedState => ({
    version: 1,
    scan: scanner.serialize(),
    queue: downloader.serialize(),
});

// Восстановление состояния до открытия порта; wasRunning → автопродолжение скана;
// очередь возобновляется сама (restore качает pump при наличии pending).
void (async () => {
    const state = await store.load();
    if (state !== null) {
        if (state.scan !== null) {
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
        if (state.queue !== null) {
            downloader.restore(state.queue);
            console.log(`[server] очередь восстановлена: элементов — ${state.queue.items.length}`);
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
    downloader.dispose();
    void store.saveNow(snapshot()).finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

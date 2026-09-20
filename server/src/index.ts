/**
 * Точка входа сервера Twonky Grabber.
 * Собирает зависимости (сканер + загрузчик + хранилище состояния),
 * восстанавливает состояние при старте и подключает API-роутер.
 */
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DOWNLOAD_DIR, PORT, STATIC_ROOT, C, applyConfigPatch } from './config';
import { probeUrl } from './lib/probe';
import { fetchServerStats } from './lib/server-stats';
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

/** Каталоги сборки фронта: dist, dist/browser или dist/<name>/browser (план, §9).
 *  Базу ищем на двух уровнях: ../client/dist (запуск из src через tsx) и
 *  ../../client/dist (запуск собранного dist/index.js). */
function findClientRoot(): string | null {
    const bases = [
        resolve(__dirname, STATIC_ROOT),
        resolve(__dirname, '..', 'client', 'dist'),
        resolve(__dirname, '..', '..', 'client', 'dist'),
    ];
    const candidates: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    for (const base of bases) {
        candidates.push(base, join(base, 'browser'));
        try {
            for (const entry of readdirSync(base, { withFileTypes: true })) {
                if (entry.isDirectory()) candidates.push(join(base, entry.name, 'browser'));
            }
        } catch {
            /* этого базового каталога нет — проверяем следующий */
        }
    }
    for (const dir of candidates) {
        if (existsSync(join(dir, 'index.html'))) return dir;
    }
    return null;
}

const clientRoot = findClientRoot();
if (clientRoot !== null) {
    app.use(express.static(clientRoot));
    // SPA-fallback: всё, что не /api, отдаёт index.html (Express 4).
    app.use((req: Request, res: Response, next: NextFunction) => {
        if (req.method !== 'GET' || req.path.startsWith('/api')) {
            next();
            return;
        }
        res.sendFile(join(clientRoot, 'index.html'));
    });
    console.log(`[server] фронтенд раздаётся из ${clientRoot}`);
} else {
    console.log('[server] сборка фронтенда не найдена — работает только API');
}

const store = new Store();

/** Снимок состояния для записи в state.json. */
const snapshot = (): PersistedState => ({
    version: 1,
    scan: scanner.serialize(),
    queue: downloader.serialize(),
    config: structuredClone(C),
});

// Восстановление состояния до открытия порта; wasRunning → автопродолжение скана;
// очередь возобновляется сама (restore качает pump при наличии pending).
void (async () => {
    const state = await store.load();
    if (state !== null) {
        if (state.scan !== null) {
            const wasRunning = scanner.restore(state.scan);
            console.log(`[server] состояние восстановлено: найдено файлов — ${scanner.progress().found}`);
            const conn = scanner.getConnection();
            if (conn !== null) {
                // Обновляем статистику сервера (для досрочной остановки).
                void fetchServerStats(conn).then((stats) => {
                    scanner.setServerTotals(stats);
                });
            }
            if (wasRunning) {
                const conn2 = scanner.getConnection();
                if (conn2 !== null) {
                    scanner.start(conn2);
                    console.log('[server] скан был активен до перезапуска — продолжаем');
                }
            }
        }
        if (state.queue !== null) {
            downloader.restore(state.queue);
            console.log(`[server] очередь восстановлена: элементов — ${state.queue.items.length}`);
        }
        if (state.config !== null) {
            applyConfigPatch(state.config as unknown as Record<string, unknown>);
            console.log('[server] конфигурация восстановлена из state.json');
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

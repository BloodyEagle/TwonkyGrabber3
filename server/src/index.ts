/**
 * Точка входа сервера Twonky Grabber.
 * Мульти-серверная сборка: менеджер сессий (сканер + загрузчик на каждый Twonky),
 * восстановление состояния при старте и подключение API-роутера.
 */
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DOWNLOAD_DIR, PORT, STATIC_ROOT, C, applyConfigPatch } from './config';
import { fetchServerStats } from './lib/server-stats';
import { SessionManager } from './lib/sessions';
import type { Session } from './lib/sessions';
import { createApiRouter } from './lib/routes';
import { Store } from './lib/store';
import type { PersistedState } from './lib/store';

const manager = new SessionManager(DOWNLOAD_DIR);

const app = express();
app.use(express.json());
app.use('/api', createApiRouter({ sessions: manager }));

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

/** Снимок состояния для записи в state.json (версия 2 — все сессии). */
const snapshot = (): PersistedState => ({
    version: 2,
    nextSessionId: manager.peekNextId(),
    sessions: manager.list().map((s) => ({
        id: s.id,
        dir: s.dir,
        scan: s.scanner.serialize(),
        queue: s.downloader.serialize(),
    })),
    config: structuredClone(C),
});

// Восстановление состояния до открытия порта; wasRunning → автопродолжение скана;
// очередь возобновляется сама (restore качает pump при наличии pending).
void (async () => {
    const state = await store.load();
    if (state !== null) {
        if (state.config !== null) {
            applyConfigPatch(state.config as unknown as Record<string, unknown>);
            console.log('[server] конфигурация восстановлена из state.json');
        }
        manager.setNextId(state.nextSessionId);
        for (const saved of state.sessions) {
            let session: Session;
            try {
                session = manager.create(saved.scan?.connection ?? null, { id: saved.id, dir: saved.dir });
            } catch (err: unknown) {
                console.warn(
                    `[server] сессия ${saved.id} не восстановлена: ${err instanceof Error ? err.message : String(err)}`,
                );
                continue;
            }
            if (saved.scan !== null) {
                const wasRunning = session.scanner.restore(saved.scan);
                console.log(
                    `[server] сессия ${saved.id} (${saved.dir}): найдено файлов — ${session.scanner.progress().found}`,
                );
                const conn = session.scanner.getConnection();
                if (conn !== null) {
                    // Обновляем статистику сервера (для досрочной остановки).
                    void fetchServerStats(conn).then((stats) => {
                        session.scanner.setServerTotals(stats);
                    });
                }
                if (wasRunning) {
                    const conn2 = session.scanner.getConnection();
                    if (conn2 !== null) {
                        session.scanner.start(conn2);
                        console.log(`[server] сессия ${saved.id}: скан был активен до перезапуска — продолжаем`);
                    }
                }
            }
            if (saved.queue !== null) {
                session.downloader.restore(saved.queue);
                console.log(
                    `[server] сессия ${saved.id}: очередь восстановлена — элементов ${saved.queue.items.length}`,
                );
            }
        }
        manager.bumpNextId(state.sessions.map((s) => s.id));
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
    for (const s of manager.list()) s.downloader.dispose();
    void store.saveNow(snapshot()).finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/**
 * Персистентное состояние сервера (план, п.5.10, п.6).
 * Запись атомарная (tmp + rename), каждые C.SAVE_EVERY_MS и при завершении процесса.
 *
 * Версия 2 — несколько серверов (сессий) в одном state.json.
 * Загрузка версии 1 автоматически мигрирует одиночное состояние в сессию «1».
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { STATE_FILE, C, SAVE_RETRY_DELAY_MS } from '../config';
import type { RuntimeConfig } from '../config';
import { logError, logInfo, logWarn } from './log';
import { sanitizeDirName, sessionDir } from './sessions';
import type { PersistedScanState } from './scanner';
import type { PersistedQueueState } from './downloader';

/** Пауза между ретраями записи (см. C.SAVE_RETRY_DELAY_MS). */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Состояние одной сессии в state.json (версия 2). */
export interface PersistedSessionState {
    id: string;
    dir: string;
    scan: PersistedScanState | null;
    queue: PersistedQueueState | null;
}

/** Корень state.json (версия 2 — список сессий). */
export interface PersistedState {
    version: 2;
    nextSessionId: number;
    sessions: PersistedSessionState[];
    config: RuntimeConfig | null;
}

/** Минимальная структурная валидация секции сканера (своему файлу доверяем). */
function isPersistedScan(value: unknown): value is PersistedScanState {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return typeof v.connection === 'object' && v.connection !== null;
}

/** Минимальная структурная валидация секции очереди. */
function isPersistedQueue(value: unknown): value is PersistedQueueState {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return Array.isArray(v.items);
}

/** Минимальная структурная валидация секции конфигурации. */
function isPersistedConfig(value: unknown): value is RuntimeConfig {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Минимальная структурная валидация записи сессии. */
function isPersistedSession(value: unknown): value is PersistedSessionState {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return typeof v.id === 'string' && v.id !== '' && typeof v.dir === 'string' && v.dir !== '';
}

/** Каталог загрузок для миграции v1 без сканера: host_port из первого URL очереди. */
function queueDirFallback(queue: PersistedQueueState): string {
    for (const item of queue.items) {
        const m = /^[a-z][a-z0-9+.-]*:\/\/([^/:?#]+)(?::(\d+))?/i.exec(item.url);
        if (m !== null) {
            return sanitizeDirName(`${m[1] ?? 'server'}_${m[2] ?? '9000'}`);
        }
    }
    return 'server';
}

/** Миграция v1 (одиночный скан + очередь) → v2 (одна сессия «1»). */
function migrateV1(v: Record<string, unknown>): PersistedState {
    const scan = isPersistedScan(v.scan) ? v.scan : null;
    const queue = isPersistedQueue(v.queue) ? v.queue : null;
    const config = isPersistedConfig(v.config) ? v.config : null;
    if (scan === null && queue === null) {
        return { version: 2, nextSessionId: 1, sessions: [], config };
    }
    // Здесь queue !== null (иначе ранний выход выше) — TS не сужает из-за && .
    const dir = scan !== null ? sessionDir(scan.connection) : queueDirFallback(queue as PersistedQueueState);
    logInfo('store', `state.json v1 → v2: сессия «1», каталог ${dir}`);
    return { version: 2, nextSessionId: 2, sessions: [{ id: '1', dir, scan, queue }], config };
}

/**
 * Хранилище state.json: загрузка при старте, автосохранение по интервалу,
 * немедленное сохранение при завершении. Ошибки диска не роняют сервер.
 */
export class Store {
    private timer: NodeJS.Timeout | null = null;
    /** Цепочка записей: в один момент пишет только один вызов saveNow. */
    private chain: Promise<void> = Promise.resolve();
    /** Сколько записей в полёте (автосейв пропускает тик, чтобы не копить очередь). */
    private inFlight = 0;

    constructor(private readonly filePath: string = STATE_FILE) {}

    /** Загрузка состояния; null — файла нет или он повреждён (стартуем с нуля). */
    async load(): Promise<PersistedState | null> {
        let raw: string;
        try {
            raw = await readFile(this.filePath, 'utf8');
        } catch {
            return null; // файла ещё нет — штатная ситуация первого запуска
        }
        try {
            const parsed: unknown = JSON.parse(raw);
            if (typeof parsed !== 'object' || parsed === null) return null;
            const v = parsed as Record<string, unknown>;
            if (v.version === 1) {
                return migrateV1(v);
            }
            if (v.version !== 2) {
                logWarn('store', 'неизвестная версия state.json — состояние игнорируется');
                return null;
            }
            const rawSessions = Array.isArray(v.sessions) ? v.sessions : [];
            const sessions = rawSessions
                .filter(isPersistedSession)
                .map((s) => ({
                    id: s.id,
                    dir: s.dir,
                    scan: isPersistedScan(s.scan) ? s.scan : null,
                    queue: isPersistedQueue(s.queue) ? s.queue : null,
                }));
            const nextSessionId =
                typeof v.nextSessionId === 'number' && Number.isFinite(v.nextSessionId) && v.nextSessionId >= 1
                    ? Math.floor(v.nextSessionId)
                    : sessions.length + 1;
            return {
                version: 2,
                nextSessionId,
                sessions,
                config: isPersistedConfig(v.config) ? v.config : null,
            };
        } catch (err: unknown) {
            logWarn(
                'store',
                `state.json повреждён (${err instanceof Error ? err.message : String(err)}) — стартуем с нуля`,
            );
            return null;
        }
    }

    /** Периодическое автосохранение снимка (источник снимка передаётся колбэком). */
    startAutoSave(getState: () => PersistedState): void {
        this.stop();
        this.timer = setInterval(() => {
            // Предыдущая запись ещё идёт — пропускаем тик: следующий снимок будет свежее.
            if (this.inFlight > 0) return;
            void this.saveNow(getState());
        }, C.SAVE_EVERY_MS);
    }

    /**
     * Запись снимка состояния. Вызовы сериализуются: одновременные saveNow
     * (тик автосейва + shutdown) не накладываются на один `.tmp` и не ломают rename.
     * Промис разрешается, когда именно этот снимок записан (важно для shutdown).
     */
    saveNow(state: PersistedState): Promise<void> {
        this.inFlight += 1;
        const done = this.chain
            .then(() => this.writeState(state))
            .finally(() => {
                this.inFlight -= 1;
            });
        // Ошибка одной записи не должна рвать цепочку последующих.
        this.chain = done.catch(() => undefined);
        return done;
    }

    /** Одна атомарная запись (tmp + rename) с ретраями под Windows. */
    private async writeState(state: PersistedState): Promise<void> {
        const data = `${JSON.stringify(state)}\n`;
        try {
            await mkdir(dirname(this.filePath), { recursive: true });
        } catch (err: unknown) {
            logError('store', `каталог состояния недоступен (${dirname(this.filePath)})`, err);
            return; // каталог не создать — писать некуда
        }
        // Windows: rename в существующий файл даёт EPERM при кратковременной блокировке
        // (антивирус/индексатор). Несколько попыток, затем неатомарная запись поверх.
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                const tmp = `${this.filePath}.tmp`;
                await writeFile(tmp, data, 'utf8');
                await rename(tmp, this.filePath);
                return;
            } catch (err: unknown) {
                if (attempt === 2) {
                    logError('store', 'не удалось записать состояние (tmp + rename)', err);
                } else {
                    await sleep(SAVE_RETRY_DELAY_MS);
                }
            }
        }
        // Фолбэк: прямая запись поверх (менее атомарно, но надёжнее при EPERM на rename).
        try {
            await writeFile(this.filePath, data, 'utf8');
        } catch (err: unknown) {
            logError('store', 'фолбэк-запись состояния не удалась', err);
        }
    }

    /** Остановка автосохранения (при завершении процесса). */
    stop(): void {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}

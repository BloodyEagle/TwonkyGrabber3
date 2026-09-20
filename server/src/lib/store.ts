/**
 * Персистентное состояние сервера (план, п.5.10, п.6).
 * Запись атомарная (tmp + rename), каждые C.SAVE_EVERY_MS и при завершении процесса.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { STATE_FILE, C, SAVE_RETRY_DELAY_MS } from '../config';
import type { RuntimeConfig } from '../config';
import type { PersistedScanState } from './scanner';
import type { PersistedQueueState } from './downloader';

/** Пауза между ретраями записи (см. C.SAVE_RETRY_DELAY_MS). */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Корень state.json. */
export interface PersistedState {
    version: 1;
    scan: PersistedScanState | null;
    queue: PersistedQueueState | null;
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

/**
 * Хранилище state.json: загрузка при старте, автосохранение по интервалу,
 * немедленное сохранение при завершении. Ошибки диска не роняют сервер.
 */
export class Store {
    private timer: NodeJS.Timeout | null = null;

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
            if (v.version !== 1) {
                console.warn('[store] неизвестная версия state.json — состояние игнорируется');
                return null;
            }
            return {
                version: 1,
                scan: isPersistedScan(v.scan) ? v.scan : null,
                queue: isPersistedQueue(v.queue) ? v.queue : null,
                config: isPersistedConfig(v.config) ? v.config : null,
            };
        } catch (err: unknown) {
            console.warn(
                `[store] state.json повреждён (${err instanceof Error ? err.message : String(err)}) — стартуем с нуля`,
            );
            return null;
        }
    }

    /** Периодическое автосохранение снимка (источник снимка передаётся колбэком). */
    startAutoSave(getState: () => PersistedState): void {
        this.stop();
        this.timer = setInterval(() => {
            void this.saveNow(getState());
        }, C.SAVE_EVERY_MS);
    }

    /** Немедленная атомарная запись состояния (с ретраями под Windows). */
    async saveNow(state: PersistedState): Promise<void> {
        const data = `${JSON.stringify(state)}\n`;
        try {
            await mkdir(dirname(this.filePath), { recursive: true });
        } catch {
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
                    console.error(
                        `[store] не удалось записать состояние: ${err instanceof Error ? err.message : String(err)}`,
                    );
                } else {
                    await sleep(SAVE_RETRY_DELAY_MS);
                }
            }
        }
        // Фолбэк: прямая запись поверх (менее атомарно, но надёжнее при EPERM на rename).
        try {
            await writeFile(this.filePath, data, 'utf8');
        } catch {
            /* состояние просто не сохранится в этот тик */
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

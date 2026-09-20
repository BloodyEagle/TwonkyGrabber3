/**
 * Персистентное состояние сервера (план, п.5.10, п.6).
 * Запись атомарная (tmp + rename), каждые C.SAVE_EVERY_MS и при завершении процесса.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { STATE_FILE, C } from '../config';
import type { RuntimeConfig } from '../config';
import type { PersistedScanState } from './scanner';
import type { PersistedQueueState } from './downloader';

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

    /** Немедленная атомарная запись состояния. */
    async saveNow(state: PersistedState): Promise<void> {
        try {
            await mkdir(dirname(this.filePath), { recursive: true });
            const tmp = `${this.filePath}.tmp`;
            await writeFile(tmp, `${JSON.stringify(state)}\n`, 'utf8');
            await rename(tmp, this.filePath);
        } catch (err: unknown) {
            // Проблемы диска не роняют сервер — попробуем записать следующим тиком.
            console.error(
                `[store] не удалось записать состояние: ${err instanceof Error ? err.message : String(err)}`,
            );
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

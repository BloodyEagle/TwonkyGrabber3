/**
 * Загрузчик: очередь скачивания и пул воркеров (план, п.6).
 *
 * Правила:
 *  - элемент очереди — номер файла, дедуп при добавлении;
 *  - «скачать всё» — autoAll: текущие находки + автодобавление по SSE found;
 *  - файл: свежий HEAD → имя (tail + ext) → дубликаты: тот же размер = skip,
 *    другой размер = суффикс _1.._N → качаем в <имя>.part с докачкой Range,
 *    сверяем итоговый размер → rename;
 *  - авто-потоки: каждые C.DL_ADJUST_MS скорость на поток ≥ C.DL_SPEED_UP → target+1
 *    (строго по одному), ≤ C.DL_SPEED_DOWN или серия отказов → target−1;
 *  - лишние воркеры выходят после завершения текущего файла.
 *
 * Зависимости внедряются (DownloaderDeps) — сеть в юнит-тестах запрещена.
 */
import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { C, FINGERPRINT_BYTES } from '../config';
import { nodeTransport } from './http';
import { logError } from './log';
import type { HttpStreamOptions, HttpStreamResponse } from './http';
import { buildFileName } from './mime';
import { probeUrl } from './probe';
import type { ProbeResult } from './probe';
import { sleep } from './http';
import type { FoundFile, QueueItem, QueueItemView, QueueState, QueueStatus, ThreadsMode } from './types';

/** Источник найденных файлов (структурно совместим со Scanner). */
export interface FoundSource {
    getFound(number: number): FoundFile | null;
    foundList(): FoundFile[];
}

/** Файловые/сетевые зависимости загрузчика (мокируются в тестах). */
export interface DownloaderDeps {
    downloadDir: string;
    probe(url: string): Promise<ProbeResult>;
    stream(url: string, options: HttpStreamOptions): Promise<HttpStreamResponse>;
    /** Размер файла или null, если файла нет. */
    sizeOf(path: string): Promise<number | null>;
    /** Поток записи: append — дописывать (докачка), иначе создавать с нуля. */
    write(path: string, append: boolean): NodeJS.WritableStream;
    rename(from: string, to: string): Promise<void>;
    mkdirp(path: string): Promise<void>;
    /** Читает сохранённый фингерпринт файла (null — нет сайдкара). */
    readFingerprint?(fileName: string): Promise<FileFingerprint | null>;
    /** Считает фингерпринт локального файла и сохраняет его в sidecar. */
    storeFingerprint?(fileName: string, size: number): Promise<void>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
}

/** Итог разрешения имени файла (план, п.6: skip при равном размере, _N при отличии). */
export type SaveTarget =
    | { action: 'skip'; savedAs: string; note: string }
    | { action: 'write'; fileName: string }
    | { action: 'fail'; error: string };

/** Фингерпринт файла: размер + хэши первых/последних FINGERPRINT_BYTES байт. */
export interface FileFingerprint {
    size: number;
    head: string;
    tail: string;
}

/** Контекст сверки контента при дедупе (опционально — по умолчанию только размер). */
export interface FingerprintCheck {
    fetchRemote: () => Promise<FileFingerprint | null>;
    read: (fileName: string) => Promise<FileFingerprint | null>;
}

function hashBuffer(buf: Buffer): string {
    return createHash('sha256').update(buf).digest('hex');
}

/**
 * Выбор целевого имени: без суффикса → _1.._NAME_SUFFIX_LIMIT.
 * Файл того же размера = «уже скачан» (skip), другого размера — пробуем следующий суффикс.
 */
export async function resolveSaveTarget(
    sizeOf: (path: string) => Promise<number | null>,
    downloadDir: string,
    baseName: string,
    name: string,
    size: number,
    fp?: FingerprintCheck,
): Promise<SaveTarget> {
    // Расширение с точкой — всё, что в name после baseName.
    const ext = name.substring(baseName.length);
    const { join } = await import('node:path');
    for (let k = 0; k <= C.NAME_SUFFIX_LIMIT; k += 1) {
        const fileName = k === 0 ? name : `${baseName}_${k}${ext}`;
        const existing = await sizeOf(join(downloadDir, fileName));
        if (existing === null) {
            return { action: 'write', fileName };
        }
        if (existing === size) {
            // Размер совпал. Если есть сохранённый фингерпринт — сверяем контент:
            // при отличии считаем «не скачан» и уходим на следующий суффикс.
            if (fp !== undefined) {
                const stored = await fp.read(fileName);
                if (stored !== null) {
                    const remote = await fp.fetchRemote();
                    if (
                        remote !== null &&
                        (stored.head !== remote.head || stored.tail !== remote.tail || stored.size !== remote.size)
                    ) {
                        continue;
                    }
                }
            }
            return { action: 'skip', savedAs: fileName, note: 'уже скачан' };
        }
    }
    return { action: 'fail', error: `нет свободного имени: превышен предел суффиксов _1.._${C.NAME_SUFFIX_LIMIT}` };
}

/** Персистентное состояние очереди (план, п.6). */
export interface PersistedQueueState {
    items: QueueItem[];
    threadsMode: ThreadsMode;
    manual: number;
    target: number;
    autoAll: boolean;
    paused: boolean;
}

function clampThreads(value: number): number {
    return Math.min(C.DL_MAX_THREADS, Math.max(C.DL_MIN_THREADS, value));
}

function itemView(item: QueueItem): QueueItemView {
    return {
        number: item.number,
        name: item.name,
        baseName: item.baseName,
        contentType: item.contentType,
        size: item.size,
        status: item.status,
        downloaded: item.downloaded,
        error: item.error,
        note: item.note,
        savedAs: item.savedAs,
        addedAt: item.addedAt,
    };
}

/** Загрузчик: очередь + пул воркеров + авто-подстройка потоков. */
export class Downloader {
    private readonly items = new Map<number, QueueItem>();
    /** Порядок добавления (FIFO выдачи pending). */
    private readonly order: number[] = [];
    private live = 0;
    private target = C.DL_START_THREADS;
    private threadsMode: ThreadsMode = 'auto';
    private manual = C.DL_START_THREADS;
    private autoAllFlag = false;
    private pausedFlag = false;
    /** Скорость последнего интервала подстройки, байт/с (для фронта). */
    private speedLast = 0;
    private bytesSinceAdjust = 0;
    private failsInInterval = 0;
    private adjustT0: number;
    private dirReady = false;
    /** Число элементов в статусе pending (кэш, чтобы не сканировать order на каждый pump). */
    private pendingCountValue = 0;
    /** FIFO-очередь pending-номеров; pendingHead — указатель на голову (без shift O(n)). */
    private readonly pendingQueue: number[] = [];
    private pendingHead = 0;
    private readonly adjustTimer: NodeJS.Timeout;

    constructor(
        private readonly deps: DownloaderDeps,
        private readonly found: FoundSource,
    ) {
        this.adjustT0 = this.now();
        this.adjustTimer = setInterval(() => {
            void this.adjust();
        }, C.DL_ADJUST_MS);
    }

    private now(): number {
        return this.deps.now?.() ?? Date.now();
    }

    private doSleep(ms: number): Promise<void> {
        return this.deps.sleep?.(ms) ?? sleep(ms);
    }

    /** Остановка таймера подстройки (при завершении процесса). */
    dispose(): void {
        clearInterval(this.adjustTimer);
    }

    // --- управление из REST ---

    /** Добавить номера найденных файлов; дедуп; возвращает число добавленных. */
    add(numbers: number[]): number {
        let added = 0;
        for (const n of numbers) {
            if (!Number.isInteger(n) || this.items.has(n)) continue;
            const f = this.found.getFound(n);
            if (f === null) continue;
            this.items.set(n, {
                number: f.number,
                url: f.url,
                name: f.name,
                baseName: f.tail,
                contentType: f.contentType,
                size: f.size,
                status: 'pending',
                downloaded: 0,
                error: null,
                note: null,
                savedAs: null,
                addedAt: this.now(),
            });
            this.order.push(n);
            this.enqueuePending(n);
            added += 1;
        }
        if (added > 0) this.pump();
        return added;
    }

    /** «Скачать всё»: autoAll + все текущие находки (дальше — SSE found). */
    addAll(): number {
        this.autoAllFlag = true;
        return this.add(this.found.foundList().map((f) => f.number));
    }

    /** Автодобавление находок при включённом autoAll. */
    handleFound(files: FoundFile[]): void {
        if (!this.autoAllFlag) return;
        this.add(files.map((f) => f.number));
    }

    pause(): void {
        // Мягкая пауза: активные файлы докачиваются, новые не начинаются.
        this.pausedFlag = true;
    }

    resume(): void {
        this.pausedFlag = false;
        this.pump();
    }

    /** Повторить неудавшиеся. */
    retryFailed(): void {
        for (const n of this.order) {
            const item = this.items.get(n);
            if (item !== undefined && item.status === 'failed') {
                item.status = 'pending';
                item.error = null;
                item.note = null;
                this.enqueuePending(n);
            }
        }
        this.pump();
    }

    /** Убрать завершённые (done/skipped) из списка. */
    clearCompleted(): void {
        this.dropWhere((item) => item.status === 'done' || item.status === 'skipped');
    }

    /** Удаление элемента; false — активен, null — не найден. */
    remove(number: number): boolean | null {
        const item = this.items.get(number);
        if (item === undefined) return null;
        if (item.status === 'active') return false;
        this.dropWhere((it) => it === item);
        return true;
    }

    private dropWhere(pred: (item: QueueItem) => boolean): void {
        for (const [n, item] of this.items) {
            if (pred(item)) {
                if (item.status === 'pending') this.pendingCountValue -= 1;
                this.items.delete(n);
            }
        }
        for (let i = this.order.length - 1; i >= 0; i -= 1) {
            const n = this.order[i];
            if (n === undefined || !this.items.has(n)) this.order.splice(i, 1);
        }
    }

    /** Полный сброс очереди (autoAll тоже сбрасывается; файлы на диске не трогаем). */
    resetQueue(): void {
        this.items.clear();
        this.order.length = 0;
        this.pendingQueue.length = 0;
        this.pendingHead = 0;
        this.pendingCountValue = 0;
        this.autoAllFlag = false;
        this.pausedFlag = false;
    }

    // --- настройки ---

    settings(): { threadsMode: ThreadsMode; threadsValue: number; autoAll: boolean; downloadDir: string } {
        return {
            threadsMode: this.threadsMode,
            threadsValue: this.manual,
            autoAll: this.autoAllFlag,
            downloadDir: this.deps.downloadDir,
        };
    }

    /** Частичное применение настроек с клампами слайдера DL_MIN..DL_MAX. */
    applySettings(patch: { threadsMode?: unknown; threadsValue?: unknown; autoAll?: unknown }): void {
        if (patch.threadsMode === 'auto' || patch.threadsMode === 'manual') {
            this.threadsMode = patch.threadsMode;
            // При ручном режиме target сразу равен слайдеру; в авто — подстройка продолжит.
            if (patch.threadsMode === 'manual') this.target = clampThreads(this.manual);
        }
        if (typeof patch.threadsValue === 'number' && Number.isFinite(patch.threadsValue)) {
            this.manual = clampThreads(Math.round(patch.threadsValue));
            if (this.threadsMode === 'manual') this.target = this.manual;
        }
        if (typeof patch.autoAll === 'boolean') {
            this.autoAllFlag = patch.autoAll;
        }
        this.pump();
    }

    // --- представления ---

    state(): QueueState {
        const counts = { pending: 0, active: 0, done: 0, skipped: 0, failed: 0 };
        const active: QueueItemView[] = [];
        for (const n of this.order) {
            const item = this.items.get(n);
            if (item === undefined) continue;
            counts[item.status] += 1;
            if (item.status === 'active') active.push(itemView(item));
        }
        return {
            counts,
            active,
            threads: { live: this.live, target: this.target, mode: this.threadsMode, manual: this.manual },
            speed: this.speedLast,
            paused: this.pausedFlag,
            autoAll: this.autoAllFlag,
            total: this.items.size,
        };
    }

    /** Страница элементов очереди в порядке добавления. */
    itemsPage(page: number, size: number): { items: QueueItemView[]; total: number; page: number; size: number } {
        const all = this.order
            .map((n) => this.items.get(n))
            .filter((item): item is QueueItem => item !== undefined)
            .map(itemView);
        const start = (page - 1) * size;
        return {
            items: all.slice(start, start + size),
            total: all.length,
            page,
            size,
        };
    }

    // --- персистентность ---

    serialize(): PersistedQueueState {
        // active → pending: недокачанные продолжатся с .part после рестарта.
        const items = [...this.items.values()].map((item) =>
            item.status === 'active' ? { ...item, status: 'pending' as QueueStatus } : { ...item },
        );
        return {
            items,
            threadsMode: this.threadsMode,
            manual: this.manual,
            target: this.target,
            autoAll: this.autoAllFlag,
            paused: this.pausedFlag,
        };
    }

    restore(state: PersistedQueueState): void {
        this.resetQueue();
        for (const item of state.items) {
            if (!Number.isInteger(item.number)) continue;
            const restored: QueueItem = item.status === 'active' ? { ...item, status: 'pending' } : { ...item };
            this.items.set(restored.number, restored);
            this.order.push(restored.number);
            if (restored.status === 'pending') this.enqueuePending(restored.number);
        }
        this.threadsMode = state.threadsMode === 'manual' ? 'manual' : 'auto';
        this.manual = clampThreads(state.manual);
        this.target = clampThreads(state.target);
        this.autoAllFlag = state.autoAll;
        this.pausedFlag = state.paused;
        // Очередь возобновляется при старте сервера (план, п.6).
        this.pump();
    }

    // --- внутреннее: пул воркеров ---

    private pendingCount(): number {
        return this.pendingCountValue;
    }

    /** Поставить номер в FIFO-очередь pending и увеличить счётчик. */
    private enqueuePending(n: number): void {
        this.pendingQueue.push(n);
        this.pendingCountValue += 1;
    }

    /** Взять первый актуальный pending из очереди (пропускает уже обработанные/удалённые). */
    private dequeuePending(): QueueItem | null {
        while (this.pendingHead < this.pendingQueue.length) {
            const n = this.pendingQueue[this.pendingHead] ?? -1;
            this.pendingHead += 1;
            const item = this.items.get(n);
            if (item !== undefined && item.status === 'pending') return item;
        }
        // Очередь исчерпана — компактируем.
        this.pendingQueue.length = 0;
        this.pendingHead = 0;
        return null;
    }

    private pump(): void {
        while (!this.pausedFlag && this.live < this.target && this.pendingCount() > 0) {
            void this.worker();
        }
    }

    /** Воркер: берёт pending и качает; лишний (live > target) — выходит. */
    private async worker(): Promise<void> {
        this.live += 1;
        try {
            for (;;) {
                if (this.pausedFlag || this.live > this.target) break;
                const item = this.takeNext();
                if (item === null) break;
                await this.downloadItem(item);
            }
        } finally {
            this.live -= 1;
        }
    }

    private takeNext(): QueueItem | null {
        return this.dequeuePending();
    }

    /** Подстройка потоков: раз в C.DL_ADJUST_MS по скорости и отказам (план, п.6). */
    private async adjust(): Promise<void> {
        const now = this.now();
        const dtSec = (now - this.adjustT0) / 1000;
        const bytes = this.bytesSinceAdjust;
        const fails = this.failsInInterval;
        this.bytesSinceAdjust = 0;
        this.failsInInterval = 0;
        this.adjustT0 = now;
        if (dtSec <= 0) return;
        this.speedLast = bytes / dtSec;

        if (this.threadsMode !== 'auto') return;
        const speedPerLive = this.speedLast / Math.max(this.live, 1);
        if (fails > C.DL_FAILS_THRESHOLD) {
            this.target = clampThreads(this.target - 1);
        } else if (this.speedLast > 0 && speedPerLive <= C.DL_SPEED_DOWN) {
            this.target = clampThreads(this.target - 1);
        } else if (speedPerLive >= C.DL_SPEED_UP && this.pendingCount() > 0) {
            // Рост — строго по одному за интервал.
            this.target = clampThreads(this.target + 1);
        }
        this.pump();
    }

    // --- скачивание одного файла ---

    /** Контекст сверки фингерпринта (undefined → дедуп только по размеру). */
    private buildFingerprintCheck(url: string, size: number): FingerprintCheck | undefined {
        if (this.deps.readFingerprint === undefined) return undefined;
        let remote: Promise<FileFingerprint | null> | null = null;
        return {
            fetchRemote: () => (remote ??= this.fetchRemoteFingerprint(url, size)),
            read: (fileName) => this.deps.readFingerprint!(fileName),
        };
    }

    /** Сохранить фингерпринт локального файла после успешного скачивания. */
    private async storeFingerprint(fileName: string, size: number): Promise<void> {
        if (this.deps.storeFingerprint === undefined) return;
        try {
            await this.deps.storeFingerprint(fileName, size);
        } catch {
            /* сбой записи фингерпринта не критичен для скачивания */
        }
    }

    /** Фингерпринт удалённого файла: хэши первых/последних FINGERPRINT_BYTES байт. */
    private async fetchRemoteFingerprint(url: string, size: number): Promise<FileFingerprint | null> {
        try {
            const head = await this.readRange(url, `bytes=0-${FINGERPRINT_BYTES - 1}`);
            let tail = head;
            if (size > FINGERPRINT_BYTES) {
                tail = await this.readRange(url, `bytes=${size - FINGERPRINT_BYTES}-${size - 1}`);
            }
            return { size, head: hashBuffer(head), tail: hashBuffer(tail) };
        } catch {
            return null;
        }
    }

    /** Чтение ограниченного диапазона ответа (до FINGERPRINT_BYTES байт). */
    private async readRange(url: string, range: string): Promise<Buffer> {
        const res = await this.deps.stream(url, { headers: { Range: range }, idleTimeoutMs: C.PROBE_TIMEOUT });
        if (res.status !== 200 && res.status !== 206) {
            res.stream.destroy();
            throw new Error(`HTTP ${res.status}`);
        }
        const chunks: Buffer[] = [];
        let received = 0;
        return await new Promise<Buffer>((resolve, reject) => {
            res.stream.on('data', (chunk: Buffer) => {
                const take = Math.min(chunk.length, FINGERPRINT_BYTES - received);
                if (take > 0) chunks.push(chunk.subarray(0, take));
                received += chunk.length;
                if (received >= FINGERPRINT_BYTES) {
                    res.stream.destroy();
                    resolve(Buffer.concat(chunks));
                }
            });
            res.stream.on('end', () => resolve(Buffer.concat(chunks)));
            res.stream.on('error', (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));
            (res.stream as NodeJS.ReadableStream & { resume(): void }).resume();
        });
    }

    private async downloadItem(item: QueueItem): Promise<void> {
        if (item.status === 'pending') this.pendingCountValue -= 1;
        item.status = 'active';
        item.error = null;
        item.note = null;
        item.savedAs = null;
        try {
            const head = await this.deps.probe(item.url);
            if (head.kind === 'neterr') {
                throw new Error(`сеть: ${head.detail}`);
            }
            if (head.kind === 'missing') {
                throw new Error(`файл недоступен: ${head.detail}`);
            }
            const contentType = head.contentType ?? item.contentType;
            const size = head.size ?? item.size;
            item.contentType = contentType;
            item.size = size;
            item.name = buildFileName(item.baseName, contentType);

            const fp = this.buildFingerprintCheck(item.url, size);

            const target = await resolveSaveTarget(
                this.deps.sizeOf,
                this.deps.downloadDir,
                item.baseName,
                item.name,
                size,
                fp,
            );
            if (target.action === 'skip') {
                item.status = 'skipped';
                item.note = target.note;
                item.savedAs = target.savedAs;
                return;
            }
            if (target.action === 'fail') {
                throw new Error(target.error);
            }
            await this.transferWithRetries(item, target.fileName, size);
            item.status = 'done';
            item.savedAs = target.fileName;
            await this.storeFingerprint(target.fileName, size);
        } catch (err: unknown) {
            item.status = 'failed';
            item.error = err instanceof Error ? err.message : String(err);
            this.failsInInterval += 1;
            logError('download', `не удалось скачать #${item.number} (${item.url})`, err);
        }
    }

    /** Попытки скачивания с докачкой .part; бросает ошибку после C.DL_RETRIES. */
    private async transferWithRetries(item: QueueItem, fileName: string, size: number): Promise<void> {
        const { join } = await import('node:path');
        const partPath = join(this.deps.downloadDir, `${fileName}.part`);
        const finalPath = join(this.deps.downloadDir, fileName);

        let lastError: Error = new Error('нет попыток');
        for (let attempt = 0; attempt <= C.DL_RETRIES; attempt += 1) {
            if (attempt > 0) {
                const idx = Math.min(attempt - 1, C.DL_RETRY_DELAYS_MS.length - 1);
                const delay = C.DL_RETRY_DELAYS_MS[idx];
                if (delay !== undefined) await this.doSleep(delay);
            }
            try {
                if (!this.dirReady) {
                    await this.deps.mkdirp(this.deps.downloadDir);
                    this.dirReady = true;
                }
                let offset = (await this.deps.sizeOf(partPath)) ?? 0;
                if (size > 0 && offset === size) {
                    // .part уже полный (прошлый запуск оборвался до rename).
                    await this.deps.rename(partPath, finalPath);
                    item.downloaded = size;
                    return;
                }
                if (offset > size) {
                    // .part длиннее ожидаемого — битый, начинаем с нуля.
                    offset = 0;
                }

                const res = await this.deps.stream(
                    item.url,
                    {
                        headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
                        idleTimeoutMs: C.PROBE_TIMEOUT,
                    },
                );
                if (res.status !== 200 && res.status !== 206) {
                    throw new Error(`HTTP ${res.status}`);
                }
                const append = res.status === 206 && offset > 0;
                const base = append ? offset : 0;
                if (!append) item.downloaded = 0;

                const ws = this.deps.write(partPath, append);
                await this.pumpStream(item, res, ws, base);

                const finalSize = (await this.deps.sizeOf(partPath)) ?? -1;
                if (size > 0 && finalSize !== size) {
                    throw new Error(`размер не совпал: получено ${finalSize}, ожидалось ${size}`);
                }
                await this.deps.rename(partPath, finalPath);
                item.downloaded = finalSize;
                return;
            } catch (err: unknown) {
                lastError = err instanceof Error ? err : new Error(String(err));
                this.failsInInterval += 1;
            }
        }
        throw lastError;
    }

    /** Копирование стрима в файл с учётом прогресса и скорости. */
    private pumpStream(
        item: QueueItem,
        res: HttpStreamResponse,
        ws: NodeJS.WritableStream,
        base: number,
    ): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            let written = base;
            let settled = false;
            const fail = (err: unknown): void => {
                if (settled) return;
                settled = true;
                res.stream.destroy();
                reject(err instanceof Error ? err : new Error(String(err)));
            };
            res.stream.on('data', (chunk: Buffer) => {
                written += chunk.length;
                item.downloaded = written;
                this.bytesSinceAdjust += chunk.length;
                if (!ws.write(chunk)) {
                    (res.stream as NodeJS.ReadableStream & { pause(): void }).pause();
                    (ws as NodeJS.WritableStream & { once(ev: 'drain', cb: () => void): void }).once('drain', () => {
                        (res.stream as NodeJS.ReadableStream & { resume(): void }).resume();
                    });
                }
            });
            res.stream.on('end', () => {
                ws.end(() => {
                    if (!settled) {
                        settled = true;
                        resolve();
                    }
                });
            });
            res.stream.on('error', fail);
            (ws as NodeJS.EventEmitter).on('error', fail);
            // Транспорт отдаёт поток на паузе — возобновляем после подписки.
            (res.stream as NodeJS.ReadableStream & { resume(): void }).resume();
        });
    }
}

/** Реальные зависимости поверх node:fs + встроенного транспорта. */
export function createNodeDownloaderDeps(downloadDir: string): DownloaderDeps {
    // Динамический import внутри CommonJS-сборки tsc даёт require — ок для node:fs.
    const { createWriteStream } = require('node:fs') as typeof import('node:fs');
    const fsPromises = require('node:fs/promises') as typeof import('node:fs/promises');
    const { join } = require('node:path') as typeof import('node:path');
    return {
        downloadDir,
        probe: (url) => probeUrl(url),
        stream: (url, options) => nodeTransport.stream(url, options),
        sizeOf: async (path) => {
            try {
                const s = await fsPromises.stat(path);
                return s.isFile() ? s.size : null;
            } catch {
                return null;
            }
        },
        write: (path, append) => createWriteStream(path, { flags: append ? 'a' : 'w' }),
        rename: (from, to) => fsPromises.rename(from, to),
        mkdirp: async (path) => {
            await fsPromises.mkdir(path, { recursive: true });
        },
        readFingerprint: async (fileName) => {
            try {
                const raw = await fsPromises.readFile(join(downloadDir, `${fileName}.fp`), 'utf8');
                const parsed = JSON.parse(raw) as FileFingerprint;
                if (
                    typeof parsed.size === 'number' &&
                    typeof parsed.head === 'string' &&
                    typeof parsed.tail === 'string'
                ) {
                    return parsed;
                }
                return null;
            } catch {
                return null;
            }
        },
        storeFingerprint: async (fileName, size) => {
            const path = join(downloadDir, fileName);
            let fh: FileHandle;
            try {
                fh = await fsPromises.open(path, 'r');
            } catch {
                return;
            }
            try {
                const headLen = Math.min(FINGERPRINT_BYTES, Math.max(0, size));
                const head = Buffer.alloc(headLen);
                await fh.read(head, 0, headLen, 0);
                let tail = head;
                if (size > FINGERPRINT_BYTES) {
                    tail = Buffer.alloc(FINGERPRINT_BYTES);
                    await fh.read(tail, 0, FINGERPRINT_BYTES, size - FINGERPRINT_BYTES);
                }
                const fp: FileFingerprint = { size, head: hashBuffer(head), tail: hashBuffer(tail) };
                await fsPromises.writeFile(`${path}.fp`, JSON.stringify(fp), 'utf8');
            } finally {
                await fh.close();
            }
        },
    };
}

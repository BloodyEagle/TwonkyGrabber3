/**
 * Дисковый кэш превью.
 *
 * Без кэша каждый показ страницы галереи заново тянет картинки с Twonky, а для
 * видео — по два upstream-запроса на карточку (scale → не картинка → оригинал →
 * не картинка). Здесь кэшируются и положительные ответы, и «отрицательные» (404).
 *
 * Каждая запись — пара файлов: <key>.json (мета: content-type, время записи,
 * признак 404) и <key>.bin (тело). Ключ включает эпоху библиотеки — сброс скана
 * инвалидирует кэш автоматически, старые записи удаляются обрезкой по TTL.
 *
 * Одновременные запросы одного ключа дедуплицируются — один upstream-запрос.
 * Переполнение — LRU-обрезка по времени записи до THUMB_CACHE_MAX_BYTES.
 */
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { C, THUMB_PRUNE_EVERY_BYTES } from '../config';

/** Результат загрузки апстрима для кэша. */
export type ThumbLoadResult =
    | { type: 'content'; contentType: string; body: Buffer; /** Писать в дисковый кэш. */ cache: boolean }
    | { type: 'negative' };

/** Мета-файл записи кэша. */
interface ThumbMeta {
    neg: boolean;
    ct: string;
    /** Время записи, epoch ms (основа TTL и LRU-обрезки). */
    at: number;
}

export class ThumbCache {
    private readonly inflight = new Map<string, Promise<ThumbLoadResult>>();
    /** Записано байт с последней обрезки (триггер периодической обрезки). */
    private dirtyBytes = 0;
    private pruning = false;

    constructor(private readonly dir: string) {}

    /** Ключ записи: сессия (host_port), эпоха библиотеки, номер, размер ('WxH'|'orig'). */
    static key(session: string, epoch: number, n: number, size: string): string {
        return `${session}_${epoch}_${n}_${size}`;
    }

    /** Взять из кэша; null — промах. Просроченные записи удаляются на месте. */
    async get(key: string): Promise<ThumbLoadResult | null> {
        let meta: ThumbMeta;
        try {
            meta = JSON.parse(await readFile(join(this.dir, `${key}.json`), 'utf8')) as ThumbMeta;
        } catch {
            return null;
        }
        if (typeof meta?.at !== 'number' || typeof meta?.neg !== 'boolean') return null;
        const ttlSec = meta.neg ? C.THUMB_NEG_CACHE_TTL : C.THUMB_CACHE_MAX_AGE;
        if (Date.now() - meta.at > ttlSec * 1000) {
            void this.drop(key);
            return null;
        }
        if (meta.neg) return { type: 'negative' };
        try {
            const body = await readFile(join(this.dir, `${key}.bin`));
            return { type: 'content', contentType: meta.ct, body, cache: false };
        } catch {
            return null;
        }
    }

    /** Записать (tmp + rename); ошибки кэша не влияют на ответ клиенту. */
    async put(key: string, result: ThumbLoadResult): Promise<void> {
        try {
            await mkdir(this.dir, { recursive: true });
            const meta: ThumbMeta =
                result.type === 'negative'
                    ? { neg: true, ct: '', at: Date.now() }
                    : { neg: false, ct: result.contentType, at: Date.now() };
            await this.atomicWrite(join(this.dir, `${key}.json`), Buffer.from(JSON.stringify(meta), 'utf8'));
            if (result.type === 'content') {
                await this.atomicWrite(join(this.dir, `${key}.bin`), result.body);
                this.dirtyBytes += result.body.length;
                if (this.dirtyBytes >= THUMB_PRUNE_EVERY_BYTES) void this.prune();
            }
        } catch {
            /* кэш не критичен для ответа */
        }
    }

    /** Значение из кэша либо через загрузчик; одновременные вызовы одного ключа дедуплицируются. */
    async getOrLoad(key: string, loader: () => Promise<ThumbLoadResult>): Promise<ThumbLoadResult> {
        const cached = await this.get(key).catch(() => null);
        if (cached !== null) return cached;
        const pending = this.inflight.get(key);
        if (pending !== undefined) return pending;
        const promise = (async () => {
            const result = await loader();
            if (result.type === 'negative' || result.cache) await this.put(key, result);
            return result;
        })().finally(() => {
            this.inflight.delete(key);
        });
        this.inflight.set(key, promise);
        return promise;
    }

    /** Обрезка кэша: просрочка по TTL, затем LRU по времени записи до THUMB_CACHE_MAX_BYTES. */
    async prune(): Promise<void> {
        if (this.pruning) return;
        this.pruning = true;
        this.dirtyBytes = 0;
        try {
            let names: string[];
            try {
                names = await readdir(this.dir);
            } catch {
                return; // каталога ещё нет
            }
            interface Item {
                key: string;
                neg: boolean;
                at: number;
                size: number;
            }
            const items = new Map<string, Item>();
            for (const name of names) {
                // Остатки прерванной записи (tmp + rename) — мусор, удаляем.
                if (name.endsWith('.tmp')) {
                    void rm(join(this.dir, name), { force: true }).catch(() => undefined);
                    continue;
                }
                if (!name.endsWith('.json')) continue;
                const key = name.slice(0, -'.json'.length);
                try {
                    const meta = JSON.parse(await readFile(join(this.dir, name), 'utf8')) as ThumbMeta;
                    let size = 0;
                    if (!meta.neg) {
                        const st = await stat(join(this.dir, `${key}.bin`)).catch(() => null);
                        if (st === null) continue; // тело отсутствует — запись неполна
                        size = st.size;
                    }
                    items.set(key, { key, neg: meta.neg, at: meta.at, size });
                } catch {
                    continue;
                }
            }
            const now = Date.now();
            let total = 0;
            const alive: Item[] = [];
            for (const item of items.values()) {
                const ttlSec = item.neg ? C.THUMB_NEG_CACHE_TTL : C.THUMB_CACHE_MAX_AGE;
                if (now - item.at > ttlSec * 1000) {
                    void this.drop(item.key);
                    continue;
                }
                total += item.size;
                alive.push(item);
            }
            if (total <= C.THUMB_CACHE_MAX_BYTES) return;
            alive.sort((a, b) => a.at - b.at); // самые старые записи — первыми
            for (const item of alive) {
                if (total <= C.THUMB_CACHE_MAX_BYTES) break;
                void this.drop(item.key);
                total -= item.size;
            }
        } finally {
            this.pruning = false;
        }
    }

    private async drop(key: string): Promise<void> {
        try {
            await unlink(join(this.dir, `${key}.json`));
        } catch {
            /* нет файла — ок */
        }
        try {
            await unlink(join(this.dir, `${key}.bin`));
        } catch {
            /* нет файла — ок */
        }
    }

    private async atomicWrite(path: string, data: Buffer): Promise<void> {
        const tmp = `${path}.tmp`;
        await writeFile(tmp, data);
        await rename(tmp, path);
    }
}

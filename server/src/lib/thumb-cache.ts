/**
 * Дисковый кэш превью.
 *
 * Без кэша каждый показ страницы галереи заново тянет картинки с Twonky, а для
 * видео — по два upstream-запроса на карточку (scale → не картинка → оригинал →
 * не картинка). Здесь кэшируются и положительные ответы, и «отрицательные» (404).
 *
 * Каждая запись — пара файлов: <key>.json (мета: content-type, время записи,
 * признак 404) и <key>.bin (тело). Мета — маркер готовности: тело пишется первым,
 * мета последней; сбой между ними оставляет .bin без .json, который обрезка
 * удаляет как осиротевший (и наоборот — мету без тела). Ключ включает эпоху
 * библиотеки — сброс скана инвалидирует кэш автоматически, старые записи
 * удаляются обрезкой по TTL.
 *
 * Одновременные запросы одного ключа дедуплицируются — один upstream-запрос;
 * когда все клиенты ключа отвалились, загрузка прерывается через cancelInflight.
 * Переполнение — LRU-обрезка по времени записи до THUMB_CACHE_MAX_BYTES.
 */
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { C, THUMB_PRUNE_EVERY_BYTES } from '../config';
import { logWarn } from './log';

/** Результат загрузки апстрима для кэша. */
export type ThumbLoadResult =
    | { type: 'content'; contentType: string; body: Buffer; /** Писать в дисковый кэш. */ cache: boolean }
    /** «Файла нет» (404/410 или не картинка) — кэшируется на THUMB_NEG_CACHE_TTL. */
    | { type: 'negative' }
    /** Тело больше THUMB_CACHE_FILE_MAX_BYTES — отдаётся потоково, в кэш не пишется. */
    | { type: 'toolarge' }
    /** Временная недоступность апстрима (прочие не-200) — в кэш не пишется. */
    | { type: 'unavail'; status: number };

/** Мета-файл записи кэша. */
interface ThumbMeta {
    neg: boolean;
    ct: string;
    /** Время записи, epoch ms (основа TTL и LRU-обрезки). */
    at: number;
}

/** Дедуплицированная загрузка в полёте. */
interface InflightEntry {
    promise: Promise<ThumbLoadResult>;
    /** Прерывание upstream-загрузки (все клиенты ключа отвалились); null после отмены. */
    cancel: (() => void) | null;
}

export class ThumbCache {
    private readonly inflight = new Map<string, InflightEntry>();
    /** Записано байт с последней обрезки (триггер периодической обрезки). */
    private dirtyBytes = 0;
    private pruning = false;
    /** Повторная обрезка запрошена во время текущей — исполняется сразу после неё. */
    private prunePending = false;

    constructor(private readonly dir: string) {}

    /** Префикс ключей сессии: длина имени в ключе исключает коллизии префиксов
     *  («host_80» является префиксом «host_8080») при очистке по закрытии сессии. */
    static sessionPrefix(dir: string): string {
        return `${dir.length}:${dir}_`;
    }

    /** Ключ записи: сессия (host_port), эпоха библиотеки, номер, размер ('WxH'|'orig'). */
    static key(session: string, epoch: number, n: number, size: string): string {
        return `${ThumbCache.sessionPrefix(session)}${epoch}_${n}_${size}`;
    }

    /** TTL-просрочка записи — общее правило для get() и prune(). */
    private static isExpired(meta: Pick<ThumbMeta, 'neg' | 'at'>, now: number): boolean {
        const ttlSec = meta.neg ? C.THUMB_NEG_CACHE_TTL : C.THUMB_CACHE_MAX_AGE;
        return now - meta.at > ttlSec * 1000;
    }

    /** Взять из кэша; null — промах. Просроченные и битые записи удаляются на месте. */
    async get(key: string): Promise<ThumbLoadResult | null> {
        let meta: ThumbMeta;
        try {
            meta = JSON.parse(await readFile(join(this.dir, `${key}.json`), 'utf8')) as ThumbMeta;
        } catch {
            return null;
        }
        if (typeof meta?.at !== 'number' || typeof meta?.neg !== 'boolean') return null;
        if (ThumbCache.isExpired(meta, Date.now())) {
            void this.drop(key);
            return null;
        }
        if (meta.neg) return { type: 'negative' };
        try {
            const body = await readFile(join(this.dir, `${key}.bin`));
            return { type: 'content', contentType: meta.ct, body, cache: false };
        } catch (err: unknown) {
            // Мета без тела (осиротевшая запись) — удаляем, чтобы не жила до TTL.
            logWarn('thumb-cache', `тело записи ${key} не читается — запись удаляется`, err);
            void this.drop(key);
            return null;
        }
    }

    /** Записать (tmp + rename); ошибки кэша не влияют на ответ клиенту, но логируются. */
    async put(key: string, result: ThumbLoadResult): Promise<void> {
        if (result.type !== 'content' && result.type !== 'negative') return; // toolarge/unavail не кэшируются
        try {
            await mkdir(this.dir, { recursive: true });
            if (result.type === 'content') {
                // Тело пишется первым, мета последней (мета = маркер готовности):
                // сбой посреди записи оставит .bin без .json — его удалит обрезка.
                await this.atomicWrite(join(this.dir, `${key}.bin`), result.body);
            } else {
                // Негативная запись не имеет тела; затирать старое тело нечего —
                // но если ключ раньше был позитивным, удаляем остаток.
                await rm(join(this.dir, `${key}.bin`), { force: true }).catch(() => undefined);
            }
            const meta: ThumbMeta =
                result.type === 'negative'
                    ? { neg: true, ct: '', at: Date.now() }
                    : { neg: false, ct: result.contentType, at: Date.now() };
            await this.atomicWrite(join(this.dir, `${key}.json`), Buffer.from(JSON.stringify(meta), 'utf8'));
            if (result.type === 'content') {
                this.dirtyBytes += result.body.length;
                if (this.dirtyBytes >= THUMB_PRUNE_EVERY_BYTES) void this.prune();
            }
        } catch (err: unknown) {
            logWarn('thumb-cache', `запись в кэш ${key} не удалась`, err);
        }
    }

    /**
     * Значение из кэша либо через загрузчик; одновременные вызовы одного ключа
     * дедуплицируются. loader получает сигнал отмены — он срабатывает, когда все
     * клиенты ключа отвалились (см. cancelInflight).
     */
    async getOrLoad(
        key: string,
        loader: (signal: AbortSignal) => Promise<ThumbLoadResult>,
    ): Promise<ThumbLoadResult> {
        const cached = await this.get(key).catch(() => null);
        if (cached !== null) return cached;
        const pending = this.inflight.get(key);
        if (pending !== undefined) return pending.promise;
        const controller = new AbortController();
        const promise = (async () => {
            const result = await loader(controller.signal);
            if (result.type === 'negative' || (result.type === 'content' && result.cache)) {
                await this.put(key, result);
            }
            return result;
        })().finally(() => {
            this.inflight.delete(key);
        });
        this.inflight.set(key, { promise, cancel: () => controller.abort() });
        return promise;
    }

    /** Прервать in-flight загрузку ключа (все её клиенты отвалились — plan §7).
     *  После завершения загрузки — no-op. */
    cancelInflight(key: string): void {
        const entry = this.inflight.get(key);
        if (entry === undefined) return;
        entry.cancel?.();
        entry.cancel = null;
    }

    /** Удалить все записи сессии по префиксу ключа — при закрытии вкладки
     *  (plan §2, фикс №2: превью закрытой сессии не висят до TTL). */
    async purgePrefix(prefix: string): Promise<void> {
        let names: string[];
        try {
            names = await readdir(this.dir);
        } catch {
            return; // каталога ещё нет
        }
        const stale = names.filter((name) => name.startsWith(prefix));
        await Promise.all(stale.map((name) => rm(join(this.dir, name), { force: true }).catch(() => undefined)));
    }

    /** Обрезка кэша: осиротевшие/битые записи, просрочка по TTL, затем LRU
     *  по времени записи до THUMB_CACHE_MAX_BYTES. Повторный вызов во время
     *  идущей обрезки не пропускается, а откладывается до её конца. */
    async prune(): Promise<void> {
        if (this.pruning) {
            this.prunePending = true;
            return;
        }
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
            /** Ключи, у которых есть .bin, — для поиска осиротевших тел без меты. */
            const bins = new Set<string>();
            for (const name of names) {
                // Остатки прерванной записи (tmp + rename) — мусор, удаляем.
                if (name.endsWith('.tmp')) {
                    void rm(join(this.dir, name), { force: true }).catch(() => undefined);
                    continue;
                }
                if (name.endsWith('.bin')) {
                    bins.add(name.slice(0, -'.bin'.length));
                    continue;
                }
                if (!name.endsWith('.json')) continue;
                const key = name.slice(0, -'.json'.length);
                try {
                    const meta = JSON.parse(await readFile(join(this.dir, name), 'utf8')) as ThumbMeta;
                    if (typeof meta?.at !== 'number' || typeof meta?.neg !== 'boolean') {
                        // Битая мета — запись нечитаема, удаляем целиком.
                        void this.drop(key);
                        continue;
                    }
                    let size = 0;
                    if (!meta.neg) {
                        const st = await stat(join(this.dir, `${key}.bin`)).catch(() => null);
                        if (st === null) {
                            // Мета без тела — осиротевшая запись, удаляем, а не пропускаем.
                            void this.drop(key);
                            continue;
                        }
                        size = st.size;
                    }
                    items.set(key, { key, neg: meta.neg, at: meta.at, size });
                } catch (err: unknown) {
                    logWarn('thumb-cache', `мета-файл ${name} не читается — запись удаляется`, err);
                    void this.drop(key);
                }
            }
            // Тела без меты: запись не была завершена — мусор, удаляем.
            for (const key of bins) {
                if (!items.has(key)) {
                    void rm(join(this.dir, `${key}.bin`), { force: true }).catch(() => undefined);
                }
            }
            const now = Date.now();
            let total = 0;
            const alive: Item[] = [];
            for (const item of items.values()) {
                if (ThumbCache.isExpired(item, now)) {
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
            if (this.prunePending) {
                this.prunePending = false;
                void this.prune();
            }
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

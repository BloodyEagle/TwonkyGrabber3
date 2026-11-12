/**
 * REST + SSE маршруты API (план, п.8) — мульти-серверная версия.
 *
 * Все операции с конкретным Twonky-сервером скоупятся сессией:
 *   /api/sessions                       — список / создание / удаление
 *   /api/sessions/:id/scan/*            — управление сканом
 *   /api/sessions/:id/files, /thumb     — находки и превью
 *   /api/sessions/:id/queue*            — очередь скачивания
 *   /api/sessions/:id/settings          — настройки загрузчика сессии
 *   /api/sessions/:id/state/reset       — сброс скана/очереди сессии
 * Глобальны только /api/config и /api/events (SSE-события несут sid).
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { C, applyConfigPatch, configSnapshot, MAX_SESSIONS, THUMB_CACHE_FILE_MAX_BYTES } from '../config';
import { checkAvailable } from './probe';
import { fetchServerStats } from './server-stats';
import { nodeTransport } from './http';
import { logError } from './log';
import { fileUrl, parseConnectionUrl, thumbUrl } from './url-parser';
import { ThumbCache } from './thumb-cache';
import type { ThumbLoadResult } from './thumb-cache';
import type { Session, SessionManager } from './sessions';
import type { FoundFile, QueueCounts, ScanProgress, TwonkyConnection } from './types';

export interface ApiDeps {
    sessions: SessionManager;
    /** Дисковый кэш превью (позитивный + негативный 404). */
    thumbCache: ThumbCache;
}

/** Краткое описание сессии для фронтенда (вкладка + первичный снимок). */
export interface SessionSummary {
    id: string;
    dir: string;
    connection: TwonkyConnection | null;
    scan: ScanProgress;
    queue: { counts: QueueCounts; paused: boolean; autoAll: boolean };
}

function sessionSummary(session: Session): SessionSummary {
    const q = session.downloader.state();
    return {
        id: session.id,
        dir: session.dir,
        connection: session.scanner.getConnection(),
        scan: session.scanner.progress(),
        queue: { counts: q.counts, paused: q.paused, autoAll: q.autoAll },
    };
}

/** SSE-хаб: sessions/scan ~500 мс, found — батчами по sid, queue ~1 с, heartbeat. */
class SseHub {
    private readonly clients = new Set<Response>();
    private readonly foundBuffer = new Map<string, FoundFile[]>();
    private readonly timers: NodeJS.Timeout[] = [];

    constructor(private readonly sessions: SessionManager) {
        sessions.addOnFound((session, files) => {
            const buffer = this.foundBuffer.get(session.id) ?? [];
            buffer.push(...files);
            this.foundBuffer.set(session.id, buffer);
        });
        sessions.addOnChange(() => {
            if (this.clients.size > 0) this.sendSnapshots();
        });

        this.timers.push(
            setInterval(() => {
                if (this.clients.size > 0) this.sendScanTick();
            }, C.SSE_SCAN_MS),
        );

        this.timers.push(
            setInterval(() => {
                if (this.clients.size > 0) {
                    for (const s of this.sessions.list()) {
                        this.sendAll('queue', { sid: s.id, ...s.downloader.state() });
                    }
                }
            }, C.SSE_QUEUE_MS),
        );

        this.timers.push(
            setInterval(() => {
                if (this.clients.size === 0) {
                    // Никто не слушает — найденное не накапливаем (и сессии могли удалиться).
                    this.foundBuffer.clear();
                    return;
                }
                for (const [sid, files] of this.foundBuffer) {
                    if (files.length > 0) this.sendAll('found', { sid, files });
                }
                this.foundBuffer.clear();
            }, C.SSE_FOUND_FLUSH_MS),
        );

        this.timers.push(
            setInterval(() => {
                for (const res of this.clients) res.write(': hb\n\n');
            }, C.SSE_HEARTBEAT_MS),
        );
    }

    handle(req: Request, res: Response): void {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });
        // Снимок сразу при подключении.
        this.sendSnapshotsTo(res);
        this.clients.add(res);
        req.on('close', () => {
            this.clients.delete(res);
        });
    }

    /** Тик скана: прогресс каждой сессии (список рассылается только при изменении —
     *  внутри одного SSE-сокета порядок событий гарантирован, гонок с тиками нет). */
    private sendScanTick(): void {
        for (const s of this.sessions.list()) {
            this.sendAll('scan', { sid: s.id, ...s.scanner.progress() });
        }
    }

    /** Полный снимок (подключение клиента / изменение списка сессий). */
    private sendSnapshots(): void {
        for (const res of this.clients) this.sendSnapshotsTo(res);
    }

    private sendSnapshotsTo(res: Response): void {
        this.send(res, 'sessions', this.sessions.list().map((s) => ({ id: s.id, dir: s.dir })));
        for (const s of this.sessions.list()) {
            this.send(res, 'scan', { sid: s.id, ...s.scanner.progress() });
            this.send(res, 'queue', { sid: s.id, ...s.downloader.state() });
        }
    }

    private send(res: Response, event: string, data: unknown): void {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    private sendAll(event: string, data: unknown): void {
        for (const res of this.clients) this.send(res, event, data);
    }
}

/** Значение query-параметра как строка (первый элемент массива допускается). */
function queryToString(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
    return null;
}

/** Целое из query с дефолтом; null — указано, но не целое или отрицательное. */
function queryToInt(value: unknown, def: number): number | null {
    const raw = queryToString(value);
    if (raw === null || raw === '') return def;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Создание Express-роутера со всеми API. */
export function createApiRouter(deps: ApiDeps): Router {
    const { sessions } = deps;
    const router = Router();
    const hub = new SseHub(sessions);

    /** Сессия из :id или 404. */
    const resolve = (id: string | undefined, res: Response): Session | null => {
        const session = id === undefined ? null : sessions.get(id);
        if (session === null) {
            res.status(404).json({ ok: false, reason: 'Сессия не найдена — возможно, сервер уже убран' });
            return null;
        }
        return session;
    };

    router.get('/health', (_req, res) => {
        res.json({ ok: true });
    });

    // --- Сессии (вкладки серверов) ---

    router.get('/sessions', (_req, res) => {
        res.json({ items: sessions.list().map(sessionSummary) });
    });

    // Новая вкладка сервера: парсинг URL + проверка доступности пробой на стартовый номер.
    router.post('/sessions', (req, res) => {
        if (sessions.count() >= MAX_SESSIONS) {
            res.status(409).json({
                ok: false,
                reason: `Достигнут предел серверов (${MAX_SESSIONS}) — закройте лишние вкладки`,
            });
            return;
        }
        const url = typeof req.body?.url === 'string' ? req.body.url : '';
        const parsed = parseConnectionUrl(url);
        if (!parsed.ok) {
            res.status(400).json({ ok: false, reason: parsed.error });
            return;
        }
        const conn = parsed.connection;
        // Любой HTTP-ответ (в т.ч. 404) означает, что сервер доступен.
        void checkAvailable(fileUrl(conn, conn.startNumber)).then((exists) => {
            if (!exists) {
                res.status(502).json({ ok: false, reason: 'Сервер недоступен по указанному адресу' });
                return;
            }
            let session: Session;
            try {
                session = sessions.create(conn);
            } catch (err: unknown) {
                res.status(409).json({ ok: false, reason: err instanceof Error ? err.message : String(err) });
                return;
            }
            // Точные счётчики (/rpc/info_status) — для досрочной остановки скана.
            void fetchServerStats(conn).then((stats) => {
                session.scanner.setServerTotals(stats);
            });
            res.json({ ok: true, session: sessionSummary(session) });
        });
    });

    router.delete('/sessions/:id', (req, res) => {
        const ok = sessions.remove(req.params.id);
        if (!ok) {
            res.status(404).json({ ok: false, reason: 'Сессия не найдена' });
            return;
        }
        res.json({ ok: true });
    });

    // --- Скан ---

    router.post('/sessions/:id/scan/start', (req, res) => {
        const session = resolve(req.params.id, res);
        if (session === null) return;
        const conn = session.scanner.getConnection();
        if (conn === null) {
            res.status(409).json({ ok: false, reason: 'У сессии нет подключения' });
            return;
        }
        session.scanner.start(conn);
        res.json(session.scanner.progress());
    });

    router.post('/sessions/:id/scan/stop', (req, res) => {
        const session = resolve(req.params.id, res);
        if (session === null) return;
        session.scanner.stop();
        res.json(session.scanner.progress());
    });

    router.get('/sessions/:id/scan/status', (req, res) => {
        const session = resolve(req.params.id, res);
        if (session === null) return;
        res.json(session.scanner.progress());
    });

    // --- Находки ---

    // Список найденных файлов: пагинация, фильтр по типу, сортировка по номеру.
    router.get('/sessions/:id/files', (req, res) => {
        const session = resolve(req.params.id, res);
        if (session === null) return;
        const page = queryToInt(req.query.page, C.FILES_PAGE_DEFAULT);
        const size = queryToInt(req.query.size, C.FILES_PAGE_SIZE_DEFAULT);
        const sort = queryToString(req.query.sort) ?? 'asc';
        const type = queryToString(req.query.type) ?? 'all';
        if (page === null || page < 1) {
            res.status(400).json({ ok: false, reason: 'Параметр page должен быть целым числом не меньше 1' });
            return;
        }
        if (size === null || size < 1) {
            res.status(400).json({ ok: false, reason: 'Параметр size должен быть целым числом не меньше 1' });
            return;
        }
        if (sort !== 'asc' && sort !== 'desc') {
            res.status(400).json({ ok: false, reason: 'sort может быть только asc или desc' });
            return;
        }
        if (type !== 'all' && type !== 'image' && type !== 'video') {
            res.status(400).json({ ok: false, reason: 'type может быть только all, image или video' });
            return;
        }
        const clampedSize = Math.min(size, C.FILES_PAGE_SIZE_MAX);
        const all = session.scanner.foundList();
        const filtered = type === 'all' ? all : all.filter((f) => f.kind === type);
        // Копия под reverse — foundList() возвращает кэш сканера, мутировать его нельзя.
        const items = sort === 'desc' ? [...filtered].reverse() : filtered;
        const start = (page - 1) * clampedSize;
        res.json({
            total: items.length,
            page,
            size: clampedSize,
            items: items.slice(start, start + clampedSize),
        });
    });

    // --- Превью ---

    /**
     * Прочитать тело апстрима с потолком размера (SPEC-8): тело больше cap не
     * буферизуется — поток уничтожается, возвращается null. Таймаут простоя
     * ограничивает зависания.
     */
    const readCapped = (
        stream: NodeJS.ReadableStream & { destroy(err?: Error | undefined): void },
        cap: number,
    ): Promise<Buffer | null> =>
        new Promise<Buffer | null>((resolve, reject) => {
            const chunks: Buffer[] = [];
            let total = 0;
            let settled = false;
            stream.on('data', (chunk: Buffer) => {
                if (settled) return;
                total += chunk.length;
                if (total > cap) {
                    settled = true;
                    stream.destroy();
                    resolve(null);
                    return;
                }
                chunks.push(chunk);
            });
            stream.on('end', () => {
                if (!settled) {
                    settled = true;
                    resolve(Buffer.concat(chunks));
                }
            });
            stream.on('error', (err: unknown) => {
                if (!settled) {
                    settled = true;
                    reject(err instanceof Error ? err : new Error(String(err)));
                }
            });
            stream.resume();
        });

    /**
     * Загрузка картинки с апстрима для кэша. Исходы:
     *  - content — картинка, тело целиком (не больше THUMB_CACHE_FILE_MAX_BYTES);
     *  - negative — «файла нет» (404/410 или не картинка) — кэшируется;
     *  - unavail — прочие не-200 (5xx, 403…): временное состояние сервера, в
     *    негативный кэш не попадает, чтобы разовый сбой не кэшировался как
     *    «файла нет» (SPEC-2);
     *  - toolarge — тело больше THUMB_CACHE_FILE_MAX_BYTES: отдаётся потоково,
     *    без буферизации в памяти (SPEC-8).
     * Сетевая ошибка — исключение (502); signal — отмена при обрыве клиента.
     */
    const fetchImage = async (url: string, signal?: AbortSignal): Promise<ThumbLoadResult> => {
        const upstream = await nodeTransport.stream(url, { headers: {}, idleTimeoutMs: C.PROBE_TIMEOUT, signal });
        try {
            const contentType = String(upstream.headers['content-type'] ?? '');
            if (upstream.status === 404 || upstream.status === 410) {
                upstream.stream.destroy();
                return { type: 'negative' };
            }
            if (upstream.status !== 200 || !contentType.startsWith('image/')) {
                upstream.stream.destroy();
                return { type: 'unavail', status: upstream.status };
            }
            // Потолок по Content-Length — ещё до скачивания; без заголовка потолок
            // контролируется в ходе чтения (readCapped).
            const clRaw = upstream.headers['content-length'];
            const cl = Array.isArray(clRaw) ? clRaw[0] : clRaw;
            const declared = cl !== undefined ? Number.parseInt(cl, 10) : Number.NaN;
            if (Number.isFinite(declared) && declared > THUMB_CACHE_FILE_MAX_BYTES) {
                upstream.stream.destroy();
                return { type: 'toolarge' };
            }
            const body = await readCapped(upstream.stream, THUMB_CACHE_FILE_MAX_BYTES);
            if (body === null) return { type: 'toolarge' };
            return { type: 'content', contentType, body, cache: true };
        } catch (err: unknown) {
            upstream.stream.destroy();
            throw err;
        }
    };

    const sendThumbResult = (res: Response, result: ThumbLoadResult): void => {
        if (result.type === 'negative') {
            res.status(404).end();
            return;
        }
        if (result.type === 'unavail') {
            res.status(502).json({ ok: false, reason: `Медиасервер ответил HTTP ${result.status}` });
            return;
        }
        res.status(200);
        res.set('Content-Type', result.contentType);
        res.set('Content-Length', String(result.body.length));
        res.set('Cache-Control', `public, max-age=${C.THUMB_CACHE_MAX_AGE}`);
        res.end(result.body);
    };

    /** Клиенты in-flight загрузок превью по ключу кэша: когда последний клиент
     *  ключа отвалился, апстрим-загрузка прерывается (plan §7, SPEC-3). */
    const thumbWaiters = new Map<string, Set<Response>>();
    const trackThumbClient = (key: string, res: Response, onLastClose: () => void): void => {
        let clients = thumbWaiters.get(key);
        if (clients === undefined) {
            clients = new Set();
            thumbWaiters.set(key, clients);
        }
        clients.add(res);
        res.on('close', () => {
            const set = thumbWaiters.get(key);
            if (set === undefined) return;
            set.delete(res);
            if (set.size === 0) {
                thumbWaiters.delete(key);
                onLastClose();
            }
        });
    };

    router.get('/sessions/:id/thumb', (req, res) => {
        const session = resolve(req.params.id, res);
        if (session === null) return;
        const n = Number.parseInt(String(queryToString(req.query.n) ?? ''), 10);
        if (!Number.isInteger(n) || n < 0) {
            res.status(400).json({ ok: false, reason: 'Параметр n обязателен (целое число)' });
            return;
        }
        const conn = session.scanner.getConnection();
        if (conn === null) {
            res.status(409).json({ ok: false, reason: 'У сессии нет подключения' });
            return;
        }
        const epoch = session.scanner.epoch();

        let clientGone = false;
        const failNeterr = (err: unknown): void => {
            if (clientGone) return; // клиент отвалился — ответ и лог не нужны
            logError('thumb', `сервер недоступен при запросе превью #${n}`, err);
            if (!res.headersSent) {
                res.status(502).json({
                    ok: false,
                    reason: `Сервер недоступен: ${err instanceof Error ? err.message : String(err)}`,
                });
            }
        };

        /** Потоковая отдача тела апстрима напрямую клиенту (oversize-оригиналы):
         *  память не буферизуется (SPEC-8), обрыв клиента уничтожает апстрим (plan §7). */
        const streamOriginal = (res: Response): void => {
            nodeTransport
                .stream(fileUrl(conn, n), { headers: {}, idleTimeoutMs: C.PROBE_TIMEOUT })
                .then((upstream) => {
                    const contentType = String(upstream.headers['content-type'] ?? '');
                    if (upstream.status !== 200 || !contentType.startsWith('image/')) {
                        upstream.stream.destroy();
                        if (!res.headersSent) {
                            if (upstream.status === 404 || upstream.status === 410) res.status(404).end();
                            else res.status(502).json({ ok: false, reason: `Медиасервер ответил HTTP ${upstream.status}` });
                        }
                        return;
                    }
                    res.status(200);
                    res.set('Content-Type', contentType);
                    const clRaw = upstream.headers['content-length'];
                    const cl = Array.isArray(clRaw) ? clRaw[0] : clRaw;
                    if (cl !== undefined) res.set('Content-Length', cl);
                    res.set('Cache-Control', `public, max-age=${C.THUMB_CACHE_MAX_AGE}`);
                    upstream.stream.pipe(res);
                    upstream.stream.on('error', () => {
                        res.destroy();
                    });
                    // Обрыв клиента → destroy апстрима (plan §7).
                    res.on('close', () => upstream.stream.destroy());
                })
                .catch((err: unknown) => failNeterr(err));
        };

        /** Общая доставка: трекинг клиентов ключа, кэш/загрузка, oversize — потоком. */
        const deliver = (key: string, loader: (signal: AbortSignal) => Promise<ThumbLoadResult>): void => {
            res.on('close', () => {
                clientGone = true;
            });
            trackThumbClient(key, res, () => deps.thumbCache.cancelInflight(key));
            void deps.thumbCache
                .getOrLoad(key, loader)
                .then((result) => {
                    if (clientGone) return; // клиент отвалился, пока грузили
                    if (result.type === 'toolarge') {
                        // Oversize-тело в кэш не попадает — потоковый повтор запроса.
                        streamOriginal(res);
                        return;
                    }
                    sendThumbResult(res, result);
                })
                .catch(failNeterr);
        };

        if (queryToString(req.query.orig) === '1') {
            // Принудительно оригинал (открытие полного изображения);
            // не-картинка (видео) → негативный кэш и заглушка на фронте.
            deliver(ThumbCache.key(session.dir, epoch, n, 'orig'), (signal) =>
                fetchImage(fileUrl(conn, n), signal),
            );
            return;
        }

        const w = Number.parseInt(String(queryToString(req.query.w) ?? ''), 10);
        const h = Number.parseInt(String(queryToString(req.query.h) ?? ''), 10);
        if (!Number.isFinite(w) || !Number.isFinite(h)) {
            res.status(400).json({ ok: false, reason: 'Параметры w и h обязательны' });
            return;
        }
        const clamp = (v: number): number => Math.min(C.THUMB_MAX, Math.max(C.THUMB_MIN, Math.round(v)));
        const size = `${clamp(w)}x${clamp(h)}`;

        deliver(ThumbCache.key(session.dir, epoch, n, size), async (signal) => {
            // Масштабированное превью; если его нет/он недоступен/он oversize —
            // фолбэк на оригинал (видео уйдёт в негативный кэш, oversize — в поток).
            const scaled = await fetchImage(thumbUrl(conn, n, clamp(w), clamp(h)), signal);
            if (scaled.type === 'content') return scaled;
            return fetchImage(fileUrl(conn, n), signal);
        });
    });

    // --- Очередь скачивания (план, п.8) ---

    router.post('/sessions/:id/queue', (req, res) => {
        const session = resolve(req.params.id, res);
        if (session === null) return;
        const raw = req.body?.numbers;
        if (!Array.isArray(raw)) {
            res.status(400).json({ ok: false, reason: 'Ожидается массив numbers' });
            return;
        }
        const numbers = raw.filter((n): n is number => Number.isInteger(n));
        const added = session.downloader.add(numbers);
        res.json({ ok: true, added });
    });

    router.post('/sessions/:id/queue/all', (req, res) => {
        const session = resolve(req.params.id, res);
        if (session === null) return;
        const added = session.downloader.addAll();
        res.json({ ok: true, added });
    });

    router.post('/sessions/:id/queue/pause', (req, res) => {
        const session = resolve(req.params.id, res);
        if (session === null) return;
        session.downloader.pause();
        res.json({ ok: true });
    });

    router.post('/sessions/:id/queue/resume', (req, res) => {
        const session = resolve(req.params.id, res);
        if (session === null) return;
        session.downloader.resume();
        res.json({ ok: true });
    });

    router.post('/sessions/:id/queue/retry-failed', (req, res) => {
        const session = resolve(req.params.id, res);
        if (session === null) return;
        session.downloader.retryFailed();
        res.json({ ok: true });
    });

    router.post('/sessions/:id/queue/clear-completed', (req, res) => {
        const session = resolve(req.params.id, res);
        if (session === null) return;
        session.downloader.clearCompleted();
        res.json({ ok: true });
    });

    router.delete('/sessions/:id/queue/:number', (req, res) => {
        const session = resolve(req.params.id, res);
        if (session === null) return;
        const number = Number.parseInt(String(req.params.number), 10);
        if (!Number.isFinite(number)) {
            res.status(400).json({ ok: false, reason: 'Некорректный номер файла' });
            return;
        }
        const result = session.downloader.remove(number);
        if (result === null) {
            res.status(404).json({ ok: false, reason: 'Элемент очереди не найден' });
            return;
        }
        if (result === false) {
            res.status(409).json({ ok: false, reason: 'Файл сейчас скачивается' });
            return;
        }
        res.json({ ok: true });
    });

    router.get('/sessions/:id/queue', (req, res) => {
        const session = resolve(req.params.id, res);
        if (session === null) return;
        const page = queryToInt(req.query.page, C.QUEUE_PAGE_DEFAULT);
        const size = queryToInt(req.query.size, C.QUEUE_PAGE_SIZE_DEFAULT);
        if (page === null || page < 1 || size === null || size < 1) {
            res.status(400).json({ ok: false, reason: 'Параметры page и size должны быть целыми не меньше 1' });
            return;
        }
        const clamped = Math.min(size, C.QUEUE_PAGE_SIZE_MAX);
        res.json({ ...session.downloader.state(), ...session.downloader.itemsPage(page, clamped) });
    });

    // --- Настройки загрузчика сессии ---

    router.get('/sessions/:id/settings', (req, res) => {
        const session = resolve(req.params.id, res);
        if (session === null) return;
        res.json(session.downloader.settings());
    });

    router.post('/sessions/:id/settings', (req, res) => {
        const session = resolve(req.params.id, res);
        if (session === null) return;
        session.downloader.applySettings(req.body ?? {});
        res.json(session.downloader.settings());
    });

    // --- Сброс состояния сессии (подключение сохраняется — можно сканировать заново) ---

    router.post('/sessions/:id/state/reset', (req, res) => {
        const session = resolve(req.params.id, res);
        if (session === null) return;
        const body = req.body ?? {};
        // Оба флага по умолчанию true; значения неверно типа трактуются как false.
        const scan = body.scan === undefined ? true : body.scan === true;
        const queue = body.queue === undefined ? true : body.queue === true;
        if (scan) {
            const conn = session.scanner.getConnection();
            session.scanner.reset();
            if (conn !== null) session.scanner.setConnection(conn);
        }
        if (queue) session.downloader.resetQueue();
        res.json({ ok: true, ...sessionSummary(session) });
    });

    // --- Глобальная конфигурация ---

    router.get('/config', (_req, res) => {
        res.json(configSnapshot());
    });

    router.post('/config', (req, res) => {
        const body = req.body;
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
            res.status(400).json({ ok: false, reason: 'Ожидается объект с параметрами' });
            return;
        }
        const errors = applyConfigPatch(body as Record<string, unknown>);
        if (errors.length > 0) {
            res.status(400).json({ ok: false, reason: errors.join('; '), errors });
            return;
        }
        res.json({ ok: true, ...configSnapshot() });
    });

    router.get('/events', (req, res) => {
        hub.handle(req, res);
    });

    return router;
}

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
import { C, applyConfigPatch, configSnapshot, MAX_SESSIONS } from '../config';
import { checkAvailable } from './probe';
import { fetchServerStats } from './server-stats';
import { nodeTransport } from './http';
import { fileUrl, parseConnectionUrl, thumbUrl } from './url-parser';
import type { Session, SessionManager } from './sessions';
import type { FoundFile, QueueCounts, ScanProgress, TwonkyConnection } from './types';

export interface ApiDeps {
    sessions: SessionManager;
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
        if (sort === 'desc') filtered.reverse();
        const start = (page - 1) * clampedSize;
        res.json({
            total: filtered.length,
            page,
            size: clampedSize,
            items: filtered.slice(start, start + clampedSize),
        });
    });

    // --- Превью ---

    /**
     * Отдать картинку по URL апстрима; false — ответ непригоден (не 200 / не image),
     * вызывающий решает: fallback на оригинал или 404. Сетевая ошибка — исключение.
     */
    const sendUpstreamImage = async (url: string, res: Response): Promise<boolean> => {
        const upstream = await nodeTransport.stream(url, { headers: {}, idleTimeoutMs: C.PROBE_TIMEOUT });
        const contentType = String(upstream.headers['content-type'] ?? '');
        if (upstream.status !== 200 || !contentType.startsWith('image/')) {
            upstream.stream.destroy();
            return false;
        }
        res.status(200);
        res.set('Content-Type', contentType);
        const length = upstream.headers['content-length'];
        if (length !== undefined) res.set('Content-Length', String(length));
        res.set('Cache-Control', `public, max-age=${C.THUMB_CACHE_MAX_AGE}`);
        // Обрыв клиента → уничтожаем запрос к апстриму (план, п.7).
        res.on('close', () => {
            upstream.stream.destroy();
        });
        upstream.stream.pipe(res);
        upstream.stream.resume();
        return true;
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
        const orig = queryToString(req.query.orig) === '1';

        const failNeterr = (err: unknown): void => {
            res.status(502).json({
                ok: false,
                reason: `Сервер недоступен: ${err instanceof Error ? err.message : String(err)}`,
            });
        };

        if (orig) {
            // Принудительно оригинал; не-картинка (видео) → 404 и заглушка на фронте.
            void sendUpstreamImage(fileUrl(conn, n), res)
                .then((sent) => {
                    if (!sent) res.status(404).end();
                })
                .catch(failNeterr);
            return;
        }

        const w = Number.parseInt(String(queryToString(req.query.w) ?? ''), 10);
        const h = Number.parseInt(String(queryToString(req.query.h) ?? ''), 10);
        if (!Number.isFinite(w) || !Number.isFinite(h)) {
            res.status(400).json({ ok: false, reason: 'Параметры w и h обязательны' });
            return;
        }
        const clamp = (v: number): number => Math.min(C.THUMB_MAX, Math.max(C.THUMB_MIN, Math.round(v)));

        void (async () => {
            try {
                const scaled = await sendUpstreamImage(thumbUrl(conn, n, clamp(w), clamp(h)), res);
                if (scaled) return;
                // Превью нет: fallback на оригинал, но только если это картинка.
                const original = await sendUpstreamImage(fileUrl(conn, n), res);
                if (!original) res.status(404).end();
            } catch (err: unknown) {
                failNeterr(err);
            }
        })();
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

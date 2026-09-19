/**
 * REST + SSE маршруты API (план, п.8).
 * M2: /api/health, /api/connect, /api/scan/*, /api/events.
 * M3: /api/files.
 * M4: /api/queue*, /api/settings, /api/state/reset; SSE-событие queue.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import {
    FILES_PAGE_DEFAULT,
    FILES_PAGE_SIZE_DEFAULT,
    FILES_PAGE_SIZE_MAX,
    QUEUE_PAGE_DEFAULT,
    QUEUE_PAGE_SIZE_DEFAULT,
    QUEUE_PAGE_SIZE_MAX,
    SSE_FOUND_FLUSH_MS,
    SSE_HEARTBEAT_MS,
    SSE_QUEUE_MS,
    SSE_SCAN_MS,
    PROBE_TIMEOUT,
    THUMB_CACHE_MAX_AGE,
    THUMB_MAX,
    THUMB_MIN,
} from '../config';
import { checkAvailable } from './probe';
import { nodeTransport } from './http';
import { fileUrl, parseConnectionUrl, thumbUrl } from './url-parser';
import type { Scanner } from './scanner';
import type { Downloader } from './downloader';
import type { FoundFile } from './types';

export interface ApiDeps {
    scanner: Scanner;
    downloader: Downloader;
}

/** SSE-хаб: scan ~500 мс, found — батчами, queue ~1 с, heartbeat, снимок при подключении. */
class SseHub {
    private readonly clients = new Set<Response>();
    private foundBuffer: FoundFile[] = [];
    private readonly timers: NodeJS.Timeout[] = [];

    constructor(
        private readonly scanner: Scanner,
        private readonly downloader: Downloader,
    ) {
        scanner.addOnFound((files) => {
            this.foundBuffer.push(...files);
        });

        this.timers.push(
            setInterval(() => {
                if (this.clients.size > 0) this.sendAll('scan', scanner.progress());
            }, SSE_SCAN_MS),
        );

        this.timers.push(
            setInterval(() => {
                if (this.clients.size > 0 && this.foundBuffer.length > 0) {
                    const batch = this.foundBuffer;
                    this.foundBuffer = [];
                    this.sendAll('found', batch);
                }
            }, SSE_FOUND_FLUSH_MS),
        );

        this.timers.push(
            setInterval(() => {
                if (this.clients.size > 0) this.sendAll('queue', downloader.state());
            }, SSE_QUEUE_MS),
        );

        this.timers.push(
            setInterval(() => {
                for (const res of this.clients) res.write(': hb\n\n');
            }, SSE_HEARTBEAT_MS),
        );
    }

    handle(req: Request, res: Response): void {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });
        // Снимок сразу при подключении.
        this.send(res, 'scan', this.scanner.progress());
        this.send(res, 'queue', this.downloader.state());
        this.clients.add(res);
        req.on('close', () => {
            this.clients.delete(res);
        });
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
    const { scanner, downloader } = deps;
    const router = Router();
    const hub = new SseHub(scanner, downloader);

    router.get('/health', (_req, res) => {
        res.json({ ok: true });
    });

    // Подключение к Twonky: парсинг URL + проверка доступности пробой на стартовый номер.
    router.post('/connect', (req, res) => {
        const status = scanner.progress().status;
        if (status === 'detecting' || status === 'scanning') {
            res.status(409).json({ ok: false, reason: 'Скан уже идёт — сначала остановите его' });
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
            scanner.setConnection(conn);
            res.json({ ok: true, connection: conn, exists: true });
        });
    });

    router.post('/scan/start', (_req, res) => {
        const conn = scanner.getConnection();
        if (conn === null) {
            res.status(409).json({ ok: false, reason: 'Сначала подключитесь к серверу' });
            return;
        }
        scanner.start(conn);
        const p = scanner.progress();
        res.json({ ok: true, status: p.status, reason: p.reason });
    });

    router.post('/scan/stop', (_req, res) => {
        scanner.stop();
        const p = scanner.progress();
        res.json({ ok: true, status: p.status, reason: p.reason });
    });

    router.get('/scan/status', (_req, res) => {
        res.json(scanner.progress());
    });

    // Список найденных файлов: пагинация, фильтр по типу, сортировка по номеру.
    router.get('/files', (req, res) => {
        const page = queryToInt(req.query.page, FILES_PAGE_DEFAULT);
        const size = queryToInt(req.query.size, FILES_PAGE_SIZE_DEFAULT);
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
        const clampedSize = Math.min(size, FILES_PAGE_SIZE_MAX);
        const all = scanner.foundList();
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

    // --- Очередь скачивания (план, п.8) ---

    /**
     * Отдать картинку по URL апстрима; false — ответ непригоден (не 200 / не image),
     * вызывающий решает: fallback на оригинал или 404. Сетевая ошибка — исключение.
     */
    const sendUpstreamImage = async (url: string, res: Response): Promise<boolean> => {
        const upstream = await nodeTransport.stream(url, { headers: {}, idleTimeoutMs: PROBE_TIMEOUT });
        const contentType = String(upstream.headers['content-type'] ?? '');
        if (upstream.status !== 200 || !contentType.startsWith('image/')) {
            upstream.stream.destroy();
            return false;
        }
        res.status(200);
        res.set('Content-Type', contentType);
        const length = upstream.headers['content-length'];
        if (length !== undefined) res.set('Content-Length', String(length));
        res.set('Cache-Control', `public, max-age=${THUMB_CACHE_MAX_AGE}`);
        // Обрыв клиента → уничтожаем запрос к апстриму (план, п.7).
        res.on('close', () => {
            upstream.stream.destroy();
        });
        upstream.stream.pipe(res);
        upstream.stream.resume();
        return true;
    };

    router.get('/thumb', (req, res) => {
        const n = Number.parseInt(String(queryToString(req.query.n) ?? ''), 10);
        if (!Number.isInteger(n) || n < 0) {
            res.status(400).json({ ok: false, reason: 'Параметр n обязателен (целое число)' });
            return;
        }
        const conn = scanner.getConnection();
        if (conn === null) {
            res.status(409).json({ ok: false, reason: 'Сначала подключитесь к серверу' });
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
        const clamp = (v: number): number => Math.min(THUMB_MAX, Math.max(THUMB_MIN, Math.round(v)));

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


    router.post('/queue', (req, res) => {
        const raw = req.body?.numbers;
        if (!Array.isArray(raw)) {
            res.status(400).json({ ok: false, reason: 'Ожидается массив numbers' });
            return;
        }
        const numbers = raw.filter((n): n is number => Number.isInteger(n));
        const added = downloader.add(numbers);
        res.json({ ok: true, added });
    });

    router.post('/queue/all', (_req, res) => {
        const added = downloader.addAll();
        res.json({ ok: true, added });
    });

    router.post('/queue/pause', (_req, res) => {
        downloader.pause();
        res.json({ ok: true });
    });

    router.post('/queue/resume', (_req, res) => {
        downloader.resume();
        res.json({ ok: true });
    });

    router.post('/queue/retry-failed', (_req, res) => {
        downloader.retryFailed();
        res.json({ ok: true });
    });

    router.post('/queue/clear-completed', (_req, res) => {
        downloader.clearCompleted();
        res.json({ ok: true });
    });

    router.delete('/queue/:number', (req, res) => {
        const number = Number.parseInt(String(req.params.number), 10);
        if (!Number.isFinite(number)) {
            res.status(400).json({ ok: false, reason: 'Некорректный номер файла' });
            return;
        }
        const result = downloader.remove(number);
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

    router.get('/queue', (req, res) => {
        const page = queryToInt(req.query.page, QUEUE_PAGE_DEFAULT);
        const size = queryToInt(req.query.size, QUEUE_PAGE_SIZE_DEFAULT);
        if (page === null || page < 1 || size === null || size < 1) {
            res.status(400).json({ ok: false, reason: 'Параметры page и size должны быть целыми не меньше 1' });
            return;
        }
        const clamped = Math.min(size, QUEUE_PAGE_SIZE_MAX);
        res.json({ ...downloader.state(), ...downloader.itemsPage(page, clamped) });
    });

    // --- Настройки и сброс состояния ---

    router.get('/settings', (_req, res) => {
        res.json(downloader.settings());
    });

    router.post('/settings', (req, res) => {
        downloader.applySettings(req.body ?? {});
        res.json(downloader.settings());
    });

    router.post('/state/reset', (req, res) => {
        const body = req.body ?? {};
        // Оба флага по умолчанию true; значения неверно типа трактуются как false.
        const scan = body.scan === undefined ? true : body.scan === true;
        const queue = body.queue === undefined ? true : body.queue === true;
        if (scan) scanner.reset();
        if (queue) downloader.resetQueue();
        res.json({ ok: true });
    });

    router.get('/events', (req, res) => {
        hub.handle(req, res);
    });

    return router;
}

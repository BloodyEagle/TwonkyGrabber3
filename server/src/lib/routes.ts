/**
 * REST + SSE маршруты API (план, п.8).
 * M2: /api/health, /api/connect, /api/scan/*, /api/events.
 * Очередь, файлы, настройки и сброс подключаются на следующих шагах (M3/M4).
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { SSE_FOUND_FLUSH_MS, SSE_HEARTBEAT_MS, SSE_SCAN_MS } from '../config';
import { checkAvailable } from './probe';
import { fileUrl, parseConnectionUrl } from './url-parser';
import type { Scanner } from './scanner';
import type { FoundFile } from './types';

export interface ApiDeps {
    scanner: Scanner;
}

/** SSE-хаб: scan ~каждые 500 мс, found — батчами, heartbeat, снимок при подключении. */
class SseHub {
    private readonly clients = new Set<Response>();
    private foundBuffer: FoundFile[] = [];
    private readonly timers: NodeJS.Timeout[] = [];

    constructor(private readonly scanner: Scanner) {
        scanner.setOnFound((files) => {
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
        // TODO(M4): снимок очереди после подключения загрузчика.
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

/** Создание Express-роутера со всеми API. */
export function createApiRouter(deps: ApiDeps): Router {
    const { scanner } = deps;
    const router = Router();
    const hub = new SseHub(scanner);

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

    router.get('/events', (req, res) => {
        hub.handle(req, res);
    });

    return router;
}

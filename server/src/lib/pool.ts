/**
 * Общий пул upstream-соединений (plan §Bugs, п.3).
 *
 * Без глобального потолка каждая сессия держит свой семафор PROBE_CONCURRENCY,
 * а transport открывает новое соединение на каждый запрос (без keep-alive и
 * лимита сокетов). При N сессиях это до PROBE_CONCURRENCY×N одновременных
 * upstream-сокетов — исчерпание файловых дескрипторов, лимита соединений
 * Twonky-сервера и забивание event loop (наш процесс перестаёт отвечать).
 *
 * Здесь — единый семафор проб для всех сессий и переиспользуемые HTTP-агенты
 * с ограничением сокетов (keep-alive).
 */
import http from 'node:http';
import https from 'node:https';
import { GLOBAL_PROBE_CONCURRENCY, HTTP_MAX_FREE_SOCKETS, HTTP_MAX_SOCKETS } from '../config';

/** Семафор с ограничением параллельности. */
export class Semaphore {
    private active = 0;
    private readonly queue: Array<() => void> = [];

    constructor(private readonly limit: number) {}

    async run<T>(task: () => Promise<T>): Promise<T> {
        if (this.active >= this.limit) {
            await new Promise<void>((resolve) => this.queue.push(resolve));
        }
        this.active += 1;
        try {
            return await task();
        } finally {
            this.active -= 1;
            const next = this.queue.shift();
            if (next !== undefined) next();
        }
    }
}

/** Единый семафор upstream-проб для всех сессий. */
export const probePool = new Semaphore(GLOBAL_PROBE_CONCURRENCY);

/** Переиспользуемые агенты с keep-alive и ограничением числа сокетов. */
export const httpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: HTTP_MAX_SOCKETS,
    maxFreeSockets: HTTP_MAX_FREE_SOCKETS,
});
export const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: HTTP_MAX_SOCKETS,
    maxFreeSockets: HTTP_MAX_FREE_SOCKETS,
});

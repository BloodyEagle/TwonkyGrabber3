/**
 * Низкоуровневый HTTP-транспорт на встроенных модулях Node.
 * Особенности (план, п.0):
 *  - просроченные TLS-сертификаты Twonky — норма → rejectUnauthorized: false;
 *  - никаких внешних HTTP-клиентов (axios и т.п.) — только node:http/node:https;
 *  - таймаут на весь запрос (установка соединения + ожидание ответа + чтение тела).
 *
 * Для юнит-тестов вводится интерфейс HttpTransport — реальная сеть в тестах запрещена.
 */
import http from 'node:http';
import https from 'node:https';
import type {IncomingHttpHeaders} from 'node:http';
import { httpAgent, httpsAgent } from './pool';

/** Ошибка транспорта: таймаут, обрыв, DNS — всё, что не является HTTP-ответом. */
export class NetworkError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'NetworkError';
    }
}

/** Метаданные ответа (тело не требуется). */
export interface HttpMetaResponse {
    status: number;
    headers: IncomingHttpHeaders;
}

export interface HttpMetaOptions {
    method: 'HEAD' | 'GET';
    headers?: Record<string, string>;
    timeoutMs: number;
}

/** Ответ со стримом тела (для скачивания файлов). */
export interface HttpStreamResponse {
    status: number;
    headers: IncomingHttpHeaders;
    /** Поток тела ответа; уничтожается destroy() при таймауте простоя. */
    stream: NodeJS.ReadableStream & { destroy(err?: Error | undefined): void };
}

export interface HttpStreamOptions {
    headers?: Record<string, string>;
    /** Таймаут простоя: сбрасывается на каждый чанк (большие файлы качаются часами). */
    idleTimeoutMs: number;
}

/** Транспорт мета-запросов (HEAD/GET без тела) — мокается в тестах probe. */
export interface HttpMetaTransport {
    meta(url: string, options: HttpMetaOptions): Promise<HttpMetaResponse>;
}

/** Транспорт стримингового GET — используется реальным загрузчиком. */
export interface HttpStreamTransport {
    stream(url: string, options: HttpStreamOptions): Promise<HttpStreamResponse>;
}

/** Полный транспорт: мета-запросы + стриминг тела. */
export interface HttpTransport extends HttpMetaTransport, HttpStreamTransport {}

/** Пауза, мс. Вынесена сюда: используется probe (ретраи) и сканер. */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Реализация транспорта на node:http/node:https.
 * Ответ полностью «поглощается» (res.resume) — метаданные возвращаются после end,
 * чтобы соединение гарантированно освободилось.
 */
export const nodeTransport: HttpTransport = {
    meta(url, options): Promise<HttpMetaResponse> {
        return new Promise<HttpMetaResponse>((resolve, reject) => {
            let parsed: URL;
            try {
                parsed = new URL(url);
            } catch {
                reject(new NetworkError(`Некорректный URL: ${url}`));
                return;
            }

            const isHttps = parsed.protocol === 'https:';
            const mod = isHttps ? https : http;

            const reqOptions: http.RequestOptions = {
                method: options.method,
                headers: options.headers,
            };
            // Игнорируем просроченные/самоподписанные сертификаты Twonky.
            if (isHttps) (reqOptions as https.RequestOptions).rejectUnauthorized = false;
            // Общий пул с ограничением сокетов (plan §Bugs, п.3).
            (reqOptions as http.RequestOptions).agent = isHttps ? httpsAgent : httpAgent;

            const fail = (err: unknown): void => {
                if (err instanceof NetworkError) reject(err);
                else if (err instanceof Error) reject(new NetworkError(err.message));
                else reject(new NetworkError(String(err)));
            };

            let settled = false;
            let timer: NodeJS.Timeout | undefined;

            const req = mod.request(parsed, reqOptions, (res) => {
                // Тело мета-запроса не нужно: сбрасываем и ждём завершения.
                res.resume();
                res.on('end', () => {
                    if (!settled) {
                        settled = true;
                        if (timer !== undefined) clearTimeout(timer);
                        resolve({status: res.statusCode ?? 0, headers: res.headers});
                    }
                });
                res.on('error', (err) => {
                    if (!settled) {
                        settled = true;
                        if (timer !== undefined) clearTimeout(timer);
                        fail(err);
                    }
                });
            });

            // Общий таймаут запроса: коннект + ожидание статуса + чтение тела.
            timer = setTimeout(() => {
                req.destroy(new NetworkError(`Таймаут запроса ${options.timeoutMs} мс: ${url}`));
            }, options.timeoutMs);

            req.on('error', (err) => {
                if (!settled) {
                    settled = true;
                    if (timer !== undefined) clearTimeout(timer);
                    // destroy по таймауту уже отдаёт NetworkError; прочее — оборачиваем.
                    fail(err);
                }
            });

            req.end();
        });
    },

    /**
     * Стриминговый GET: промис резолвится сразу по заголовкам ответа,
     * тело отдаётся потоком. Таймаут — на простой между чанками
     * (скачивание большого файла не ограничено по общему времени).
     */
    stream(url, options): Promise<HttpStreamResponse> {
        return new Promise<HttpStreamResponse>((resolve, reject) => {
            let parsed: URL;
            try {
                parsed = new URL(url);
            } catch {
                reject(new NetworkError(`Некорректный URL: ${url}`));
                return;
            }

            const isHttps = parsed.protocol === 'https:';
            const mod = isHttps ? https : http;

            const reqOptions: http.RequestOptions = {
                method: 'GET',
                headers: options.headers,
            };
            // Игнорируем просроченные/самоподписанные сертификаты Twonky.
            if (isHttps) (reqOptions as https.RequestOptions).rejectUnauthorized = false;
            // Общий пул с ограничением сокетов (plan §Bugs, п.3).
            (reqOptions as http.RequestOptions).agent = isHttps ? httpsAgent : httpAgent;

            const fail = (err: unknown): void => {
                if (err instanceof NetworkError) reject(err);
                else if (err instanceof Error) reject(new NetworkError(err.message));
                else reject(new NetworkError(String(err)));
            };

            let timer: NodeJS.Timeout | undefined;

            const armIdleTimer = (): void => {
                if (timer !== undefined) clearTimeout(timer);
                timer = setTimeout(() => {
                    req.destroy(new NetworkError(`Таймаут простоя ${options.idleTimeoutMs} мс: ${url}`));
                }, options.idleTimeoutMs);
            };

            const req = mod.request(parsed, reqOptions, (res) => {
                armIdleTimer();
                // Резолвим по заголовкам: статус решает, дописывать или начинать с нуля.
                // Важно: подписка на 'data' здесь включает flowing mode, поэтому сразу
                // ставим поток на паузу — потребитель обязан вызвать resume() после
                // подписки. Иначе тело ответа теряется до подключения слушателя.
                res.on('data', () => {
                    armIdleTimer();
                });
                res.pause();
                resolve({status: res.statusCode ?? 0, headers: res.headers, stream: res});
                res.on('end', () => {
                    if (timer !== undefined) clearTimeout(timer);
                });
                res.on('error', (err) => {
                    if (timer !== undefined) clearTimeout(timer);
                    fail(err);
                });
            });

            req.on('error', (err) => {
                if (timer !== undefined) clearTimeout(timer);
                fail(err);
            });

            req.end();
        });
    },
};

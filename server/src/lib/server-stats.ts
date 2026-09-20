/**
 * Статистика Twonky-сервера из /rpc/info_status (см. twmp_te.js):
 * текст вида "key|value", пары разделены табами/переводами строк/пробелами.
 * Интересуют точные счётчики pictures/videos — они позволяют остановить скан,
 * когда все файлы уже найдены.
 */
import { nodeTransport } from './http';
import { C } from '../config';
import type { TwonkyConnection } from './types';

/** Точные счётчики медиафайлов на сервере. */
export interface ServerStats {
    pictures: number;
    videos: number;
}

/** URL статистики: корень сервера (без basePath), путь /rpc/info_status. */
function statsUrl(connection: TwonkyConnection): string {
    return `${connection.protocol}://${connection.host}:${connection.port}/rpc/info_status`;
}

/** Парсинг ответа info_status; null — статистика недоступна/неполна. */
export function parseInfoStatus(text: string): ServerStats | null {
    const map = new Map<string, number>();
    for (const chunk of text.split(/[\t\n ]+/)) {
        const sep = chunk.indexOf('|');
        if (sep <= 0) continue;
        const key = chunk.slice(0, sep);
        const raw = chunk.slice(sep + 1);
        const value = Number.parseInt(raw, 10);
        if (!Number.isFinite(value)) continue;
        map.set(key, value);
    }
    const pictures = map.get('pictures');
    const videos = map.get('videos');
    if (pictures === undefined || videos === undefined) return null;
    if (pictures < 0 || videos < 0) return null;
    return { pictures, videos };
}

/**
 * Загрузка статистики сервера; null — endpoint недоступен (404 и т.п.) или сеть.
 * @param connection текущее подключение
 * @returns точные счётчики или null
 */
export async function fetchServerStats(connection: TwonkyConnection): Promise<ServerStats | null> {
    let text: string;
    try {
        const res = await nodeTransport.stream(statsUrl(connection), {
            headers: {},
            idleTimeoutMs: C.PROBE_TIMEOUT,
        });
        if (res.status !== 200) {
            res.stream.destroy();
            return null;
        }
        text = await new Promise<string>((resolve, reject) => {
            const chunks: Buffer[] = [];
            res.stream.on('data', (chunk: Buffer) => {
                chunks.push(chunk);
                res.stream.resume();
            });
            res.stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            res.stream.on('error', (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));
            res.stream.resume();
        });
    } catch {
        return null;
    }
    return parseInfoStatus(text);
}

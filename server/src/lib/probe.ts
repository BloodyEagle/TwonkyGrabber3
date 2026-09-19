/**
 * Проба существования файла (план, п.5.8):
 *  - HEAD → при 405/501 (старые прошивки) fallback: GET с Range: bytes=0-0;
 *  - существует + content-type image/* или video/* → файл найден;
 *  - 404 (и прочие 4xx) → «файла нет» (не ошибка);
 *  - 5xx и сетевые сбои → «неизвестно» (neterr) → ретраи, при серии — пауза сканера.
 *
 * Зависимость HttpTransport внедряется — в юнит-тестах сеть подменяется моком.
 */
import {PROBE_RETRIES, PROBE_RETRY_DELAYS_MS, PROBE_TIMEOUT} from '../config';
import type {FileKind} from './types';
import {NetworkError, nodeTransport, sleep} from './http';
import type {HttpMetaResponse, HttpMetaTransport} from './http';

/** Класс исхода пробы. */
export type ProbeKind = 'exists' | 'missing' | 'neterr';

export interface ProbeResult {
    kind: ProbeKind;
    /** Категория медиа (только для exists). */
    media: FileKind | null;
    contentType: string | null;
    /** Полный размер файла в байтах, если известен. */
    size: number | null;
    /** Технический комментарий (для логов и reason). */
    detail: string;
}

export interface ProbeDeps {
    transport: HttpMetaTransport;
    /** Подставляется в тестах, чтобы не ждать реальных задержек ретраев. */
    sleep?: (ms: number) => Promise<void>;
}

/** Определяет категорию медиа по content-type. */
export function mediaKindOf(contentType: string): FileKind | null {
    const ct = contentType.toLowerCase().split(';')[0]?.trim() ?? '';
    if (ct.startsWith('image/')) return 'image';
    if (ct.startsWith('video/')) return 'video';
    return null;
}

/** Первое значение заголовка (строкой) или null. */
function headerFirst(res: HttpMetaResponse, name: string): string | null {
    const value = res.headers[name];
    if (value === undefined) return null;
    if (Array.isArray(value)) return value[0] ?? null;
    return value;
}

/** Размер файла из Content-Range («bytes 0-0/12345») либо Content-Length. */
function sizeFromMeta(res: HttpMetaResponse): number | null {
    const range = headerFirst(res, 'content-range');
    if (range !== null) {
        const total = /\/(\d+)\s*$/.exec(range);
        if (total !== null) {
            const size = Number.parseInt(total[1] ?? '', 10);
            if (Number.isFinite(size)) return size;
        }
    }
    const length = headerFirst(res, 'content-length');
    if (length !== null) {
        const size = Number.parseInt(length, 10);
        if (Number.isFinite(size) && size >= 0) return size;
    }
    return null;
}

/** Классификация HTTP-ответа на «есть файл / нет файла / неизвестно». */
function classify(res: HttpMetaResponse, via: string): ProbeResult {
    const contentType = headerFirst(res, 'content-type');
    const size = sizeFromMeta(res);

    if (res.status >= 200 && res.status <= 299) {
        if (contentType === null) {
            return {kind: 'missing', media: null, contentType, size, detail: `${via}: ответ без content-type`};
        }
        const media = mediaKindOf(contentType);
        if (media === null) {
            // Файл есть, но это не изображение и не видео — считаем промахом (логируется сканером).
            return {kind: 'missing', media: null, contentType, size, detail: `${via}: не медиа (${contentType})`};
        }
        return {kind: 'exists', media, contentType, size, detail: `${via}: ок`};
    }

    if (res.status === 404 || res.status === 410) {
        return {kind: 'missing', media: null, contentType, size, detail: `${via}: файла нет`};
    }

    if (res.status >= 400 && res.status <= 499) {
        return {kind: 'missing', media: null, contentType, size, detail: `${via}: доступ запрещён`};
    }

    // 5xx и прочее — состояние «неизвестно».
    return {kind: 'neterr', media: null, contentType, size, detail: `${via}: ошибка сервера`};
}

/** Одна попытка: HEAD, при 405/501 — GET с Range: bytes=0-0. */
async function probeOnce(url: string, transport: HttpMetaTransport): Promise<ProbeResult> {
    try {
        const head = await transport.meta(url, {method: 'HEAD', timeoutMs: PROBE_TIMEOUT});
        if (head.status === 405 || head.status === 501) {
            // HEAD не поддерживается старыми прошивками.
            const get = await transport.meta(url, {
                method: 'GET',
                headers: {Range: 'bytes=0-0'},
                timeoutMs: PROBE_TIMEOUT,
            });
            return classify(get, `GET Range ${get.status}`);
        }
        return classify(head, `HEAD ${head.status}`);
    } catch (err) {
        const message = err instanceof NetworkError ? err.message : err instanceof Error ? err.message : String(err);
        return {kind: 'neterr', media: null, contentType: null, size: null, detail: `сеть: ${message}`};
    }
}

/**
 * Проба с ретраями: сетевые ошибки повторяются PROBE_RETRIES раз
 * с задержками PROBE_RETRY_DELAYS_MS (400/800 мс).
 */
export async function probeUrl(url: string, deps: ProbeDeps = {transport: nodeTransport}): Promise<ProbeResult> {
    const {transport} = deps;
    const doSleep = deps.sleep ?? sleep;

    let last: ProbeResult = {kind: 'neterr', media: null, contentType: null, size: null, detail: 'нет попыток'};
    for (let attempt = 0; attempt <= PROBE_RETRIES; attempt++) {
        if (attempt > 0) {
            // Индекс задержки с обрезкой по длине массива (защита от изменений конфига).
            const idx = Math.min(attempt - 1, PROBE_RETRY_DELAYS_MS.length - 1);
            const delay = PROBE_RETRY_DELAYS_MS[idx];
            if (delay !== undefined) await doSleep(delay);
        }
        last = await probeOnce(url, transport);
        if (last.kind !== 'neterr') return last;
    }
    return last;
}

/**
 * Проверка доступности сервера при подключении: любой HTTP-ответ (в т.ч. 404/405)
 * означает, что сервер жив. true — доступен, false — сетевая ошибка на всех методах.
 */
export async function checkAvailable(url: string, transport: HttpMetaTransport = nodeTransport): Promise<boolean> {
    try {
        await transport.meta(url, {method: 'HEAD', timeoutMs: PROBE_TIMEOUT});
        return true;
    } catch {
        // На старых прошивках HEAD может падать на сетевом уровне — пробуем GET с Range.
        try {
            await transport.meta(url, {
                method: 'GET',
                headers: {Range: 'bytes=0-0'},
                timeoutMs: PROBE_TIMEOUT,
            });
            return true;
        } catch {
            return false;
        }
    }
}

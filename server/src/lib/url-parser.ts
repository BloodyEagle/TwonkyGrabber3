/**
 * Парсинг URL подключения к Twonky (план, п.5.1) и построение URL файлов/превью.
 *
 * Правила:
 *  - протокол по умолчанию http (если «://» отсутствует — дописываем);
 *  - порт по умолчанию: 9000 для http, 443 для https;
 *  - путь по умолчанию /disk/ (нормализуется со «/» на конце);
 *  - префикс O0$2$20I парсится из последнего сегмента пути, если тот оканчивается цифрами;
 *  - номер — цифры в конце последнего сегмента, иначе START_NUMBER;
 *  - query (например ?scale=...) игнорируется.
 */
import {
    DEFAULT_BASE_PATH,
    DEFAULT_HTTPS_PORT,
    DEFAULT_HTTP_PORT,
    DEFAULT_PREFIX,
    DEFAULT_PROTOCOL,
    START_NUMBER,
} from '../config';
import type {Protocol, TwonkyConnection} from './types';

export type ParseResult =
    | { ok: true; connection: TwonkyConnection }
    | { ok: false; error: string };

/** Последний сегмент пути, если он оканчивается цифрами: [префикс, номер]. */
const TAIL_RE = /^([A-Za-z0-9_$~-]*?)(\d{1,9})$/;

/**
 * Разбирает пользовательский URL в TwonkyConnection.
 * Ошибки не бросает — возвращает { ok: false, error } с русским текстом.
 */
export function parseConnectionUrl(raw: string): ParseResult {
    const trimmed = raw.trim();
    if (trimmed === '') {
        return {ok: false, error: 'Пустой адрес сервера'};
    }

    // Частая опечатка «http:///host» легализуется URL-парсером (host съедается) — отсекаем явно.
    if (/^[a-z][a-z0-9+.-]*:\/{3,}/i.test(trimmed)) {
        return {ok: false, error: `Некорректный адрес: ${trimmed}`};
    }

    // Дописываем схему, если её нет (без «://» new URL примет «host:9000» за протокол).
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `${DEFAULT_PROTOCOL}://${trimmed}`;

    let url: URL;
    try {
        url = new URL(withScheme);
    } catch {
        return {ok: false, error: `Некорректный адрес: ${trimmed}`};
    }

    const protocol = url.protocol.replace(/:$/, '') as Protocol;
    if (protocol !== 'http' && protocol !== 'https') {
        return {ok: false, error: `Поддерживаются только http и https, получено: ${protocol}`};
    }

    const host = url.hostname;
    if (host === '') {
        return {ok: false, error: 'В адресе не указан хост сервера'};
    }

    let port: number;
    if (url.port === '') {
        port = protocol === 'https' ? DEFAULT_HTTPS_PORT : DEFAULT_HTTP_PORT;
    } else {
        port = Number.parseInt(url.port, 10);
        if (!Number.isFinite(port) || port <= 0 || port > 65535) {
            return {ok: false, error: `Некорректный порт: ${url.port}`};
        }
    }

    // Отделяем хвост (префикс + номер) от базового пути.
    const pathname = url.pathname;
    const lastSlash = pathname.lastIndexOf('/');
    const lastSeg = pathname.slice(lastSlash + 1);
    const tailMatch = TAIL_RE.exec(lastSeg);

    let basePath: string;
    let prefix: string;
    let startNumber: number;
    if (tailMatch !== null) {
        basePath = pathname.slice(0, pathname.length - lastSeg.length);
        const tailPrefix = tailMatch[1] ?? '';
        const tailDigits = tailMatch[2] ?? '';
        prefix = tailPrefix === '' ? DEFAULT_PREFIX : tailPrefix;
        startNumber = Number.parseInt(tailDigits, 10);
    } else {
        basePath = pathname;
        prefix = DEFAULT_PREFIX;
        startNumber = START_NUMBER;
    }

    if (!basePath.startsWith('/')) basePath = `/${basePath}`;
    if (!basePath.endsWith('/')) basePath += '/';
    // Пустой или корневой путь — берём путь Twonky по умолчанию (/disk/).
    if (basePath === '/') basePath = DEFAULT_BASE_PATH;

    // Порт опускаем, только если это стандартный для схемы (80/443); Twonky-дефолт 9000 всегда явный.
    const isDefaultPort =
        (protocol === 'http' && port === 80) || (protocol === 'https' && port === 443);
    const authority = isDefaultPort ? host : `${host}:${port}`;
    const baseUrl = `${protocol}://${authority}${basePath}${prefix}`;

    return {
        ok: true,
        connection: {
            raw: trimmed,
            protocol,
            host,
            port,
            basePath,
            prefix,
            startNumber,
            baseUrl,
        },
    };
}

/** URL файла по номеру: {baseUrl}{number}. */
export function fileUrl(connection: TwonkyConnection, number: number): string {
    return `${connection.baseUrl}${number}`;
}

/** URL превью: {fileUrl}?scale=WxH. */
export function thumbUrl(connection: TwonkyConnection, number: number, w: number, h: number): string {
    return `${fileUrl(connection, number)}?scale=${w}x${h}`;
}

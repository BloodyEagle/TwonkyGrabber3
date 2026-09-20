/**
 * Централизованная конфигурация сервера.
 * Все числовые параметры приложения — здесь (магические числа в коде запрещены).
 * Значения по умолчанию соответствуют плану (п.4); env: PORT, DOWNLOAD_DIR, STATE_FILE, STATIC_ROOT.
 *
 * Рантайм-значения хранятся в объекте C и редактируются через POST /api/config
 * (персистентно, в state.json); код читает только C.*, константы выше — дефолты.
 */

/** Читает числовой параметр из окружения, при ошибке/отсутствии возвращает значение по умолчанию. */
function envInt(name: string, def: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return def;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : def;
}

/** Читает строковый параметр из окружения, при отсутствии — значение по умолчанию. */
function envStr(name: string, def: string): string {
    const raw = process.env[name];
    return raw !== undefined && raw.trim() !== '' ? raw.trim() : def;
}

// --- Дефолты (план, п.4) ---

export const START_NUMBER = 5000;
export const DETECT_BLOCK = 256;
export const SEQ_THRESHOLD = 128;
export const STEP_DELTA = 256;
export const MISS_LIMIT = 500;
export const JUMP_POSITIONS = 1000;
export const JUMP_REPEATS = 5;
export const SPARSE_PROBES = 100;
export const SPARSE_MIN = 1000;
export const SPARSE_MAX = 10000;
/** Шаг между блоками поиска при нулевой разведке (256 = сплошное покрытие). */
export const SEARCH_STRIDE = 256;

/** Предел проб поиска на руку (страховка от бесконечного перебора «пустого» сервера). */
export const SEARCH_LIMIT_PROBES = 400_000;
export const DENSE_SWEEP_EVERY = 2000;
export const MAX_NUMBER = 10_000_000;
export const EPS_WINDOW_MS = 5000;
export const PROBE_CONCURRENCY = 16;
export const PROBE_BATCH = 16;
export const PROBE_TIMEOUT = 8000;
export const PROBE_RETRIES = 2;
export const PROBE_RETRY_DELAYS_MS: readonly number[] = [400, 800];
export const NETERR_PAUSE = 12;
export const DL_START_THREADS = 4;
export const DL_MAX_THREADS = 32;
export const DL_MIN_THREADS = 1;
export const DL_ADJUST_MS = 5000;
export const DL_SPEED_UP = 1_000_000;
export const DL_SPEED_DOWN = 150_000;
export const DL_FAILS_THRESHOLD = 2;
export const DL_RETRIES = 2;
export const DL_RETRY_DELAYS_MS: readonly number[] = [400, 800];
export const NAME_SUFFIX_LIMIT = 100;
export const THUMB_MIN = 16;
export const THUMB_MAX = 2000;
export const THUMB_CACHE_MAX_AGE = 86_400;
export const SAVE_EVERY_MS = 5000;

/** Задержка между ретраями записи state.json (Windows: EPERM на rename). */
export const SAVE_RETRY_DELAY_MS = 300;
export const SSE_SCAN_MS = 500;
export const SSE_FOUND_FLUSH_MS = 500;
export const SSE_QUEUE_MS = 1000;
export const SSE_HEARTBEAT_MS = 15_000;
export const FILES_PAGE_DEFAULT = 1;
export const FILES_PAGE_SIZE_DEFAULT = 60;
export const FILES_PAGE_SIZE_MAX = 200;
export const QUEUE_PAGE_DEFAULT = 1;
export const QUEUE_PAGE_SIZE_DEFAULT = 50;
export const QUEUE_PAGE_SIZE_MAX = 200;
export const DEFAULT_PROTOCOL = 'http';
export const DEFAULT_HTTP_PORT = 9000;
export const DEFAULT_HTTPS_PORT = 443;
export const DEFAULT_BASE_PATH = '/disk/';
export const DEFAULT_PREFIX = 'O0$2$20I';

// --- Окружение (только чтение; меняются через env и перезапуск) ---

export const PORT = envInt('PORT', 3000);
export const DOWNLOAD_DIR = envStr('DOWNLOAD_DIR', './downloads');
export const STATE_FILE = envStr('STATE_FILE', './data/state.json');
export const STATIC_ROOT = envStr('STATIC_ROOT', '../client/dist');

// --- Рантайм-конфигурация ---

export type ThumbSizesConfig = Readonly<Record<string, readonly [number, number]>>;

/** Все редактируемые настройки и их типы. */
export interface RuntimeConfig {
    START_NUMBER: number;
    DETECT_BLOCK: number;
    SEQ_THRESHOLD: number;
    STEP_DELTA: number;
    MISS_LIMIT: number;
    JUMP_POSITIONS: number;
    JUMP_REPEATS: number;
    SPARSE_PROBES: number;
    SPARSE_MIN: number;
    SPARSE_MAX: number;
    SEARCH_STRIDE: number;
    SEARCH_LIMIT_PROBES: number;
    DENSE_SWEEP_EVERY: number;
    MAX_NUMBER: number;
    EPS_WINDOW_MS: number;
    PROBE_CONCURRENCY: number;
    PROBE_BATCH: number;
    PROBE_TIMEOUT: number;
    PROBE_RETRIES: number;
    PROBE_RETRY_DELAYS_MS: number[];
    NETERR_PAUSE: number;
    DL_START_THREADS: number;
    DL_MAX_THREADS: number;
    DL_MIN_THREADS: number;
    DL_ADJUST_MS: number;
    DL_SPEED_UP: number;
    DL_SPEED_DOWN: number;
    DL_FAILS_THRESHOLD: number;
    DL_RETRIES: number;
    DL_RETRY_DELAYS_MS: number[];
    NAME_SUFFIX_LIMIT: number;
    THUMB_SIZES: Record<string, [number, number]>;
    THUMB_MIN: number;
    THUMB_MAX: number;
    THUMB_CACHE_MAX_AGE: number;
    SAVE_EVERY_MS: number;
    SSE_SCAN_MS: number;
    SSE_FOUND_FLUSH_MS: number;
    SSE_QUEUE_MS: number;
    SSE_HEARTBEAT_MS: number;
    FILES_PAGE_DEFAULT: number;
    FILES_PAGE_SIZE_DEFAULT: number;
    FILES_PAGE_SIZE_MAX: number;
    QUEUE_PAGE_DEFAULT: number;
    QUEUE_PAGE_SIZE_DEFAULT: number;
    QUEUE_PAGE_SIZE_MAX: number;
    DEFAULT_PROTOCOL: string;
    DEFAULT_HTTP_PORT: number;
    DEFAULT_HTTPS_PORT: number;
    DEFAULT_BASE_PATH: string;
    DEFAULT_PREFIX: string;
}

export const DEFAULT_CONFIG: RuntimeConfig = {
    START_NUMBER,
    DETECT_BLOCK,
    SEQ_THRESHOLD,
    STEP_DELTA,
    MISS_LIMIT,
    JUMP_POSITIONS,
    JUMP_REPEATS,
    SPARSE_PROBES,
    SPARSE_MIN,
    SPARSE_MAX,
    SEARCH_STRIDE,
    SEARCH_LIMIT_PROBES,
    DENSE_SWEEP_EVERY,
    MAX_NUMBER,
    EPS_WINDOW_MS,
    PROBE_CONCURRENCY,
    PROBE_BATCH,
    PROBE_TIMEOUT,
    PROBE_RETRIES,
    PROBE_RETRY_DELAYS_MS: [...PROBE_RETRY_DELAYS_MS],
    NETERR_PAUSE,
    DL_START_THREADS,
    DL_MAX_THREADS,
    DL_MIN_THREADS,
    DL_ADJUST_MS,
    DL_SPEED_UP,
    DL_SPEED_DOWN,
    DL_FAILS_THRESHOLD,
    DL_RETRIES,
    DL_RETRY_DELAYS_MS: [...DL_RETRY_DELAYS_MS],
    NAME_SUFFIX_LIMIT,
    THUMB_SIZES: { S: [100, 80], M: [200, 160], L: [400, 320], XL: [800, 640] },
    THUMB_MIN,
    THUMB_MAX,
    THUMB_CACHE_MAX_AGE,
    SAVE_EVERY_MS,
    SSE_SCAN_MS,
    SSE_FOUND_FLUSH_MS,
    SSE_QUEUE_MS,
    SSE_HEARTBEAT_MS,
    FILES_PAGE_DEFAULT,
    FILES_PAGE_SIZE_DEFAULT,
    FILES_PAGE_SIZE_MAX,
    QUEUE_PAGE_DEFAULT,
    QUEUE_PAGE_SIZE_DEFAULT,
    QUEUE_PAGE_SIZE_MAX,
    DEFAULT_PROTOCOL,
    DEFAULT_HTTP_PORT,
    DEFAULT_HTTPS_PORT,
    DEFAULT_BASE_PATH,
    DEFAULT_PREFIX,
};

/** Текущие рантайм-значения. Потребители читают только это. */
export const C: RuntimeConfig = structuredClone(DEFAULT_CONFIG);

const NUMBER_KEYS: readonly (keyof RuntimeConfig)[] = [
    'START_NUMBER', 'DETECT_BLOCK', 'SEQ_THRESHOLD', 'STEP_DELTA', 'MISS_LIMIT',
    'JUMP_POSITIONS', 'JUMP_REPEATS',     'SPARSE_PROBES', 'SPARSE_MIN', 'SPARSE_MAX', 'SEARCH_STRIDE', 'SEARCH_LIMIT_PROBES',
    'DENSE_SWEEP_EVERY', 'MAX_NUMBER', 'EPS_WINDOW_MS', 'PROBE_CONCURRENCY', 'PROBE_BATCH',
    'PROBE_TIMEOUT', 'PROBE_RETRIES', 'NETERR_PAUSE', 'DL_START_THREADS', 'DL_MAX_THREADS',
    'DL_MIN_THREADS', 'DL_ADJUST_MS', 'DL_SPEED_UP', 'DL_SPEED_DOWN', 'DL_FAILS_THRESHOLD',
    'DL_RETRIES', 'NAME_SUFFIX_LIMIT', 'THUMB_MIN', 'THUMB_MAX', 'THUMB_CACHE_MAX_AGE',
    'SAVE_EVERY_MS', 'SSE_SCAN_MS', 'SSE_FOUND_FLUSH_MS', 'SSE_QUEUE_MS', 'SSE_HEARTBEAT_MS',
    'FILES_PAGE_DEFAULT', 'FILES_PAGE_SIZE_DEFAULT', 'FILES_PAGE_SIZE_MAX',
    'QUEUE_PAGE_DEFAULT', 'QUEUE_PAGE_SIZE_DEFAULT', 'QUEUE_PAGE_SIZE_MAX',
    'DEFAULT_HTTP_PORT', 'DEFAULT_HTTPS_PORT',
];

const ARRAY_KEYS: readonly (keyof RuntimeConfig)[] = ['PROBE_RETRY_DELAYS_MS', 'DL_RETRY_DELAYS_MS'];
const STRING_KEYS: readonly (keyof RuntimeConfig)[] = ['DEFAULT_PROTOCOL', 'DEFAULT_BASE_PATH', 'DEFAULT_PREFIX'];

/** Полный снимок конфигурации: текущие значения, дефолты и read-only env. */
export function configSnapshot(): {
    values: RuntimeConfig;
    defaults: RuntimeConfig;
    env: { PORT: number; DOWNLOAD_DIR: string; STATE_FILE: string; STATIC_ROOT: string };
} {
    return {
        values: structuredClone(C),
        defaults: structuredClone(DEFAULT_CONFIG),
        env: { PORT, DOWNLOAD_DIR, STATE_FILE, STATIC_ROOT },
    };
}

/**
 * Применяет патч конфигурации; возвращает список ошибок (пустой = успех).
 * @param patch объект вида { ИМЯ_ПАРАМЕТРА: значение }
 * @returns ошибки валидации по каждому некорректному полю
 */
export function applyConfigPatch(patch: Record<string, unknown>): string[] {
    const errors: string[] = [];
    for (const [key, raw] of Object.entries(patch)) {
        const k = key as keyof RuntimeConfig;
        if (NUMBER_KEYS.includes(k)) {
            const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw;
            if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
                errors.push(`${key}: ожидается целое число ≥ 0`);
                continue;
            }
            C[k] = n as never;
        } else if (ARRAY_KEYS.includes(k)) {
            const arr = Array.isArray(raw)
                ? raw
                : typeof raw === 'string'
                  ? raw.split(',').map((s) => Number.parseInt(s.trim(), 10))
                  : null;
            if (
                arr === null ||
                arr.length === 0 ||
                arr.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0)
            ) {
                errors.push(`${key}: ожидается список чисел через запятую (например, 400,800)`);
                continue;
            }
            C[k] = arr as never;
        } else if (STRING_KEYS.includes(k)) {
            if (typeof raw !== 'string' || raw.trim() === '') {
                errors.push(`${key}: ожидается непустая строка`);
                continue;
            }
            C[k] = raw.trim() as never;
        } else if (k === 'THUMB_SIZES') {
            const res = parseThumbSizes(raw);
            if (res === null) {
                errors.push('THUMB_SIZES: ожидается {S:[w,h], M:[w,h], L:[w,h], XL:[w,h]}');
                continue;
            }
            C.THUMB_SIZES = res;
        } else {
            errors.push(`${key}: неизвестный параметр`);
        }
    }
    return errors;
}

/** Парсинг размеров превью с клампом по THUMB_MIN..THUMB_MAX. */
function parseThumbSizes(raw: unknown): Record<string, [number, number]> | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const out: Record<string, [number, number]> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!Array.isArray(value) || value.length !== 2) return null;
        const w = value[0];
        const h = value[1];
        if (typeof w !== 'number' || typeof h !== 'number' || !Number.isFinite(w) || !Number.isFinite(h)) return null;
        const clamp = (v: number): number =>
            Math.min(THUMB_MAX, Math.max(THUMB_MIN, Math.round(v)));
        out[key] = [clamp(w), clamp(h)];
    }
    return Object.keys(out).length > 0 ? out : null;
}

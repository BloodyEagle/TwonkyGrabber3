/**
 * Централизованная конфигурация сервера.
 * Все числовые параметры приложения — здесь (магические числа в коде запрещены).
 * Значения соответствуют плану (п.4); env-переопределения: PORT, DOWNLOAD_DIR, STATE_FILE.
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

// --- Сканер: нумерация и режимы ---

/** Стартовый номер скана (переопределяется номером из URL подключения). */
export const START_NUMBER = 5000;

/** Размер блока разведки: probe на start..start+DETECT_BLOCK-1. */
export const DETECT_BLOCK = 256;

/** Порог режима seq: найдено ≥ N из блока разведки → нумерация с шагом 1. */
export const SEQ_THRESHOLD = 128;

/** Шаг нумерации в delta-режиме (зависит от прошивки Twonky). */
export const STEP_DELTA = 256;

/** Промахов подряд на текущем шаге → прыжок/переход к разреженному поиску. */
export const MISS_LIMIT = 500;

/** Величина прыжка в пробах: JUMP_POSITIONS × step номеров. */
export const JUMP_POSITIONS = 1000;

/** Циклов «прыжок → проверка» до перехода к разреженному поиску. */
export const JUMP_REPEATS = 5;

/** Количество проб разреженного (sparse) поиска. */
export const SPARSE_PROBES = 100;

/** Диапазон шага разреженного поиска (номеров; в delta — округлять кратно 256). */
export const SPARSE_MIN = 1000;
export const SPARSE_MAX = 10000;

/** Каждые N находок руки — плотный проход (sweep) 256 номеров с шагом 1. */
export const DENSE_SWEEP_EVERY = 2000;

/** Страховочный потолок номера файла. */
export const MAX_NUMBER = 10_000_000;

// --- Сканер: скорость проб ---

/** Окно расчёта скорости проб (eps), мс. */
export const EPS_WINDOW_MS = 5000;

// --- Сканер: пробы и сеть ---

/** Параллельность проб (общий семафор всех рук). */
export const PROBE_CONCURRENCY = 16;

/** Размер батча позиций, который планирует рука за один заход. */
export const PROBE_BATCH = 16;

/** Таймаут одной пробы, мс. */
export const PROBE_TIMEOUT = 8000;

/** Ретраи пробы — только на сетевые ошибки (таймаут/обрыв). */
export const PROBE_RETRIES = 2;

/** Задержки перед ретраями пробы, мс (по одной на каждый ретрай). */
export const PROBE_RETRY_DELAYS_MS: readonly number[] = [400, 800];

/** Сетевых ошибок подряд на уровне сканера → пауза с reason (резюм вручную). */
export const NETERR_PAUSE = 12;

// --- Загрузчик ---

/** Начальное число потоков скачивания. */
export const DL_START_THREADS = 4;

/** Максимальное число потоков скачивания. */
export const DL_MAX_THREADS = 32;

/** Минимальное число потоков скачивания. */
export const DL_MIN_THREADS = 1;

/** Интервал подстройки числа потоков, мс. */
export const DL_ADJUST_MS = 5000;

/** Порог скорости на поток для роста потоков, байт/с. */
export const DL_SPEED_UP = 1_000_000;

/** Порог скорости на поток для снижения потоков, байт/с. */
export const DL_SPEED_DOWN = 150_000;

/** Ретраи скачивания файла. */
export const DL_RETRIES = 2;

/** Предел суффиксов `_1.._N` при коллизии имён файлов. */
export const NAME_SUFFIX_LIMIT = 100;

// --- Превью-прокси ---

/** Доступные размеры превью S/M/L/XL (запрашиваются как ?scale=WxH). */
export const THUMB_SIZES: Readonly<Record<string, readonly [number, number]>> = {
    S: [100, 80],
    M: [200, 160],
    L: [400, 320],
    XL: [800, 640],
};

/** Кламп ширины/высоты превью. */
export const THUMB_MIN = 16;
export const THUMB_MAX = 2000;

/** Срок кэша браузера для превью, с (URL различаются по w/h — кэш корректен). */
export const THUMB_CACHE_MAX_AGE = 86_400;

// --- Персистентность ---

/** Интервал записи state.json, мс. */
export const SAVE_EVERY_MS = 5000;

// --- SSE ---

/** Интервал рассылки события `scan`, мс. */
export const SSE_SCAN_MS = 500;

/** Интервал флеша батча события `found`, мс. */
export const SSE_FOUND_FLUSH_MS = 500;

/** Интервал рассылки события `queue`, мс. */
export const SSE_QUEUE_MS = 1000;

/** Интервал heartbeat-комментария SSE, мс. */
export const SSE_HEARTBEAT_MS = 15_000;

// --- Галерея (/api/files) ---

/** Страница списка файлов по умолчанию. */
export const FILES_PAGE_DEFAULT = 1;

/** Размер страницы списка файлов по умолчанию (совпадает с дефолтом фронта). */
export const FILES_PAGE_SIZE_DEFAULT = 60;

/** Верхний предел размера страницы списка файлов. */
// TODO(уточнить): предохранитель от гигантских выборок; планом не задан.
export const FILES_PAGE_SIZE_MAX = 200;

// --- Парсинг URL подключения (дефолты) ---

/** Протокол по умолчанию, если не указан в URL. */
export const DEFAULT_PROTOCOL = 'http';

/** Порт по умолчанию для http. */
export const DEFAULT_HTTP_PORT = 9000;

/** Порт по умолчанию для https. */
export const DEFAULT_HTTPS_PORT = 443;

/** Базовый путь по умолчанию. */
export const DEFAULT_BASE_PATH = '/disk/';

/** Префикс имени файла по умолчанию (парсится из хвоста, если указан). */
export const DEFAULT_PREFIX = 'O0$2$20I';

// --- Окружение ---

/** Порт HTTP-сервера (env PORT). */
export const PORT = envInt('PORT', 3000);

/** Каталог для скачиваемых файлов (env DOWNLOAD_DIR). */
export const DOWNLOAD_DIR = envStr('DOWNLOAD_DIR', './downloads');

/** Файл персистентного состояния (env STATE_FILE). */
export const STATE_FILE = envStr('STATE_FILE', './data/state.json');

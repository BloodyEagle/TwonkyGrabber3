/** Описание параметров сервера для страницы настроек: группы, подписи, подсказки. */

export interface ConfigParam {
    key: string;
    label: string;
    hint?: string;
}

export interface ConfigGroup {
    title: string;
    params: ConfigParam[];
}

/** Значения применяются после перезапуска (таймеры создаются на старте). */
export const RESTART_HINT = 'применяется после перезапуска сервера';

export const CONFIG_GROUPS: readonly ConfigGroup[] = [
    {
        title: 'Сканер',
        params: [
            { key: 'START_NUMBER', label: 'Стартовый номер' },
            { key: 'DETECT_BLOCK', label: 'Блок разведки' },
            { key: 'SEQ_THRESHOLD', label: 'Порог режима seq' },
            { key: 'STEP_DELTA', label: 'Шаг delta-режима' },
            { key: 'MISS_LIMIT', label: 'Промахов до прыжка' },
            { key: 'JUMP_POSITIONS', label: 'Величина прыжка (× шаг)' },
            { key: 'JUMP_REPEATS', label: 'Циклов прыжков' },
            { key: 'SPARSE_PROBES', label: 'Проб разреженного поиска' },
            { key: 'SPARSE_MIN', label: 'Мин. шаг sparse' },
            { key: 'SPARSE_MAX', label: 'Макс. шаг sparse' },
            { key: 'SEARCH_STRIDE', label: 'Шаг блоков поиска', hint: '256 = сплошное покрытие; при 0 найдено в разведке' },
            { key: 'SEARCH_LIMIT_PROBES', label: 'Предел проб поиска', hint: 'на руку; страховка на «пустых» серверах' },
            { key: 'DENSE_SWEEP_EVERY', label: 'Плотный проход каждые N находок' },
            { key: 'MAX_NUMBER', label: 'Потолок номера' },
            { key: 'EPS_WINDOW_MS', label: 'Окно расчёта eps, мс' },
        ],
    },
    {
        title: 'Пробы и сеть',
        params: [
            { key: 'PROBE_CONCURRENCY', label: 'Параллельность проб' },
            { key: 'PROBE_BATCH', label: 'Размер батча' },
            { key: 'PROBE_TIMEOUT', label: 'Таймаут пробы, мс' },
            { key: 'PROBE_RETRIES', label: 'Ретраи пробы' },
            { key: 'PROBE_RETRY_DELAYS_MS', label: 'Задержки ретраев, мс', hint: 'через запятую, например 400,800' },
            { key: 'NETERR_PAUSE', label: 'Сетевых ошибок до паузы' },
        ],
    },
    {
        title: 'Загрузчик',
        params: [
            { key: 'DL_START_THREADS', label: 'Стартовых потоков' },
            { key: 'DL_MAX_THREADS', label: 'Макс. потоков' },
            { key: 'DL_MIN_THREADS', label: 'Мин. потоков' },
            { key: 'DL_ADJUST_MS', label: 'Интервал подстройки, мс' },
            { key: 'DL_SPEED_UP', label: 'Порог роста, байт/с' },
            { key: 'DL_SPEED_DOWN', label: 'Порог снижения, байт/с' },
            { key: 'DL_FAILS_THRESHOLD', label: 'Отказов до снижения' },
            { key: 'DL_RETRIES', label: 'Ретраи скачивания' },
            { key: 'DL_RETRY_DELAYS_MS', label: 'Задержки ретраев, мс', hint: 'через запятую, например 400,800' },
            { key: 'NAME_SUFFIX_LIMIT', label: 'Предел суффиксов _N' },
        ],
    },
    {
        title: 'Превью',
        params: [
            { key: 'THUMB_MIN', label: 'Мин. размер, px' },
            { key: 'THUMB_MAX', label: 'Макс. размер, px' },
            { key: 'THUMB_CACHE_MAX_AGE', label: 'Кэш браузера, с' },
        ],
    },
    {
        title: 'Персистентность и SSE',
        params: [
            { key: 'SAVE_EVERY_MS', label: 'Интервал записи state.json, мс', hint: RESTART_HINT },
            { key: 'SSE_SCAN_MS', label: 'Интервал события scan, мс', hint: RESTART_HINT },
            { key: 'SSE_FOUND_FLUSH_MS', label: 'Флеш found, мс', hint: RESTART_HINT },
            { key: 'SSE_QUEUE_MS', label: 'Интервал события queue, мс', hint: RESTART_HINT },
            { key: 'SSE_HEARTBEAT_MS', label: 'Heartbeat, мс', hint: RESTART_HINT },
        ],
    },
    {
        title: 'Пагинация',
        params: [
            { key: 'FILES_PAGE_DEFAULT', label: 'Страница файлов' },
            { key: 'FILES_PAGE_SIZE_DEFAULT', label: 'Размер страницы файлов' },
            { key: 'FILES_PAGE_SIZE_MAX', label: 'Макс. страница файлов' },
            { key: 'QUEUE_PAGE_DEFAULT', label: 'Страница очереди' },
            { key: 'QUEUE_PAGE_SIZE_DEFAULT', label: 'Размер страницы очереди' },
            { key: 'QUEUE_PAGE_SIZE_MAX', label: 'Макс. страница очереди' },
        ],
    },
    {
        title: 'URL подключения (дефолты)',
        params: [
            { key: 'DEFAULT_PROTOCOL', label: 'Протокол' },
            { key: 'DEFAULT_HTTP_PORT', label: 'Порт http' },
            { key: 'DEFAULT_HTTPS_PORT', label: 'Порт https' },
            { key: 'DEFAULT_BASE_PATH', label: 'Базовый путь' },
            { key: 'DEFAULT_PREFIX', label: 'Префикс имени' },
        ],
    },
];

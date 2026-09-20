/**
 * Публичные типы приложения (план, п.3 «Контракты данных»).
 * Только типы — никакой логики.
 */

// --- Подключение ---

export type Protocol = 'http' | 'https';

/** Разобранный URL подключения к Twonky-серверу. */
export interface TwonkyConnection {
    /** Исходный URL, введённый пользователем. */
    raw: string;
    protocol: Protocol;
    host: string;
    port: number;
    /** Базовый путь до файлов, всегда со «/» на конце (по умолчанию /disk/). */
    basePath: string;
    /** Префикс имени файла (по умолчанию O0$2$20I). */
    prefix: string;
    /** Стартовый номер (из хвоста URL, иначе START_NUMBER). */
    startNumber: number;
    /** Полный префикс URL файла: protocol://host:port + basePath + prefix (без номера). */
    baseUrl: string;
}

// --- Найденные файлы ---

export type FileKind = 'image' | 'video';

export interface FoundFile {
    number: number;
    url: string;
    /** Хвост URL (префикс + номер) — база имени файла на диске. */
    tail: string;
    contentType: string;
    kind: FileKind;
    /** Размер в байтах (по данным HEAD). */
    size: number;
    /** Имя файла (tail + расширение из content-type). */
    name: string;
    /** Время находки, epoch ms. */
    addedAt: number;
}

// --- Очередь скачивания ---

export type QueueStatus = 'pending' | 'active' | 'done' | 'skipped' | 'failed';

export interface QueueItem {
    number: number;
    url: string;
    /** Имя, под которым файл планируется сохранить (может уточняться при коллизиях). */
    name: string;
    /** Базовое имя без суффикса _N. */
    baseName: string;
    contentType: string;
    size: number;
    status: QueueStatus;
    /** Скачано байт (для активных/завершённых). */
    downloaded: number;
    error: string | null;
    /** Примечание (например, «уже скачан»). */
    note: string | null;
    /** Фактически сохранённое имя (с суффиксом при коллизии). */
    savedAs: string | null;
    addedAt: number;
}

/** Представление элемента очереди для фронтенда. */
export interface QueueItemView {
    number: number;
    name: string;
    baseName: string;
    contentType: string;
    size: number;
    status: QueueStatus;
    downloaded: number;
    error: string | null;
    note: string | null;
    savedAs: string | null;
    addedAt: number;
}

// --- Сканер: руки ---

export type ArmDir = 1 | -1;
export type ArmPhase = 'scan' | 'gapfill' | 'sparse';
export type ArmState = 'run' | 'stopped';

/** Внутреннее (и персистентное) состояние руки сканера. */
export interface Arm {
    dir: ArmDir;
    pos: number;
    /** Текущий шаг нумерации: 1 (seq) или 256 (delta). */
    step: number;
    phase: ArmPhase;
    state: ArmState;
    missStreak: number;
    jumpsDone: number;
    hadJump: boolean;
    foundCount: number;
    foundSinceSweep: number;
    /** Очередь номеров плотного прохода (sweep). */
    sweepQueue: number[];
    gapPos: number;
    gapMiss: number;
    /** Позиция, на которую вернуться после gapfill. */
    resumePos: number;
    /** Осталось проб в фазе sparse. */
    sparseLeft: number;
}

/** Представление руки для фронтенда (в ScanProgress). */
export interface ArmView {
    dir: ArmDir;
    pos: number;
    phase: ArmPhase;
    state: ArmState;
}

// --- Сканер: прогресс ---

export type ScanStatus = 'idle' | 'detecting' | 'scanning' | 'paused' | 'done' | 'error';
export type ScanMode = 'seq' | 'delta' | null;

export interface ScanProgress {
    status: ScanStatus;
    reason: string | null;
    mode: ScanMode;
    probed: number;
    found: number;
    /** Скорость проб, проб/с (eps). */
    eps: number;
    arms: ArmView[];
    /** Точные счётчики сервера из /rpc/info_status (null — статистика недоступна). */
    stats: { pictures: number; videos: number } | null;
}

// --- Очередь: агрегаты ---

export type ThreadsMode = 'auto' | 'manual';

export interface ThreadsInfo {
    live: number;
    target: number;
    mode: ThreadsMode;
    manual: number;
}

export interface QueueCounts {
    pending: number;
    active: number;
    done: number;
    skipped: number;
    failed: number;
}

export interface QueueState {
    counts: QueueCounts;
    active: QueueItemView[];
    threads: ThreadsInfo;
    /** Суммарная скорость скачивания, байт/с. */
    speed: number;
    paused: boolean;
    autoAll: boolean;
    total: number;
}

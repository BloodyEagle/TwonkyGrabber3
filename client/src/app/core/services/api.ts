/** Контракты сервера (план, §3/§8) — только типы, без логики. */
import { Injectable } from '@angular/core';

export interface TwonkyConnection {
    raw: string;
    protocol: string;
    host: string;
    port: number;
    basePath: string;
    prefix: string;
    startNumber: number;
    baseUrl: string;
}

export type MediaKind = 'image' | 'video';

export interface FoundFile {
    number: number;
    url: string;
    tail: string;
    contentType: string;
    kind: MediaKind;
    size: number;
    name: string;
    addedAt: number;
}

export interface ArmView {
    dir: 1 | -1;
    pos: number;
    step: number;
    phase: string;
    state: string;
    foundCount: number;
}

export type ScanStatus = 'idle' | 'detecting' | 'scanning' | 'paused' | 'done' | 'error';

export interface ScanProgress {
    status: ScanStatus;
    reason: string | null;
    mode: 'seq' | 'delta' | null;
    /** Текущее подключение (null — ещё не подключено); восстанавливается после рестарта. */
    connection: TwonkyConnection | null;
    probed: number;
    found: number;
    foundImages: number;
    foundVideos: number;
    eps: number;
    arms: ArmView[];
    /** Точные счётчики сервера из /rpc/info_status (null — недоступна). */
    stats: { pictures: number; videos: number } | null;
    /** Эпоха библиотеки: меняется при сбросе скана (инвалидация кэша превью). */
    epoch: number;
}

export type QueueStatus = 'pending' | 'active' | 'done' | 'skipped' | 'failed';

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

export interface ThreadsInfo {
    live: number;
    target: number;
    mode: 'auto' | 'manual';
    manual: number;
}

export interface QueueState {
    counts: { pending: number; active: number; done: number; skipped: number; failed: number };
    active: QueueItemView[];
    threads: ThreadsInfo;
    speed: number;
    paused: boolean;
    autoAll: boolean;
    total: number;
}

export interface FilesPage {
    total: number;
    page: number;
    size: number;
    items: FoundFile[];
}

export interface QueuePage {
    total: number;
    page: number;
    size: number;
    items: QueueItemView[];
}

export interface Settings {
    threadsMode: 'auto' | 'manual';
    threadsValue: number;
    autoAll: boolean;
    downloadDir: string;
}

/** Вкладка сервера: снимок сессии из GET/POST /api/sessions. */
export interface SessionSummary {
    id: string;
    /** Подкаталог загрузок внутри DOWNLOAD_DIR. */
    dir: string;
    connection: TwonkyConnection | null;
    scan: ScanProgress;
    queue: { counts: QueueState['counts']; paused: boolean; autoAll: boolean };
}

/** Рантайм-конфигурация сервера (зеркало RuntimeConfig из server/src/config.ts). */
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

export interface ConfigSnapshot {
    values: RuntimeConfig;
    defaults: RuntimeConfig;
    env: { PORT: number; DOWNLOAD_DIR: string; STATE_FILE: string; STATIC_ROOT: string };
}

interface ApiError {
    ok: false;
    reason: string;
}

/** REST-клиент /api (план, §8). Все запросы браузера идут только сюда.
 *  Операции с сервером Twonky скоупятся сессией (sid — идентификатор вкладки). */
@Injectable({ providedIn: 'root' })
export class ApiService {
    /** URL превью через прокси; epoch — версия библиотеки против кэша браузера. */
    thumbUrl(sid: string, number: number, w: number, h: number, epoch: number): string {
        return `/api/sessions/${sid}/thumb?n=${number}&w=${w}&h=${h}&v=${epoch}`;
    }

    /** URL оригинала (открытие полного изображения). */
    originalUrl(sid: string, number: number, epoch: number): string {
        return `/api/sessions/${sid}/thumb?n=${number}&orig=1&v=${epoch}`;
    }

    // --- сессии ---

    async sessions(): Promise<{ items: SessionSummary[] }> {
        return this.request<{ items: SessionSummary[] }>('/api/sessions');
    }

    /** Новая вкладка сервера: подключение + проверка доступности. */
    async createSession(url: string): Promise<SessionSummary> {
        const r = await this.request<{ ok: true; session: SessionSummary }>('/api/sessions', {
            method: 'POST',
            body: { url },
        });
        return r.session;
    }

    async deleteSession(id: string): Promise<void> {
        await this.request(`/api/sessions/${id}`, { method: 'DELETE' });
    }

    // --- скан ---

    async scanStart(sid: string): Promise<ScanProgress> {
        return this.request<ScanProgress>(`/api/sessions/${sid}/scan/start`, { method: 'POST' });
    }

    async scanStop(sid: string): Promise<ScanProgress> {
        return this.request<ScanProgress>(`/api/sessions/${sid}/scan/stop`, { method: 'POST' });
    }

    async scanStatus(sid: string): Promise<ScanProgress> {
        return this.request<ScanProgress>(`/api/sessions/${sid}/scan/status`);
    }

    // --- находки ---

    async files(sid: string, page: number, size: number, sort: 'asc' | 'desc', type: 'all' | 'image' | 'video'): Promise<FilesPage> {
        const qs = `page=${page}&size=${size}&sort=${sort}&type=${type}`;
        return this.request<FilesPage>(`/api/sessions/${sid}/files?${qs}`);
    }

    // --- очередь ---

    async queueAdd(sid: string, numbers: number[]): Promise<number> {
        const r = await this.request<{ added: number }>(`/api/sessions/${sid}/queue`, {
            method: 'POST',
            body: { numbers },
        });
        return r.added;
    }

    async queueAddAll(sid: string): Promise<number> {
        const r = await this.request<{ added: number }>(`/api/sessions/${sid}/queue/all`, { method: 'POST' });
        return r.added;
    }

    async queuePause(sid: string): Promise<void> {
        await this.request(`/api/sessions/${sid}/queue/pause`, { method: 'POST' });
    }

    async queueResume(sid: string): Promise<void> {
        await this.request(`/api/sessions/${sid}/queue/resume`, { method: 'POST' });
    }

    async queueRetryFailed(sid: string): Promise<void> {
        await this.request(`/api/sessions/${sid}/queue/retry-failed`, { method: 'POST' });
    }

    async queueClearCompleted(sid: string): Promise<void> {
        await this.request(`/api/sessions/${sid}/queue/clear-completed`, { method: 'POST' });
    }

    async queueRemove(sid: string, number: number): Promise<void> {
        await this.request(`/api/sessions/${sid}/queue/${number}`, { method: 'DELETE' });
    }

    async queuePage(sid: string, page: number, size: number): Promise<QueueState & QueuePage> {
        const qs = `page=${page}&size=${size}`;
        return this.request<QueueState & QueuePage>(`/api/sessions/${sid}/queue?${qs}`);
    }

    // --- настройки сессии (загрузчик) ---

    async settings(sid: string): Promise<Settings> {
        return this.request<Settings>(`/api/sessions/${sid}/settings`);
    }

    async applySettings(sid: string, patch: Partial<Pick<Settings, 'threadsMode' | 'threadsValue' | 'autoAll'>>): Promise<Settings> {
        return this.request<Settings>(`/api/sessions/${sid}/settings`, { method: 'POST', body: patch });
    }

    /** Сброс скана/очереди сессии; подключение сохраняется. */
    async stateReset(sid: string, scan: boolean, queue: boolean): Promise<void> {
        await this.request(`/api/sessions/${sid}/state/reset`, { method: 'POST', body: { scan, queue } });
    }

    // --- глобальная конфигурация ---

    async config(): Promise<ConfigSnapshot> {
        return this.request<ConfigSnapshot>('/api/config');
    }

    async applyConfig(patch: Record<string, unknown>): Promise<ConfigSnapshot> {
        return this.request<ConfigSnapshot>('/api/config', { method: 'POST', body: patch });
    }

    private async request<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
        const res = await fetch(url, {
            method: init?.method ?? 'GET',
            headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
            body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
        });
        if (!res.ok) {
            let reason = `HTTP ${res.status}`;
            try {
                const err = (await res.json()) as ApiError;
                if (typeof err.reason === 'string' && err.reason !== '') reason = err.reason;
            } catch {
                /* тело не JSON — оставляем HTTP-код */
            }
            throw new Error(reason);
        }
        return (await res.json()) as T;
    }
}

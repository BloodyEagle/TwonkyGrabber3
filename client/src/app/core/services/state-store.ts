import { Injectable, computed, signal } from '@angular/core';
import type { ConfigSnapshot, FoundFile, QueueItemView, QueueState, ScanProgress, SessionSummary } from './api';

export type ThumbSizeKey = 'S' | 'M' | 'L' | 'XL';
export type SortDir = 'asc' | 'desc';
export type TypeFilter = 'all' | 'image' | 'video';

/** Размеры превью (план, п.4: THUMB_SIZES). */
export const THUMB_SIZES: Readonly<Record<ThumbSizeKey, { w: number; h: number; label: string }>> = {
    S: { w: 100, h: 80, label: 'S' },
    M: { w: 200, h: 160, label: 'M' },
    L: { w: 400, h: 320, label: 'L' },
    XL: { w: 800, h: 640, label: 'XL' },
};

export const PAGE_SIZE_DEFAULT = 60;

/** Нейтральный прогресс скана (до первого снимка). */
const DEFAULT_SCAN: ScanProgress = {
    status: 'idle',
    reason: null,
    mode: null,
    connection: null,
    probed: 0,
    found: 0,
    foundImages: 0,
    foundVideos: 0,
    eps: 0,
    arms: [],
    stats: null,
    epoch: 0,
};

/** Данные одной вкладки сервера: всё, что нужно до её выбора. */
export interface SessionTab {
    readonly id: string;
    readonly dir: string;
    scan: ScanProgress | null;
    queueCounts: QueueState['counts'] | null;
    queuePaused: boolean;
    autoAll: boolean;
}

/**
 * Центральное состояние на signals (план, §9): вкладки серверов, скан активной,
 * галерея, очередь, выбор. Данные активной сессии хранятся «плоско» — при
 * переключении вкладки перезагружаются с сервера.
 */
@Injectable({ providedIn: 'root' })
export class StateStore {
    // --- вкладки серверов (мульти-серверность) ---
    /** Порядок вкладок (=id), источник — SSE sessions / GET /api/sessions. */
    readonly sessionOrder = signal<string[]>([]);
    readonly sessionTabs = signal<ReadonlyMap<string, SessionTab>>(new Map());
    /** Активная вкладка; null — вкладка «＋» (форма подключения). */
    readonly activeSid = signal<string | null>(null);

    readonly connected = computed(() => this.activeSid() !== null);

    // --- скан активной сессии ---
    readonly scan = signal<ScanProgress>(DEFAULT_SCAN);
    readonly scanRunning = computed(() => {
        const s = this.scan().status;
        return s === 'detecting' || s === 'scanning';
    });

    // --- галерея активной сессии ---
    readonly files = signal<FoundFile[]>([]);
    readonly filesTotal = signal(0);
    readonly page = signal(1);
    readonly pageSize = signal(PAGE_SIZE_DEFAULT);
    readonly sort = signal<SortDir>('asc');
    readonly typeFilter = signal<TypeFilter>('all');
    readonly thumbSize = signal<ThumbSizeKey>('S');
    readonly filesLoading = signal(false);
    /** Новые находки с последнего обновления страницы (плашка «Появились новые файлы»). */
    readonly newFound = signal(0);
    /** Автодобавление новых находок в галерею без кнопки «обновить». */
    readonly autoRefresh = signal(false);

    readonly totalPages = computed(() => Math.max(1, Math.ceil(this.filesTotal() / this.pageSize())));
    readonly hasNew = computed(() => this.newFound() > 0);

    // --- выбор ---
    readonly selection = signal<ReadonlySet<number>>(new Set<number>());
    readonly selectedCount = computed(() => this.selection().size);

    // --- очередь ---
    readonly queue = signal<QueueState | null>(null);
    readonly queueOpen = signal(false);
    readonly settingsOpen = signal(false);
    readonly queuePage = signal(1);
    readonly queueItems = signal<QueueItemView[]>([]);
    readonly queueTotal = signal(0);

    /** Активных загрузок по всем серверам (бейдж кнопки «Очередь»). */
    readonly activeCount = computed(() => {
        let sum = 0;
        for (const t of this.sessionTabs().values()) sum += t.queueCounts?.active ?? 0;
        return sum;
    });

    /** Конфигурация сервера (GET /api/config); null — ещё не загружена. */
    readonly serverConfig = signal<ConfigSnapshot | null>(null);

    /** Размеры превью от сервера; фолбэк — локальные дефолты. */
    readonly thumbSizes = computed<Readonly<Record<string, { w: number; h: number; label: string }>>>(() => {
        const fromServer = this.serverConfig()?.values.THUMB_SIZES;
        if (fromServer === undefined) return THUMB_SIZES;
        const out: Record<string, { w: number; h: number; label: string }> = {};
        for (const [key, [w, h]] of Object.entries(fromServer)) {
            out[key] = { w, h, label: key };
        }
        return Object.keys(out).length > 0 ? out : THUMB_SIZES;
    });

    // --- вкладки: операции ---

    private tabFromSummary(summary: SessionSummary): SessionTab {
        return {
            id: summary.id,
            dir: summary.dir,
            scan: summary.scan,
            queueCounts: summary.queue.counts,
            queuePaused: summary.queue.paused,
            autoAll: summary.queue.autoAll,
        };
    }

    /** Начальная загрузка (bootstrap): полный снимок всех сессий. */
    initSessions(items: SessionSummary[]): void {
        const order = items.map((i) => i.id);
        const tabs = new Map<string, SessionTab>(items.map((i) => [i.id, this.tabFromSummary(i)]));
        this.sessionOrder.set(order);
        this.sessionTabs.set(tabs);
        const active = this.activeSid();
        if (active === null || !order.includes(active)) {
            this.selectSession(order[0] ?? null);
        } else {
            this.refreshActiveFromTab();
        }
    }

    /** SSE sessions: синхронизация списка (новые/удалённые вкладки). */
    applySessions(list: { id: string; dir: string }[]): void {
        const order = list.map((s) => s.id);
        this.sessionOrder.set(order);
        this.sessionTabs.update((prev) => {
            const next = new Map<string, SessionTab>();
            for (const { id, dir } of list) {
                const existing = prev.get(id);
                next.set(id, existing ?? { id, dir, scan: null, queueCounts: null, queuePaused: false, autoAll: false });
            }
            return next;
        });
        const active = this.activeSid();
        if (active !== null && !order.includes(active)) {
            this.selectSession(order[0] ?? null);
        }
    }

    /** Локальное добавление вкладки после успешного подключения (не ждём SSE). */
    upsertSession(summary: SessionSummary): void {
        this.sessionTabs.update((prev) => {
            const next = new Map(prev);
            next.set(summary.id, this.tabFromSummary(summary));
            return next;
        });
        this.sessionOrder.update((o) => (o.includes(summary.id) ? o : [...o, summary.id]));
    }

    /** Локальное удаление вкладки после DELETE /api/sessions/:id. */
    removeSession(id: string): void {
        this.sessionTabs.update((prev) => {
            const next = new Map(prev);
            next.delete(id);
            return next;
        });
        this.sessionOrder.update((o) => o.filter((sid) => sid !== id));
        if (this.activeSid() === id) {
            this.selectSession(this.sessionOrder()[0] ?? null);
        }
    }

    /** Выбор вкладки (null — форма подключения). Данные активной сбрасываются;
     *  владелец (App) перезагружает страницу галереи по смене activeSid. */
    selectSession(sid: string | null): void {
        this.activeSid.set(sid);
        this.refreshActiveFromTab();
        // Данные активной сессии — под перезагрузку.
        this.page.set(1);
        this.files.set([]);
        this.filesTotal.set(0);
        this.newFound.set(0);
        this.clearSelection();
        this.queue.set(null);
        this.queueItems.set([]);
        this.queueTotal.set(0);
        this.queuePage.set(1);
    }

    /** Сканы вкладок обновились — освежить активное представление. */
    private refreshActiveFromTab(): void {
        const sid = this.activeSid();
        const tab = sid === null ? undefined : this.sessionTabs().get(sid);
        this.scan.set(tab?.scan ?? DEFAULT_SCAN);
    }

    // --- SSE: события активной и фоновой сессий ---

    /** Снимок SSE: скан. Неполные payload не затирают существующие поля. */
    applyScan(sid: string, progress: ScanProgress): void {
        this.sessionTabs.update((prev) => {
            const tab = prev.get(sid);
            if (tab === undefined) return prev;
            const next = new Map(prev);
            next.set(sid, { ...tab, scan: progress });
            return next;
        });
        if (sid === this.activeSid()) {
            const patch = Object.fromEntries(
                Object.entries(progress).filter(([, v]) => v !== undefined),
            ) as Partial<ScanProgress>;
            this.scan.set({ ...this.scan(), ...patch });
        }
    }

    /** SSE found: не трогаем страницу, только сигнализируем о новых (§9 GalleryToolbar). */
    applyFound(sid: string, files: FoundFile[]): void {
        if (sid !== this.activeSid()) return;
        this.newFound.update((n) => n + files.length);
        this.filesTotal.update((t) => t + files.length);
    }

    /** SSE queue: счётчики вкладки + состояние активной. */
    applyQueue(sid: string, state: QueueState): void {
        this.sessionTabs.update((prev) => {
            const tab = prev.get(sid);
            if (tab === undefined) return prev;
            const next = new Map(prev);
            next.set(sid, { ...tab, queueCounts: state.counts, queuePaused: state.paused, autoAll: state.autoAll });
            return next;
        });
        if (sid === this.activeSid()) this.queue.set(state);
    }

    /** Полная (пере)загрузка страницы галереи. */
    setFiles(items: FoundFile[], total: number, resetNew: boolean): void {
        this.files.set(items);
        this.filesTotal.set(total);
        if (resetNew) this.newFound.set(0);
    }

    toggleSelected(number: number, shift: boolean): void {
        this.selection.update((prev) => {
            const next = new Set<number>(prev);
            if (!shift) {
                if (next.has(number)) next.delete(number);
                else next.add(number);
                return next;
            }
            // Shift — диапазон в пределах текущей страницы (§9).
            const current = this.files().map((f) => f.number);
            const anchor = this.lastAnchor ?? number;
            const iA = current.indexOf(anchor);
            const iB = current.indexOf(number);
            if (iA === -1 || iB === -1) {
                next.add(number);
                return next;
            }
            const [from, to] = iA < iB ? [iA, iB] : [iB, iA];
            for (let i = from; i <= to; i += 1) next.add(current[i] ?? 0);
            return next;
        });
        this.lastAnchor = number;
    }

    selectAllOnPage(selected: boolean): void {
        this.selection.update((prev) => {
            const next = new Set<number>(prev);
            for (const f of this.files()) {
                if (selected) next.add(f.number);
                else next.delete(f.number);
            }
            return next;
        });
    }

    clearSelection(): void {
        this.selection.set(new Set<number>());
    }

    private lastAnchor: number | null = null;
}

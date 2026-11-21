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
/** Варианты «на странице» (тулбар + валидация восстановленных значений). */
export const PAGE_SIZE_OPTIONS: readonly number[] = [30, 60, 120];

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

/** Кэшируемое UI-состояние галереи сессии (восстанавливается при возврате на вкладку). */
interface GalleryUiState {
    page: number;
    pageSize: number;
    sort: SortDir;
    typeFilter: TypeFilter;
    thumbSize: ThumbSizeKey;
    selection: ReadonlySet<number>;
    /** Номер первого видимого файла — привязка позиции к файлу, а не к смещению. */
    anchor: number | null;
    /** Режим «Показывать оригиналы» (per-tab). */
    showOriginals: boolean;
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
    /** Номер первого видимого файла текущей страницы (обновляют setFiles и Gallery). */
    readonly pageAnchor = signal<number | null>(null);
    /** Позиция для восстановления: Gallery проскроллит к карточке и сбросит сигнал. */
    readonly pendingAnchor = signal<number | null>(null);
    /** «Показывать оригиналы»: фото тянут оригинал вместо превью (сервер отдаёт
     *  одинаковую заглушку на scale-запросы больших файлов). */
    readonly showOriginals = signal(false);
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
        // Чистим кэш UI удалённых (на стороне сервера) сессий.
        for (const sid of [...this.uiCache.keys()]) {
            if (!order.includes(sid)) {
                this.uiCache.delete(sid);
                this.clearPersisted(sid);
            }
        }
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
        this.uiCache.delete(id);
        this.clearPersisted(id);
        this.sessionTabs.update((prev) => {
            const next = new Map(prev);
            next.delete(id);
            return next;
        });
        this.sessionOrder.update((o) => o.filter((sid) => sid !== id));
        if (this.activeSid() === id) {
            // Не сохраняем UI удалённой сессии — сразу переключаемся и восстанавливаем новую.
            this.activeSid.set(this.sessionOrder()[0] ?? null);
            this.refreshActiveFromTab();
            this.loadUiState(this.activeSid());
            this.resetActiveData();
        }
    }

    /** Выбор вкладки (null — форма подключения). UI-состояние активной сессии
     *  сохраняется в кэш, состояние новой восстанавливается (per-session). */
    selectSession(sid: string | null): void {
        const prev = this.activeSid();
        if (prev !== null && prev !== sid) this.saveUiState(prev);
        this.activeSid.set(sid);
        this.refreshActiveFromTab();
        this.loadUiState(sid);
        this.resetActiveData();
    }

    /** Снимок текущего UI-состояния галереи. */
    private snapshotUi(): GalleryUiState {
        return {
            page: this.page(),
            pageSize: this.pageSize(),
            sort: this.sort(),
            typeFilter: this.typeFilter(),
            thumbSize: this.thumbSize(),
            selection: this.selection(),
            anchor: this.pageAnchor(),
            showOriginals: this.showOriginals(),
        };
    }

    /** Сохранить UI-состояние галереи сессии в кэш и localStorage. */
    private saveUiState(sid: string): void {
        this.uiCache.set(sid, this.snapshotUi());
        this.writePersisted(sid);
    }

    /** Сохранить UI активной вкладки (после смены фильтров/страницы, без переключения). */
    persistActiveUi(): void {
        const sid = this.activeSid();
        if (sid === null) return;
        this.uiCache.set(sid, this.snapshotUi());
        this.writePersisted(sid);
    }

    /** Восстановить UI-состояние галереи сессии: кэш → localStorage → дефолты. */
    private loadUiState(sid: string | null): void {
        if (sid === null) {
            this.applyUiDefaults();
            return;
        }
        const cached = this.uiCache.get(sid);
        if (cached !== undefined) {
            this.page.set(cached.page);
            this.pageSize.set(cached.pageSize);
            this.sort.set(cached.sort);
            this.typeFilter.set(cached.typeFilter);
            this.thumbSize.set(cached.thumbSize);
            this.showOriginals.set(cached.showOriginals);
            this.selection.set(new Set(cached.selection));
            this.pageAnchor.set(cached.anchor);
            this.pendingAnchor.set(cached.anchor);
            return;
        }
        const persisted = this.readPersisted(this.sessionDir(sid) ?? sid);
        if (persisted !== null) {
            const r = this.clampRestored(persisted);
            this.page.set(r.page);
            this.pageSize.set(r.pageSize);
            this.sort.set(r.sort);
            this.typeFilter.set(r.typeFilter);
            this.thumbSize.set(r.thumbSize);
            this.showOriginals.set(r.showOriginals);
            this.clearSelection();
            this.pageAnchor.set(r.anchor);
            this.pendingAnchor.set(r.anchor);
            return;
        }
        this.applyUiDefaults();
    }

    /** Дефолты для новой сессии (без утечки фильтров соседней вкладки). */
    private applyUiDefaults(): void {
        this.page.set(1);
        this.pageSize.set(PAGE_SIZE_DEFAULT);
        this.sort.set('asc');
        this.typeFilter.set('all');
        this.thumbSize.set('S');
        this.showOriginals.set(false);
        this.clearSelection();
        this.pageAnchor.set(null);
        this.pendingAnchor.set(null);
    }

    /** Каталог загрузок сессии — стабильный ключ хранения между перезапусками сервера. */
    private sessionDir(sid: string): string | null {
        return this.sessionTabs().get(sid)?.dir ?? null;
    }

    private static readonly UI_STORAGE_PREFIX = 'tg.gallery.';

    /** Сохранённое в localStorage UI-состояние сессии (по каталогу загрузок). */
    private writePersisted(sid: string): void {
        const dir = this.sessionDir(sid);
        const state = this.uiCache.get(sid);
        if (dir === null || state === undefined) return;
        try {
            const data = {
                v: 1,
                page: state.page,
                pageSize: state.pageSize,
                sort: state.sort,
                type: state.typeFilter,
                thumb: state.thumbSize,
                anchor: state.anchor,
                orig: state.showOriginals,
            };
            localStorage.setItem(StateStore.UI_STORAGE_PREFIX + dir, JSON.stringify(data));
        } catch {
            /* приватный режим или переполнение квоты — не критично */
        }
    }

    private readPersisted(dir: string): Omit<GalleryUiState, 'selection'> | null {
        try {
            const raw = localStorage.getItem(StateStore.UI_STORAGE_PREFIX + dir);
            if (raw === null) return null;
            const d = JSON.parse(raw) as {
                page?: unknown;
                pageSize?: unknown;
                sort?: unknown;
                type?: unknown;
                thumb?: unknown;
                anchor?: unknown;
                orig?: unknown;
            };
            return {
                page: typeof d.page === 'number' ? d.page : 1,
                pageSize: typeof d.pageSize === 'number' ? d.pageSize : PAGE_SIZE_DEFAULT,
                sort: d.sort === 'desc' ? 'desc' : 'asc',
                typeFilter: d.type === 'image' || d.type === 'video' ? d.type : 'all',
                thumbSize: typeof d.thumb === 'string' && d.thumb !== '' ? (d.thumb as ThumbSizeKey) : 'S',
                anchor: typeof d.anchor === 'number' && Number.isFinite(d.anchor) ? d.anchor : null,
                showOriginals: d.orig === true,
            };
        } catch {
            return null;
        }
    }

    /** Валидация восстановленного значения: мусор в localStorage не ломает галерею. */
    private clampRestored(r: Omit<GalleryUiState, 'selection'>): Omit<GalleryUiState, 'selection'> {
        const allowedThumb = new Set([
            ...Object.keys(THUMB_SIZES),
            ...Object.keys(this.serverConfig()?.values.THUMB_SIZES ?? {}),
        ]);
        return {
            page: Number.isInteger(r.page) && r.page >= 1 ? r.page : 1,
            pageSize: PAGE_SIZE_OPTIONS.includes(r.pageSize) ? r.pageSize : PAGE_SIZE_DEFAULT,
            sort: r.sort,
            typeFilter: r.typeFilter,
            thumbSize: allowedThumb.has(r.thumbSize) ? r.thumbSize : 'S',
            anchor: r.anchor !== null && Number.isFinite(r.anchor) ? r.anchor : null,
            showOriginals: r.showOriginals === true,
        };
    }

    /** Удалить сохранённое UI-состояние закрытой сессии. */
    private clearPersisted(sid: string): void {
        const dir = this.sessionDir(sid) ?? sid;
        try {
            localStorage.removeItem(StateStore.UI_STORAGE_PREFIX + dir);
        } catch {
            /* localStorage недоступен — не критично */
        }
    }

    /** Данные активной сессии (не кэшируемые per-session) — под перезагрузку. */
    private resetActiveData(): void {
        this.files.set([]);
        this.filesTotal.set(0);
        this.newFound.set(0);
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
        this.pageAnchor.set(items.length > 0 ? (items[0]?.number ?? null) : null);
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

    /** Кэш UI-состояния галереи по сессиям (per-session). */
    private readonly uiCache = new Map<string, GalleryUiState>();
}

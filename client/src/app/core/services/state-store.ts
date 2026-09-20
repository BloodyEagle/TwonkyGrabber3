import { Injectable, computed, signal } from '@angular/core';
import type { ConfigSnapshot, FoundFile, QueueItemView, QueueState, ScanProgress, TwonkyConnection } from './api';

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

/**
 * Центральное состояние на signals (план, §9): скан, галерея, очередь, выбор.
 */
@Injectable({ providedIn: 'root' })
export class StateStore {
    // --- подключение ---
    readonly connection = signal<TwonkyConnection | null>(null);
    readonly connected = computed(() => this.connection() !== null);

    // --- скан ---
    readonly scan = signal<ScanProgress>({
        status: 'idle',
        reason: null,
        mode: null,
        probed: 0,
        found: 0,
        eps: 0,
        arms: [],
        stats: null,
    });
    readonly scanRunning = computed(() => {
        const s = this.scan().status;
        return s === 'detecting' || s === 'scanning';
    });

    // --- галерея ---
    readonly files = signal<FoundFile[]>([]);
    readonly filesTotal = signal(0);
    readonly page = signal(1);
    readonly pageSize = signal(PAGE_SIZE_DEFAULT);
    readonly sort = signal<SortDir>('asc');
    readonly typeFilter = signal<TypeFilter>('all');
    readonly thumbSize = signal<ThumbSizeKey>('M');
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

    readonly activeCount = computed(() => this.queue()?.counts.active ?? 0);

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

    /** Снимок SSE: скан. Неполные payload не затирают существующие поля. */
    applyScan(progress: ScanProgress): void {
        const patch = Object.fromEntries(
            Object.entries(progress).filter(([, v]) => v !== undefined),
        ) as Partial<ScanProgress>;
        this.scan.set({ ...this.scan(), ...patch });
    }

    /** SSE found: не трогаем страницу, только сигнализируем о новых (§9 GalleryToolbar). */
    applyFound(files: FoundFile[]): void {
        this.newFound.update((n) => n + files.length);
        this.filesTotal.update((t) => t + files.length);
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

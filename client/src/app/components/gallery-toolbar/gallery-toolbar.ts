import { Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/services/api';
import { FilesService } from '../../core/services/files';
import { StateStore, THUMB_SIZES } from '../../core/services/state-store';
import { ToastService } from '../../core/services/toast';
import { formatNumber } from '../../core/format';

@Component({
    selector: 'app-gallery-toolbar',
    imports: [FormsModule],
    templateUrl: './gallery-toolbar.html',
    styleUrl: './gallery-toolbar.scss',
})
export class GalleryToolbar {
    private readonly api = inject(ApiService);
    private readonly files = inject(FilesService);
    private readonly store = inject(StateStore);
    private readonly toast = inject(ToastService);

    protected readonly storeRef = this.store;
    protected readonly fmt = formatNumber;

    protected readonly allOnPageSelected = computed(() => {
        const sel = this.store.selection();
        return this.store.files().length > 0 && this.store.files().every((f) => sel.has(f.number));
    });

    protected readonly pages = computed<number[]>(() => {
        const total = this.store.totalPages();
        const current = this.store.page();
        if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
        const set = new Set<number>([1, total, current, current - 1, current + 1]);
        const list = [...set].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
        const out: number[] = [];
        let prev = 0;
        for (const p of list) {
            if (p - prev > 1) out.push(0); // 0 = «…»
            out.push(p);
            prev = p;
        }
        return out;
    });

    protected readonly allPages = computed<number[]>(() =>
        Array.from({ length: this.store.totalPages() }, (_, i) => i + 1),
    );

    protected readonly thumbSizes = this.store.thumbSizes;
    protected readonly sizeKeys = Object.keys(THUMB_SIZES) as (keyof typeof THUMB_SIZES)[];

    protected readonly sizeOptions = [30, 60, 120];

    /** compareWith для ngModel-селекта числовых опций. */
    protected equalAsNumber(a: unknown, b: unknown): boolean {
        return Number(a) === Number(b);
    }

    protected async goToPage(page: number): Promise<void> {
        if (page < 1 || page > this.store.totalPages() || page === this.store.page()) return;
        await this.files.setPage(page);
    }

    protected async changeSort(value: 'asc' | 'desc'): Promise<void> {
        await this.files.setSort(value);
    }

    protected async changeType(value: 'all' | 'image' | 'video'): Promise<void> {
        await this.files.setType(value);
    }

    protected async changePageSize(value: number): Promise<void> {
        await this.files.setPageSize(Number(value));
    }

    protected setThumbSize(key: keyof typeof THUMB_SIZES): void {
        this.store.thumbSize.set(key);
    }

    protected toggleAll(event: Event): void {
        this.store.selectAllOnPage((event.target as HTMLInputElement).checked);
    }

    protected async enqueueSelected(): Promise<void> {
        const sid = this.store.activeSid();
        if (sid === null) return;
        const numbers = [...this.store.selection()];
        if (numbers.length === 0) return;
        try {
            const added = await this.api.queueAdd(sid, numbers);
            this.toast.show('success', `Добавлено в очередь: ${added}`);
            this.store.clearSelection();
        } catch (err: unknown) {
            this.toast.show('error', err instanceof Error ? err.message : String(err));
        }
    }

    protected async enqueueAll(): Promise<void> {
        const sid = this.store.activeSid();
        if (sid === null) return;
        try {
            const added = await this.api.queueAddAll(sid);
            this.toast.show('success', `«Скачать всё»: добавлено ${added}`);
        } catch (err: unknown) {
            this.toast.show('error', err instanceof Error ? err.message : String(err));
        }
    }

    protected async refreshNew(): Promise<void> {
        await this.files.refreshWithNew();
    }

    /** Включение автообновления — сразу подхватить накопленные находки. */
    protected async refreshNewIfAuto(): Promise<void> {
        if (this.store.autoRefresh() && this.store.newFound() > 0) {
            await this.files.reloadAuto();
        }
    }
}

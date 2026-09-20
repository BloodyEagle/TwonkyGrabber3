import { Injectable, inject } from '@angular/core';
import { ApiService } from './api';
import { StateStore } from './state-store';

/** Загрузка страниц галереи и обновление по SSE-находкам (план, §9). */
@Injectable({ providedIn: 'root' })
export class FilesService {
    private readonly api = inject(ApiService);
    private readonly store = inject(StateStore);

    /** Загрузить текущую страницу (page/size/sort/type из стора). */
    async loadPage(page?: number): Promise<void> {
        const target = page ?? this.store.page();
        this.store.filesLoading.set(true);
        try {
            const r = await this.api.files(target, this.store.pageSize(), this.store.sort(), this.store.typeFilter());
            this.store.page.set(r.page);
            this.store.setFiles(r.items, r.total, true);
        } finally {
            this.store.filesLoading.set(false);
        }
    }

    async setPage(page: number): Promise<void> {
        await this.loadPage(page);
    }

    async setSort(sort: 'asc' | 'desc'): Promise<void> {
        this.store.sort.set(sort);
        await this.loadPage(1);
    }

    async setType(type: 'all' | 'image' | 'video'): Promise<void> {
        this.store.typeFilter.set(type);
        await this.loadPage(1);
    }

    async setPageSize(size: number): Promise<void> {
        this.store.pageSize.set(size);
        await this.loadPage(1);
    }

    /** Плашка «Появились новые файлы — обновить». */
    async refreshWithNew(): Promise<void> {
        await this.loadPage(1);
    }

    /** Автообновление: перезагрузить текущую страницу и сбросить счётчик новых
     *  (без прыжка к первой странице). Повторные вызовы во время загрузки игнорируются. */
    async reloadAuto(): Promise<void> {
        if (this.store.filesLoading()) return;
        await this.loadPage(this.store.page());
    }
}

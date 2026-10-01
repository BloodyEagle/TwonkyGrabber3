import { Injectable, effect, inject, untracked } from '@angular/core';
import { ApiService } from './api';
import { StateStore } from './state-store';

/** Загрузка страниц галереи и обновление по SSE-находкам (план, §9).
 *  Страницы всегда берутся у активной сессии (мульти-серверность). */
@Injectable({ providedIn: 'root' })
export class FilesService {
    private readonly api = inject(ApiService);
    private readonly store = inject(StateStore);
    /** Порядковый номер запроса — игнорируем устаревшие ответы и сброс индикатора. */
    private loadSeq = 0;

    constructor() {
        // Смена вкладки → перезагрузка страницы галереи новой активной сессии.
        // untracked: loadPage читает sort/type/pageSize из стора — они не должны
        // становиться зависимостями эффекта (иначе смена фильтра прыгала бы на стр. 1).
        effect(() => {
            const sid = this.store.activeSid();
            // Восстанавливаем страницу вкладки (per-session кэш), а не сбрасываем на 1.
            if (sid !== null) untracked(() => void this.loadPage());
        });
    }

    /** Загрузить текущую страницу (page/size/sort/type из стора). */
    async loadPage(page?: number): Promise<void> {
        const sid = this.store.activeSid();
        if (sid === null) return;
        const seq = ++this.loadSeq;
        const target = page ?? this.store.page();
        this.store.filesLoading.set(true);
        try {
            const r = await this.api.files(sid, target, this.store.pageSize(), this.store.sort(), this.store.typeFilter());
            // Вкладка могла смениться (или пришёл новый запрос) — не затираем новое.
            if (seq !== this.loadSeq || this.store.activeSid() !== sid) return;
            this.store.page.set(r.page);
            this.store.setFiles(r.items, r.total, true);
        } catch {
            /* сетевая ошибка — текущая страница остаётся как есть (SSE подхватит) */
        } finally {
            if (seq === this.loadSeq) this.store.filesLoading.set(false);
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
        // Сохраняем позицию: первый элемент текущей страницы должен остаться на экране.
        // Смещение первого элемента в отсортированном списке -> новая страница для нового size.
        const offset = (this.store.page() - 1) * this.store.pageSize();
        this.store.pageSize.set(size);
        const page = Math.floor(offset / size) + 1;
        await this.loadPage(page);
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

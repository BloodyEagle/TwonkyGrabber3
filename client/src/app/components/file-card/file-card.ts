import { Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import type { FoundFile } from '../../core/services/api';
import { ApiService } from '../../core/services/api';
import { StateStore, THUMB_SIZES } from '../../core/services/state-store';
import { ThumbService } from '../../core/services/thumb';
import { formatSize } from '../../core/format';

const OVERSIZE_FACTOR = 1.5;

@Component({
    selector: 'app-file-card',
    imports: [],
    templateUrl: './file-card.html',
    styleUrl: './file-card.scss',
})
export class FileCard {
    private readonly api = inject(ApiService);
    private readonly store = inject(StateStore);
    private readonly thumbs = inject(ThumbService);
    private readonly destroyRef = inject(DestroyRef);

    readonly file = input.required<FoundFile>();
    readonly thumb = input.required<{ w: number; h: number }>();

    protected readonly loaded = signal(false);
    protected readonly failed = signal(false);
    protected readonly oversized = signal(false);
    protected readonly realDims = signal<string | null>(null);
    /** Blob-url загруженного превью (через ThumbService — без монополизации сокетов). */
    protected readonly blobUrl = signal<string | null>(null);
    private controller: AbortController | null = null;

    protected readonly selected = computed(() => this.store.selection().has(this.file().number));
    protected readonly thumbSrc = computed(() => {
        const sid = this.store.activeSid() ?? '';
        const epoch = this.store.scan().epoch;
        // Режим «Показывать оригиналы»: фото тянут оригинал (уменьшается до размера
        // карточки средствами браузера). Только для фото: оригинал видео — гигабайты,
        // видео остаётся на обычном пути (негатив → заглушка «видео»).
        if (this.store.showOriginals() && this.file().kind === 'image') {
            return this.api.originalUrl(sid, this.file().number, epoch);
        }
        return this.api.thumbUrl(sid, this.file().number, this.thumb().w, this.thumb().h, epoch);
    });
    protected readonly originalHref = computed(() =>
        this.api.originalUrl(this.store.activeSid() ?? '', this.file().number, this.store.scan().epoch),
    );

    constructor() {
        // Смена url превью (вкладка/размер/режим) — перезагрузить blob. Эффект
        // перезапускается при каждом SSE scan-тике (scan() — новый объект), хотя
        // url не меняется: без сравнения каждая загрузка отменялась бы через
        // полсекунды, и превью не грузились бы вовсе.
        let lastUrl: string | null = null;
        effect(() => {
            const url = this.thumbSrc();
            if (url === lastUrl) return;
            lastUrl = url;
            void this.loadThumb(url);
        });
        this.destroyRef.onDestroy(() => this.releaseThumb());
    }

    private async loadThumb(url: string): Promise<void> {
        this.releaseThumb();
        const ac = new AbortController();
        this.controller = ac;
        this.loaded.set(false);
        try {
            const blob = await this.thumbs.load(url, ac);
            if (blob === null || ac.signal.aborted) return;
            this.blobUrl.set(URL.createObjectURL(blob));
        } catch {
            if (!ac.signal.aborted) this.failed.set(true);
        }
    }

    /** Отменить загрузку и освободить blob (повторная загрузка/уничтожение карточки). */
    private releaseThumb(): void {
        this.controller?.abort();
        this.controller = null;
        const prev = this.blobUrl();
        if (prev !== null) {
            this.blobUrl.set(null);
            URL.revokeObjectURL(prev);
        }
    }

    protected onShiftClick(event: MouseEvent): void {
        event.preventDefault();
        event.stopPropagation();
        this.store.toggleSelected(this.file().number, event.shiftKey);
    }

    protected onLoad(event: Event): void {
        const img = event.target as HTMLImageElement;
        this.loaded.set(true);
        // В режиме «Показывать оригиналы» крупная картинка ожидаема — не помечаем.
        if (this.store.showOriginals()) return;
        const { w, h } = this.thumb();
        if (img.naturalWidth > w * OVERSIZE_FACTOR || img.naturalHeight > h * OVERSIZE_FACTOR) {
            this.oversized.set(true);
            this.realDims.set(`${img.naturalWidth}×${img.naturalHeight}`);
        }
    }

    protected onError(): void {
        this.failed.set(true);
    }

    protected readonly sizeLabel = computed(() => formatSize(this.file().size));
}

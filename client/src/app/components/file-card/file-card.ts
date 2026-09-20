import { Component, computed, inject, input, signal } from '@angular/core';
import type { FoundFile } from '../../core/services/api';
import { ApiService } from '../../core/services/api';
import { StateStore, THUMB_SIZES } from '../../core/services/state-store';
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

    readonly file = input.required<FoundFile>();
    readonly thumb = input.required<{ w: number; h: number }>();

    protected readonly loaded = signal(false);
    protected readonly failed = signal(false);
    protected readonly oversized = signal(false);
    protected readonly realDims = signal<string | null>(null);

    protected readonly selected = computed(() => this.store.selection().has(this.file().number));
    protected readonly thumbSrc = computed(() =>
        this.api.thumbUrl(this.file().number, this.thumb().w, this.thumb().h, this.store.scan().epoch),
    );
    protected readonly originalHref = computed(() => this.api.originalUrl(this.file().number, this.store.scan().epoch));

    protected onShiftClick(event: MouseEvent): void {
        event.preventDefault();
        event.stopPropagation();
        this.store.toggleSelected(this.file().number, event.shiftKey);
    }

    protected onLoad(event: Event): void {
        const img = event.target as HTMLImageElement;
        this.loaded.set(true);
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

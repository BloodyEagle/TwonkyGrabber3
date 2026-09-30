import { Component, computed, inject } from '@angular/core';
import { StateStore, THUMB_SIZES } from '../../core/services/state-store';
import { FileCard } from '../file-card/file-card';

@Component({
    selector: 'app-gallery',
    imports: [FileCard],
    templateUrl: './gallery.html',
    styleUrl: './gallery.scss',
})
export class Gallery {
    protected readonly store = inject(StateStore);

    protected readonly thumb = computed(() => this.store.thumbSizes()[this.store.thumbSize()] ?? THUMB_SIZES.M);
    protected readonly cardWidth = computed(() => this.thumb().w + 16);

    /** Скелетонов — столько же, сколько карточек на странице: высота документа
     *  при загрузке не меняется, и прокрутка не сбрасывается браузером. */
    protected readonly skeletons = computed(() =>
        Array.from({ length: this.store.pageSize() }, (_, i) => i),
    );
}

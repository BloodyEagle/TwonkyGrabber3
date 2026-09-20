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

    protected readonly skeletons = computed(() => {
        const cols = Math.max(1, Math.floor(800 / this.cardWidth()));
        return Array.from({ length: Math.min(cols * 2, 12) }, (_, i) => i);
    });
}

import { Component, DestroyRef, computed, effect, inject } from '@angular/core';
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
    private readonly destroyRef = inject(DestroyRef);

    protected readonly thumb = computed(() => this.store.thumbSizes()[this.store.thumbSize()] ?? THUMB_SIZES.M);
    protected readonly cardWidth = computed(() => this.thumb().w + 16);

    /** Скелетонов — столько же, сколько карточек на странице: высота документа
     *  при загрузке не меняется, и прокрутка не сбрасывается браузером. */
    protected readonly skeletons = computed(() =>
        Array.from({ length: this.store.pageSize() }, (_, i) => i),
    );

    constructor() {
        // Восстановление позиции: после загрузки страницы проскроллить к запомненному
        // файлу (первому видимому до ухода) и сбросить pendingAnchor. rAF — после
        // фиксации DOM, иначе карточек ещё нет.
        effect(() => {
            const anchor = this.store.pendingAnchor();
            if (anchor === null || this.store.filesLoading()) return;
            requestAnimationFrame(() => {
                const el = document.querySelector<HTMLElement>(`app-file-card[data-number="${anchor}"]`);
                el?.scrollIntoView({ block: 'start' });
                this.store.pendingAnchor.set(null);
            });
        });

        // Первый видимый файл при прокрутке — якорь позиции для сохранения.
        // Слушаем window: скролл идёт по документу, app-main не имеет overflow.
        const onScroll = (): void => {
            if (this.store.filesLoading()) return;
            requestAnimationFrame(() => {
                const top = [...document.querySelectorAll<HTMLElement>('app-file-card')].find(
                    (c) => c.getBoundingClientRect().bottom > 0,
                );
                const n = top?.getAttribute('data-number');
                if (n !== null && n !== undefined && n !== '') this.store.pageAnchor.set(Number(n));
            });
        };
        window.addEventListener('scroll', onScroll, { passive: true });
        this.destroyRef.onDestroy(() => window.removeEventListener('scroll', onScroll));
    }
}

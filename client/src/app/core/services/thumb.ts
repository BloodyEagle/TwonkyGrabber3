import { Injectable } from '@angular/core';

/**
 * Ограниченная параллельная загрузка превью (fetch → blob).
 *
 * Прямые <img src> на страницу из 60 оригиналов монополизируют все соединения
 * вкладки к серверу (6 на origin для HTTP/1.1): /files, SSE и переключение
 * вкладок ждут за картинками минуты. Здесь не более CONCURRENCY одновременных
 * загрузок; уход карточки (abort) освобождает слот мгновенно — другие вкладки
 * не страдают. Ответы кэшируются браузером по Cache-Control от сервера.
 */
@Injectable({ providedIn: 'root' })
export class ThumbService {
    private static readonly CONCURRENCY = 4;
    private active = 0;
    private readonly queue: Array<{ ac: AbortController; resolve: () => void; reject: (err: unknown) => void }> = [];

    /** Загрузить url в blob; ac.abort() снимает из очереди/прерывает fetch.
     *  Возвращает null при отмене. */
    async load(url: string, ac: AbortController): Promise<Blob | null> {
        if (ac.signal.aborted) return null;
        await this.acquire(ac);
        try {
            const r = await fetch(url, { signal: ac.signal });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return await r.blob();
        } finally {
            this.release();
        }
    }

    private acquire(ac: AbortController): Promise<void> {
        if (this.active < ThumbService.CONCURRENCY) {
            this.active += 1;
            return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
            const entry = { ac, resolve, reject };
            this.queue.push(entry);
            ac.signal.addEventListener(
                'abort',
                () => {
                    const i = this.queue.indexOf(entry);
                    if (i !== -1) {
                        this.queue.splice(i, 1);
                        reject(new DOMException('Загрузка отменена', 'AbortError'));
                    }
                },
                { once: true },
            );
        });
    }

    private release(): void {
        this.active -= 1;
        const next = this.queue.shift();
        if (next !== undefined) {
            this.active += 1;
            next.resolve();
        }
    }
}

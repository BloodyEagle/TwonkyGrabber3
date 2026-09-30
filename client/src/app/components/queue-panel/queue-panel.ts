import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/services/api';
import { StateStore } from '../../core/services/state-store';
import { ToastService } from '../../core/services/toast';
import { formatNumber, formatSize, formatSpeed } from '../../core/format';

const QUEUE_PAGE_SIZE = 50;

/** Панель очереди: показывает очередь активной сессии (как и остальной UI). */
@Component({
    selector: 'app-queue-panel',
    imports: [FormsModule],
    templateUrl: './queue-panel.html',
    styleUrl: './queue-panel.scss',
})
export class QueuePanel {
    private readonly api = inject(ApiService);
    private readonly store = inject(StateStore);
    private readonly toast = inject(ToastService);

    protected readonly storeRef = this.store;
    protected readonly fmt = formatNumber;
    protected readonly fmtSize = formatSize;
    protected readonly fmtSpeed = formatSpeed;

    protected readonly manualValue = signal(4);

    constructor() {
        void this.loadPage(1);
    }

    protected close(): void {
        this.store.queueOpen.set(false);
    }

    /** Сессия для запросов и заголовка: активная (панель следует за выбранной вкладкой). */
    protected sid(): string {
        return this.store.activeSid() ?? '';
    }

    protected async pause(): Promise<void> {
        await this.guard(() => this.api.queuePause(this.sid()));
    }

    protected async resume(): Promise<void> {
        await this.guard(() => this.api.queueResume(this.sid()));
    }

    protected async retryFailed(): Promise<void> {
        await this.guard(() => this.api.queueRetryFailed(this.sid()));
    }

    protected async clearCompleted(): Promise<void> {
        await this.guard(() => this.api.queueClearCompleted(this.sid()));
    }

    protected async remove(number: number): Promise<void> {
        await this.guard(() => this.api.queueRemove(this.sid(), number));
    }

    protected statusLabel(status: string): string {
        const labels: Readonly<Record<string, string>> = {
            pending: 'ожидание',
            active: 'качается',
            done: 'готово',
            skipped: 'пропущен',
            failed: 'ошибка',
        };
        return labels[status] ?? status;
    }

    protected pct(item: { downloaded: number; size: number }): number {
        return item.size > 0 ? Math.round((item.downloaded / item.size) * 100) : 0;
    }

    protected async setModeChange(event: Event): Promise<void> {
        const checked = (event.target as HTMLInputElement).checked;
        await this.setMode(checked ? 'auto' : 'manual');
    }

    protected async setMode(mode: 'auto' | 'manual'): Promise<void> {
        if (mode === 'manual') {
            await this.guard(() => this.api.applySettings(this.sid(), { threadsMode: 'manual', threadsValue: this.manualValue() }));
        } else {
            await this.guard(() => this.api.applySettings(this.sid(), { threadsMode: 'auto' }));
        }
    }

    protected async setManual(event: Event): Promise<void> {
        const value = Number.parseInt((event.target as HTMLInputElement).value, 10);
        if (Number.isFinite(value)) {
            this.manualValue.set(value);
            await this.guard(() => this.api.applySettings(this.sid(), { threadsValue: value }));
        }
    }

    protected async prevPage(): Promise<void> {
        const p = this.store.queuePage();
        if (p > 1) await this.loadPage(p - 1);
    }

    protected async nextPage(): Promise<void> {
        const p = this.store.queuePage();
        if (p < Math.max(1, Math.ceil(this.store.queueTotal() / QUEUE_PAGE_SIZE))) await this.loadPage(p + 1);
    }

    protected async loadPage(page: number): Promise<void> {
        const sid = this.sid();
        if (sid === '') return;
        try {
            const r = await this.api.queuePage(sid, page, QUEUE_PAGE_SIZE);
            // Вкладка могла смениться/закрыться за время запроса.
            if (this.sid() !== sid) return;
            this.store.queue.set(r);
            this.store.queueItems.set(r.items);
            this.store.queueTotal.set(r.total);
            this.store.queuePage.set(page);
        } catch {
            /* очередь обновится по SSE */
        }
    }

    private async guard(action: () => Promise<unknown>): Promise<void> {
        try {
            await action();
        } catch (err: unknown) {
            this.toast.show('error', err instanceof Error ? err.message : String(err));
        }
    }
}

import { Component, computed, inject } from '@angular/core';
import type { Signal } from '@angular/core';
import { ApiService } from '../../core/services/api';
import { StateStore } from '../../core/services/state-store';
import type { SessionTab } from '../../core/services/state-store';
import { ToastService } from '../../core/services/toast';

/** Строка вкладок серверов: host:port, индикатор скана, бейдж активных загрузок. */
@Component({
    selector: 'app-tabs-bar',
    imports: [],
    templateUrl: './tabs-bar.html',
    styleUrl: './tabs-bar.scss',
})
export class TabsBar {
    private readonly api = inject(ApiService);
    private readonly store = inject(StateStore);
    private readonly toast = inject(ToastService);

    protected readonly storeRef = this.store;

    /** Вкладки в порядке сервера; id может отсутствовать в Map — рисуем заглушку. */
    protected readonly tabs: Signal<Array<SessionTab & { host: string | null }>> = computed(() => {
        const map = this.store.sessionTabs();
        return this.store.sessionOrder().map((id) => {
            const tab = map.get(id);
            return {
                id,
                dir: tab?.dir ?? id,
                scan: tab?.scan ?? null,
                queueCounts: tab?.queueCounts ?? null,
                queuePaused: tab?.queuePaused ?? false,
                autoAll: tab?.autoAll ?? false,
                host: tab?.scan?.connection?.host ?? null,
            };
        });
    });

    protected label(tab: SessionTab & { host: string | null }): string {
        const conn = tab.scan?.connection;
        if (conn !== null && conn !== undefined) return `${conn.host}:${conn.port}`;
        return tab.host ?? tab.dir;
    }

    protected statusClass(tab: SessionTab): string {
        return tab.scan?.status ?? 'idle';
    }

    protected activeDownloads(tab: SessionTab): number {
        return tab.queueCounts?.active ?? 0;
    }

    protected select(sid: string): void {
        this.store.selectSession(sid);
    }

    protected selectNew(): void {
        this.store.selectSession(null);
    }

    protected async close(sid: string): Promise<void> {
        const tab = this.store.sessionTabs().get(sid);
        const label = tab?.scan?.connection ? `${tab.scan.connection.host}:${tab.scan.connection.port}` : sid;
        const running = tab?.scan?.status === 'scanning' || tab?.scan?.status === 'detecting';
        const active = tab?.queueCounts?.active ?? 0;
        const parts: string[] = [label];
        if (running) parts.push('идёт скан');
        if (active > 0) parts.push(`скачивается ${active}`);
        const question = `Убрать вкладку ${parts.join(' — ')}? Скачанные файлы останутся на диске.`;
        if (!window.confirm(question)) return;
        try {
            await this.api.deleteSession(sid);
            this.store.removeSession(sid);
            this.toast.show('success', 'Вкладка удалена');
        } catch (err: unknown) {
            this.toast.show('error', err instanceof Error ? err.message : String(err));
        }
    }
}

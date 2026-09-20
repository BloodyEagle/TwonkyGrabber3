import { Component, computed, inject } from '@angular/core';
import { ApiService } from '../../core/services/api';
import { StateStore } from '../../core/services/state-store';
import { ToastService } from '../../core/services/toast';
import { formatNumber } from '../../core/format';

const STATUS_LABEL: Readonly<Record<string, string>> = {
    idle: 'Ожидание',
    detecting: 'Разведка',
    scanning: 'Сканирование',
    paused: 'Пауза',
    done: 'Готово',
    error: 'Ошибка',
};

@Component({
    selector: 'app-scan-panel',
    imports: [],
    templateUrl: './scan-panel.html',
    styleUrl: './scan-panel.scss',
})
export class ScanPanel {
    private readonly api = inject(ApiService);
    private readonly store = inject(StateStore);
    private readonly toast = inject(ToastService);

    protected readonly storeRef = this.store;
    protected readonly fmt = formatNumber;

    protected readonly statusLabel = computed(() => STATUS_LABEL[this.store.scan().status] ?? this.store.scan().status);

    protected readonly canStart = computed(() => this.store.connected() && !this.store.scanRunning());

    protected async start(): Promise<void> {
        try {
            await this.api.scanStart();
            // start/stop возвращают только {ok, status, reason} — полный снимок берём отдельно.
            this.store.applyScan(await this.api.scanStatus());
        } catch (err: unknown) {
            this.toast.show('error', err instanceof Error ? err.message : String(err));
        }
    }

    protected async stop(): Promise<void> {
        try {
            await this.api.scanStop();
            this.store.applyScan(await this.api.scanStatus());
        } catch (err: unknown) {
            this.toast.show('error', err instanceof Error ? err.message : String(err));
        }
    }
}

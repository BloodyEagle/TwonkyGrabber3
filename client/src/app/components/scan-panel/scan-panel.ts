import { Component, computed, inject, signal } from '@angular/core';
import { ApiService } from '../../core/services/api';
import { FilesService } from '../../core/services/files';
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

/** Панель скана активной сессии + кнопка сброса её состояния. */
@Component({
    selector: 'app-scan-panel',
    imports: [],
    templateUrl: './scan-panel.html',
    styleUrl: './scan-panel.scss',
})
export class ScanPanel {
    private readonly api = inject(ApiService);
    private readonly store = inject(StateStore);
    private readonly files = inject(FilesService);
    private readonly toast = inject(ToastService);

    protected readonly storeRef = this.store;
    protected readonly fmt = formatNumber;

    protected readonly statusLabel = computed(() => STATUS_LABEL[this.store.scan().status] ?? this.store.scan().status);

    protected readonly canStart = computed(() => this.store.connected() && !this.store.scanRunning());

    protected readonly resetScan = signal(true);
    protected readonly resetQueue = signal(true);
    protected readonly confirmReset = signal(false);

    protected async start(): Promise<void> {
        const sid = this.store.activeSid();
        if (sid === null) return;
        try {
            // start/stop возвращают полный прогресс сессии.
            this.store.applyScan(sid, await this.api.scanStart(sid));
        } catch (err: unknown) {
            this.toast.show('error', err instanceof Error ? err.message : String(err));
        }
    }

    protected async stop(): Promise<void> {
        const sid = this.store.activeSid();
        if (sid === null) return;
        try {
            this.store.applyScan(sid, await this.api.scanStop(sid));
        } catch (err: unknown) {
            this.toast.show('error', err instanceof Error ? err.message : String(err));
        }
    }

    protected toggleResetScan(event: Event): void {
        this.resetScan.set((event.target as HTMLInputElement).checked);
    }

    protected toggleResetQueue(event: Event): void {
        this.resetQueue.set((event.target as HTMLInputElement).checked);
    }

    protected async doReset(): Promise<void> {
        const sid = this.store.activeSid();
        if (sid === null) return;
        if (!this.confirmReset()) {
            this.confirmReset.set(true);
            return;
        }
        try {
            await this.api.stateReset(sid, this.resetScan(), this.resetQueue());
            this.toast.show('success', 'Состояние сброшено');
            this.confirmReset.set(false);
            // Галерея — сразу в актуальное состояние (эпоха сменит URL превью).
            this.store.clearSelection();
            this.store.newFound.set(0);
            this.store.applyScan(sid, await this.api.scanStatus(sid));
            await this.files.loadPage(1);
        } catch (err: unknown) {
            this.toast.show('error', err instanceof Error ? err.message : String(err));
        }
    }
}

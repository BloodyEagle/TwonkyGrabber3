import { Component, inject, signal } from '@angular/core';
import { ApiService } from './core/services/api';
import { FilesService } from './core/services/files';
import { SseService } from './core/services/sse';
import { StateStore } from './core/services/state-store';
import { ToastService } from './core/services/toast';
import { ConnectionForm } from './components/connection-form/connection-form';
import { ScanPanel } from './components/scan-panel/scan-panel';
import { GalleryToolbar } from './components/gallery-toolbar/gallery-toolbar';
import { Gallery } from './components/gallery/gallery';
import { QueuePanel } from './components/queue-panel/queue-panel';
import { SettingsPage } from './components/settings-page/settings-page';

@Component({
    selector: 'app-root',
    imports: [ConnectionForm, ScanPanel, GalleryToolbar, Gallery, QueuePanel, SettingsPage],
    templateUrl: './app.html',
    styleUrl: './app.scss',
})
export class App {
    private readonly api = inject(ApiService);
    private readonly sse = inject(SseService);
    private readonly files = inject(FilesService);
    private readonly store = inject(StateStore);
    protected readonly toasts = inject(ToastService);

    protected readonly storeRef = this.store;
    protected readonly bootstrapped = signal(false);

    constructor() {
        void this.bootstrap();
    }

    private async bootstrap(): Promise<void> {
        // Первичный снимок статуса, затем SSE.
        try {
            this.store.applyScan(await this.api.scanStatus());
        } catch {
            /* сервер недоступен — SSE переподключится сам */
        }
        this.sse.connect({
            onScan: (p) => this.store.applyScan(p),
            onFound: (files) => {
                this.store.applyFound(files);
                if (this.store.autoRefresh()) void this.files.reloadAuto();
            },
            onQueue: (q) => this.store.queue.set(q),
        });
        try {
            this.store.serverConfig.set(await this.api.config());
        } catch {
            /* конфигурация не критична — останутся дефолты */
        }
        try {
            await this.files.loadPage(1);
        } catch {
            /* файлов может не быть — пустая галерея */
        }
        this.bootstrapped.set(true);
    }

    protected toggleQueue(): void {
        this.store.queueOpen.update((v) => !v);
    }

    protected openSettings(): void {
        this.store.settingsOpen.set(true);
    }
}

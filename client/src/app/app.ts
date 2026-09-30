import { Component, effect, inject, signal } from '@angular/core';
import { ApiService } from './core/services/api';
import { FilesService } from './core/services/files';
import { SseService } from './core/services/sse';
import { StateStore } from './core/services/state-store';
import { ToastService } from './core/services/toast';
import { TabsBar } from './components/tabs-bar/tabs-bar';
import { ConnectionForm } from './components/connection-form/connection-form';
import { ScanPanel } from './components/scan-panel/scan-panel';
import { GalleryToolbar } from './components/gallery-toolbar/gallery-toolbar';
import { Gallery } from './components/gallery/gallery';
import { QueuePanel } from './components/queue-panel/queue-panel';
import { SettingsPage } from './components/settings-page/settings-page';

@Component({
    selector: 'app-root',
    imports: [TabsBar, ConnectionForm, ScanPanel, GalleryToolbar, Gallery, QueuePanel, SettingsPage],
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
        // FilesService перезагружает галерею при смене активной вкладки (effect).
        void this.bootstrap();
    }

    private async bootstrap(): Promise<void> {
        // Первичный снимок всех сессий, затем SSE.
        try {
            const { items } = await this.api.sessions();
            this.store.initSessions(items);
        } catch {
            /* сервер недоступен — SSE переподключится сам */
        }
        this.sse.connect({
            onSessions: (list) => this.store.applySessions(list),
            onScan: (sid, p) => this.store.applyScan(sid, p),
            onFound: (sid, files) => {
                const wasActive = this.store.activeSid() === sid;
                this.store.applyFound(sid, files);
                if (wasActive && this.store.autoRefresh()) void this.files.reloadAuto();
            },
            onQueue: (sid, q) => this.store.applyQueue(sid, q),
        });
        try {
            this.store.serverConfig.set(await this.api.config());
        } catch {
            /* конфигурация не критична — останутся дефолты */
        }
        // initSessions уже выбрал активную вкладку; галерею подгрузит effect
        // в FilesService (реагирует на смену activeSid).
        this.bootstrapped.set(true);
    }

    protected toggleQueue(): void {
        this.store.queueOpen.update((v) => !v);
    }

    protected openSettings(): void {
        this.store.settingsOpen.set(true);
    }
}

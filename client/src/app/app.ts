import { Component, DestroyRef, effect, inject, signal } from '@angular/core';
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
    private readonly destroyRef = inject(DestroyRef);
    protected readonly toasts = inject(ToastService);

    protected readonly storeRef = this.store;
    protected readonly bootstrapped = signal(false);

    constructor() {
        // FilesService перезагружает галерею при смене активной вкладки (effect).
        void this.bootstrap();

        // Клавиатурная навигация: Ctrl+←/→ — страница, Ctrl+↑/↓ — на 10 страниц,
        // Ctrl+Alt+←/→ — вкладка (по кругу). document-уровень: работает при любом фокусе.
        const onKeydown = (event: KeyboardEvent): void => this.handleKeydown(event);
        document.addEventListener('keydown', onKeydown);
        this.destroyRef.onDestroy(() => document.removeEventListener('keydown', onKeydown));
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

    // --- клавиатурная навигация (план: Ctrl+стрелки) ---

    /** Ctrl+←/→ — страница назад/вперёд; Ctrl+↑/↓ — на 10 страниц;
     *  Ctrl+Alt+←/→ — вкладка назад/вперёд (по кругу). */
    private handleKeydown(event: KeyboardEvent): void {
        if (!event.ctrlKey || event.shiftKey || event.metaKey) return;
        const target = event.target;
        if (
            target instanceof HTMLElement &&
            (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
        ) {
            return; // не мешаем навигации по тексту в полях ввода
        }
        let handled = true;
        if (event.altKey) {
            if (event.key === 'ArrowLeft') this.switchTab(-1);
            else if (event.key === 'ArrowRight') this.switchTab(1);
            else handled = false;
        } else {
            if (event.key === 'ArrowLeft') this.shiftPage(-1);
            else if (event.key === 'ArrowRight') this.shiftPage(1);
            else if (event.key === 'ArrowUp') this.shiftPage(10);
            else if (event.key === 'ArrowDown') this.shiftPage(-10);
            else handled = false;
        }
        if (handled) event.preventDefault();
    }

    /** Сдвиг страницы галереи с клампом к диапазону. */
    private shiftPage(delta: number): void {
        if (this.store.settingsOpen() || this.store.activeSid() === null) return;
        const target = Math.min(this.store.totalPages(), Math.max(1, this.store.page() + delta));
        if (target !== this.store.page()) void this.files.setPage(target);
    }

    /** Переключение вкладки по кругу (dir 1/-1); без активной — крайняя в направлении. */
    private switchTab(dir: 1 | -1): void {
        if (this.store.settingsOpen()) return;
        const order = this.store.sessionOrder();
        if (order.length === 0) return;
        const active = this.store.activeSid();
        const idx = active === null ? -1 : order.indexOf(active);
        if (idx === -1) {
            this.store.selectSession(dir === 1 ? order[0] : order[order.length - 1]);
            return;
        }
        this.store.selectSession(order[(idx + dir + order.length) % order.length] ?? null);
    }
}

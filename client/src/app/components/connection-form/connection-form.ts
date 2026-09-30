import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/services/api';
import { StateStore } from '../../core/services/state-store';
import { ToastService } from '../../core/services/toast';

/** Форма подключения нового Twonky-сервера (вкладка «＋»): создаёт сессию. */
@Component({
    selector: 'app-connection-form',
    imports: [FormsModule],
    templateUrl: './connection-form.html',
    styleUrl: './connection-form.scss',
})
export class ConnectionForm {
    private readonly api = inject(ApiService);
    private readonly store = inject(StateStore);
    private readonly toast = inject(ToastService);

    protected readonly url = signal('');
    protected readonly busy = signal(false);

    protected async connect(): Promise<void> {
        const raw = this.url().trim();
        if (raw === '' || this.busy()) return;
        this.busy.set(true);
        try {
            const summary = await this.api.createSession(raw);
            this.store.upsertSession(summary);
            this.store.selectSession(summary.id);
            this.toast.show('success', `Подключено: ${summary.connection?.host}:${summary.connection?.port}`);
            // Галерею новой вкладки подгрузит effect в FilesService (смена activeSid).
        } catch (err: unknown) {
            this.toast.show('error', err instanceof Error ? err.message : String(err));
        } finally {
            this.busy.set(false);
        }
    }
}

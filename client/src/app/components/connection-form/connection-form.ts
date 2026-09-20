import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/services/api';
import { StateStore } from '../../core/services/state-store';
import { ToastService } from '../../core/services/toast';

@Component({
    selector: 'app-connection-form',
    imports: [FormsModule],
    templateUrl: './connection-form.html',
    styleUrl: './connection-form.scss',
})
export class ConnectionForm {
    private readonly api = inject(ApiService);
    protected readonly store = inject(StateStore);
    private readonly toast = inject(ToastService);

    protected readonly url = signal('');
    protected readonly busy = signal(false);

    protected async connect(): Promise<void> {
        const raw = this.url().trim();
        if (raw === '' || this.busy()) return;
        this.busy.set(true);
        try {
            const r = await this.api.connect(raw);
            this.store.connection.set(r.connection);
            this.toast.show('success', 'Подключено');
        } catch (err: unknown) {
            this.toast.show('error', err instanceof Error ? err.message : String(err));
        } finally {
            this.busy.set(false);
        }
    }
}

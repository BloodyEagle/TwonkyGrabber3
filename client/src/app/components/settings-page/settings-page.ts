import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, type ConfigSnapshot, type Settings } from '../../core/services/api';
import { StateStore } from '../../core/services/state-store';
import { ToastService } from '../../core/services/toast';
import { CONFIG_GROUPS } from '../../core/config-meta';

type FormModel = Record<string, string>;

/** Страница настроек: параметры сервера (глобально), очередь активной сессии, env.
 *  Сброс состояния сессии перенесён в панель скана. */
@Component({
    selector: 'app-settings-page',
    imports: [FormsModule],
    templateUrl: './settings-page.html',
    styleUrl: './settings-page.scss',
})
export class SettingsPage {
    private readonly api = inject(ApiService);
    private readonly store = inject(StateStore);
    private readonly toast = inject(ToastService);

    /** Активная сессия — для шаблона (заголовок блока очереди). */
    protected readonly storeRef = this.store;

    protected readonly groups = CONFIG_GROUPS;
    protected readonly snapshot = signal<ConfigSnapshot | null>(null);
    protected readonly form = signal<FormModel>({});
    protected readonly thumbW = signal<FormModel>({});
    protected readonly thumbH = signal<FormModel>({});
    protected readonly settings = signal<Settings | null>(null);

    constructor() {
        void this.load();
    }

    protected readonly thumbKeys = computed(() => Object.keys(this.thumbW()));

    /** Настройки загрузчика применяются к активной сессии. */
    private sid(): string | null {
        return this.store.activeSid();
    }

    protected async load(): Promise<void> {
        const sid = this.sid();
        try {
            const snap = await this.api.config();
            this.snapshot.set(snap);
            this.store.serverConfig.set(snap);
            this.form.set(this.toForm(snap.values));
            const ts = snap.values['THUMB_SIZES'];
            const get = (key: string): [number, number] => {
                const v = ts[key];
                return [v?.[0] ?? 0, v?.[1] ?? 0];
            };
            const entries: Record<string, [number, number]> = { S: get('S'), M: get('M'), L: get('L'), XL: get('XL') };
            const w: FormModel = {};
            const h: FormModel = {};
            for (const [key, [vw, vh]] of Object.entries(entries)) {
                w[key] = String(vw);
                h[key] = String(vh);
            }
            this.thumbW.set(w);
            this.thumbH.set(h);
            if (sid !== null) this.settings.set(await this.api.settings(sid));
        } catch (err: unknown) {
            this.toast.show('error', err instanceof Error ? err.message : String(err));
        }
    }

    protected setField(key: string, value: string): void {
        this.form.update((f) => ({ ...f, [key]: value }));
    }

    protected setThumbW(key: string, value: string): void {
        this.thumbW.update((f) => ({ ...f, [key]: value }));
    }

    protected setThumbH(key: string, value: string): void {
        this.thumbH.update((f) => ({ ...f, [key]: value }));
    }

    protected isDefault(key: string): boolean {
        const snap = this.snapshot();
        const def = snap?.defaults as Record<string, unknown> | undefined;
        const val = snap?.values as Record<string, unknown> | undefined;
        if (def === undefined || val === undefined) return false;
        return JSON.stringify(def[key]) === JSON.stringify(val[key]);
    }

    protected async save(): Promise<void> {
        const patch: Record<string, unknown> = {};
        const values = this.snapshot()?.values as Record<string, unknown> | undefined;
        if (values === undefined) return;
        for (const [key, raw] of Object.entries(this.form())) {
            const current = values[key];
        const parsed =
            typeof current === 'number' ? this.parseIntOr(raw, NaN) : Array.isArray(current) ? this.parseList(raw) : raw.trim();
        if (JSON.stringify(parsed) !== JSON.stringify(current)) patch[key] = parsed;
    }
        const sizes: Record<string, [number, number]> = {};
        let sizesChanged = false;
        const serverSizes = this.snapshot()?.values.THUMB_SIZES ?? {};
        for (const key of this.thumbKeys()) {
            const w = this.parseIntOr(this.thumbW()[key] ?? '', NaN);
            const h = this.parseIntOr(this.thumbH()[key] ?? '', NaN);
            sizes[key] = [w, h];
            const before = serverSizes[key];
            if (before === undefined || before[0] !== w || before[1] !== h) sizesChanged = true;
        }
        if (sizesChanged) patch['THUMB_SIZES'] = sizes;
        if (Object.keys(patch).length === 0) {
            this.toast.show('info', 'Нет изменений');
            return;
        }
        try {
            const snap = await this.api.applyConfig(patch);
            this.snapshot.set(snap);
            this.store.serverConfig.set(snap);
            this.toast.show('success', 'Настройки сохранены');
        } catch (err: unknown) {
            this.toast.show('error', err instanceof Error ? err.message : String(err));
        }
    }

    protected async resetDefaults(): Promise<void> {
        const defaults = this.snapshot()?.defaults;
        if (defaults === undefined) return;
        try {
            const snap = await this.api.applyConfig({ ...defaults });
            this.snapshot.set(snap);
            this.store.serverConfig.set(snap);
            this.form.set(this.toForm(snap.values));
            this.toast.show('success', 'Значения по умолчанию восстановлены');
        } catch (err: unknown) {
            this.toast.show('error', err instanceof Error ? err.message : String(err));
        }
    }

    protected async toggleAutoAll(event: Event): Promise<void> {
        await this.applySettings({ autoAll: (event.target as HTMLInputElement).checked });
    }

    protected async modeChange(event: Event): Promise<void> {
        const checked = (event.target as HTMLInputElement).checked;
        await this.applySettings({ threadsMode: checked ? 'auto' : 'manual' });
    }

    protected async threadsChange(event: Event): Promise<void> {
        const value = Number.parseInt((event.target as HTMLInputElement).value, 10);
        if (Number.isFinite(value)) await this.applySettings({ threadsValue: value });
    }

    protected defaultValue(key: string): string {
        const def = this.snapshot()?.defaults as Record<string, unknown> | undefined;
        if (def === undefined || !(key in def)) return '—';
        const v = def[key];
        return Array.isArray(v) ? v.join(',') : String(v);
    }

    protected back(): void {
        this.store.settingsOpen.set(false);
    }

    private async applySettings(patch: Partial<Pick<Settings, 'threadsMode' | 'threadsValue' | 'autoAll'>>): Promise<void> {
        const sid = this.sid();
        if (sid === null) return;
        try {
            this.settings.set(await this.api.applySettings(sid, patch));
        } catch (err: unknown) {
            this.toast.show('error', err instanceof Error ? err.message : String(err));
        }
    }

    private parseIntOr(raw: string, fallback: number): number {
        const n = Number.parseInt(raw.trim(), 10);
        return Number.isFinite(n) ? n : fallback;
    }

    private parseList(raw: string): number[] {
        return raw.split(',').map((s) => this.parseIntOr(s, -1));
    }

    private toForm(values: object): FormModel {
        const out: FormModel = {};
        for (const [key, value] of Object.entries(values)) {
            if (key === 'THUMB_SIZES') continue;
            out[key] = Array.isArray(value) ? value.join(',') : String(value);
        }
        return out;
    }
}

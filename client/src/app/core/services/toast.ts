import { Injectable, signal } from '@angular/core';

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
    id: number;
    kind: ToastKind;
    text: string;
}

/** Тосты (§13.5): правый нижний угол, автоскрытие 4 с (ошибки — 8 с). */
@Injectable({ providedIn: 'root' })
export class ToastService {
    private nextId = 1;

    readonly toasts = signal<Toast[]>([]);

    show(kind: ToastKind, text: string): void {
        const id = this.nextId;
        this.nextId += 1;
        this.toasts.update((list) => [...list, { id, kind, text }]);
        const ttl = kind === 'error' ? 8_000 : 4_000;
        setTimeout(() => this.dismiss(id), ttl);
    }

    dismiss(id: number): void {
        this.toasts.update((list) => list.filter((t) => t.id !== id));
    }
}

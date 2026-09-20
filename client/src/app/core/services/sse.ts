import { Injectable } from '@angular/core';
import type { FoundFile, QueueState, ScanProgress } from './api';

interface SseHandlers {
    onScan: (progress: ScanProgress) => void;
    onFound: (files: FoundFile[]) => void;
    onQueue: (state: QueueState) => void;
}

/** SSE-подключение /api/events: снимок при подключении, автопереподключение EventSource. */
@Injectable({ providedIn: 'root' })
export class SseService {
    private source: EventSource | null = null;

    connect(handlers: SseHandlers): void {
        this.disconnect();
        const es = new EventSource('/api/events');
        this.source = es;
        es.addEventListener('scan', (ev) => handlers.onScan(this.parse<ScanProgress>(ev)));
        es.addEventListener('found', (ev) => {
            const files = this.parse<FoundFile[]>(ev);
            if (files.length > 0) handlers.onFound(files);
        });
        es.addEventListener('queue', (ev) => handlers.onQueue(this.parse<QueueState>(ev)));
    }

    disconnect(): void {
        if (this.source !== null) {
            this.source.close();
            this.source = null;
        }
    }

    private parse<T>(ev: Event): T {
        return JSON.parse((ev as MessageEvent<string>).data) as T;
    }
}

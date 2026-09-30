import { Injectable } from '@angular/core';
import type { FoundFile, QueueState, ScanProgress, SessionSummary } from './api';

interface SseHandlers {
    /** Список сессий изменился (создание/удаление вкладки, тик скана). */
    onSessions: (list: Pick<SessionSummary, 'id' | 'dir'>[]) => void;
    onScan: (sid: string, progress: ScanProgress) => void;
    onFound: (sid: string, files: FoundFile[]) => void;
    onQueue: (sid: string, state: QueueState) => void;
}

/** SSE-подключение /api/events: снимок при подключении, автопереподключение EventSource.
 *  Все события несут sid сессии (мульти-серверность). */
@Injectable({ providedIn: 'root' })
export class SseService {
    private source: EventSource | null = null;

    connect(handlers: SseHandlers): void {
        this.disconnect();
        const es = new EventSource('/api/events');
        this.source = es;
        es.addEventListener('sessions', (ev) => {
            handlers.onSessions(this.parse<Pick<SessionSummary, 'id' | 'dir'>[]>(ev));
        });
        es.addEventListener('scan', (ev) => {
            const payload = this.parse<{ sid: string } & ScanProgress>(ev);
            const { sid, ...progress } = payload;
            handlers.onScan(sid, progress);
        });
        es.addEventListener('found', (ev) => {
            const payload = this.parse<{ sid: string; files: FoundFile[] }>(ev);
            if (payload.files.length > 0) handlers.onFound(payload.sid, payload.files);
        });
        es.addEventListener('queue', (ev) => {
            const payload = this.parse<{ sid: string } & QueueState>(ev);
            const { sid, ...state } = payload;
            handlers.onQueue(sid, state);
        });
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

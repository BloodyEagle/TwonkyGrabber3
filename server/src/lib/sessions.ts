/**
 * Менеджер сессий: параллельное исследование нескольких Twonky-серверов.
 *
 * Сессия = одно подключение + собственные сканер и загрузчик. Скачивания каждой
 * сессии пишутся в свой подкаталог DOWNLOAD_DIR/<host>_<port>: файлы разных
 * серверов не конфликтуют, а повторное подключение к тому же серверу видит уже
 * скачанное (дедуп по размеру в загрузчике).
 *
 * Создание/удаление сессии оповещает подписчиков (SSE-хаб); находки проксируются
 * в подписчиков сразу после загрузчика (чтобы autoAll сработал первым).
 */
import { join } from 'node:path';
import { DOWNLOAD_DIR, MAX_SESSIONS } from '../config';
import { Downloader, createNodeDownloaderDeps } from './downloader';
import { probeUrl } from './probe';
import { Scanner } from './scanner';
import type { Prober } from './scanner';
import { fileUrl } from './url-parser';
import type { FoundFile, TwonkyConnection } from './types';

/** Одна вкладка сервера: подключение + сканер + очередь скачивания. */
export interface Session {
    readonly id: string;
    /** Подкаталог загрузок внутри DOWNLOAD_DIR (без пути к корню). */
    readonly dir: string;
    readonly scanner: Scanner;
    readonly downloader: Downloader;
    readonly createdAt: number;
}

/** Имя подкаталога: непригодные для файловой системы символы → «_». */
export function sanitizeDirName(name: string): string {
    const safe = name.replace(/[^a-zA-Z0-9._-]+/g, '_');
    return safe === '' || safe === '_' || safe === '__' ? 'server' : safe;
}

/** Имя подкаталога загрузок для подключения: host_port. */
export function sessionDir(connection: TwonkyConnection | null): string {
    if (connection === null) return 'server';
    return sanitizeDirName(`${connection.host}_${connection.port}`);
}

/**
 * Реестр активных сессий. Идентификаторы — числовые строки («1», «2», …),
 * счётчик персистентится в state.json (nextSessionId).
 */
export class SessionManager {
    private readonly sessions = new Map<string, Session>();
    private readonly foundSinks: Array<(session: Session, files: FoundFile[]) => void> = [];
    private readonly changeSinks: Array<() => void> = [];
    private nextId = 1;

    constructor(private readonly downloadRoot: string = DOWNLOAD_DIR) {}

    count(): number {
        return this.sessions.size;
    }

    list(): Session[] {
        return [...this.sessions.values()];
    }

    get(id: string): Session | null {
        return this.sessions.get(id) ?? null;
    }

    peekNextId(): number {
        return this.nextId;
    }

    /** Установка счётчика id при восстановлении состояния. */
    setNextId(value: number): void {
        if (Number.isFinite(value) && value >= 1) this.nextId = Math.floor(value);
    }

    /** Страховка: nextId строго больше любого существующего числового id. */
    bumpNextId(usedIds: readonly string[]): void {
        for (const id of usedIds) {
            const n = Number.parseInt(id, 10);
            if (Number.isFinite(n)) this.nextId = Math.max(this.nextId, n + 1);
        }
    }

    addOnFound(sink: (session: Session, files: FoundFile[]) => void): void {
        this.foundSinks.push(sink);
    }

    addOnChange(sink: () => void): void {
        this.changeSinks.push(sink);
    }

    /**
     * Новая сессия. opts.id/dir задаются при восстановлении состояния
     * (лимит MAX_SESSIONS тогда не проверяется — нельзя потерять серверы
     * из-за урезания лимита после рестарта).
     */
    create(
        connection: TwonkyConnection | null,
        opts: { id?: string; dir?: string } = {},
    ): Session {
        const id = opts.id ?? String(this.nextId);
        if (this.sessions.has(id)) throw new Error(`Сессия ${id} уже существует`);
        if (opts.id === undefined) {
            if (this.sessions.size >= MAX_SESSIONS) {
                throw new Error(`Достигнут предел серверов (${MAX_SESSIONS}) — закройте лишние вкладки`);
            }
            this.nextId += 1;
        }

        // Пробер строит URL от подключения своей сессии (связывание после создания,
        // чтобы избежать циклической ссылки в инициализаторе).
        let scannerRef: Scanner | null = null;
        const prober: Prober = {
            probe: (number) => {
                const conn = scannerRef?.getConnection() ?? null;
                if (conn === null) {
                    return Promise.resolve({
                        kind: 'neterr' as const,
                        media: null,
                        contentType: null,
                        size: null,
                        detail: 'нет подключения',
                    });
                }
                return probeUrl(fileUrl(conn, number));
            },
        };

        const scanner = new Scanner(prober);
        scannerRef = scanner;
        if (connection !== null) scanner.setConnection(connection);

        const dir = opts.dir ?? sessionDir(connection);
        const downloader = new Downloader(createNodeDownloaderDeps(join(this.downloadRoot, dir)), scanner);

        const session: Session = { id, dir, scanner, downloader, createdAt: Date.now() };
        // Порядок важен: сначала загрузчик (autoAll), затем SSE-подписчики.
        scanner.addOnFound((files) => {
            downloader.handleFound(files);
            for (const sink of this.foundSinks) sink(session, files);
        });

        this.sessions.set(id, session);
        this.emitChange();
        return session;
    }

    /** Удаление сессии: скан останавливается, очередь очищается, файлы на диске остаются. */
    remove(id: string): boolean {
        const session = this.sessions.get(id);
        if (session === undefined) return false;
        session.scanner.reset();
        session.downloader.resetQueue();
        session.downloader.dispose();
        this.sessions.delete(id);
        this.emitChange();
        return true;
    }

    private emitChange(): void {
        for (const sink of this.changeSinks) sink();
    }
}

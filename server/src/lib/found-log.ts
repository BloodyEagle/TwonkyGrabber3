/**
 * Append-only лог находок (plan §15, №1).
 *
 * Находки — append-only данные: файл, однажды найденный, не меняется. Хранить их
 * в state.json и переписывать целиком каждые 5 с (O(n) stringify + rename) — дорого
 * и блокирует event loop. Здесь находки дописываются построчно (JSONL) в отдельный
 * файл `found-<sessionId>.jsonl` по мере поступления, а state.json остаётся маленьким.
 *
 * Запись буферизуется и сбрасывается раз в автосейв; при обрыве последней строки
 * (краш во время append) неполная строка отбрасывается при загрузке.
 */
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { FoundFile } from './types';

export class FoundLog {
    private readonly buffers = new Map<string, FoundFile[]>();

    constructor(private readonly dir: string) {}

    private file(sessionId: string): string {
        return join(this.dir, `found-${sessionId}.jsonl`);
    }

    /** Поставить находки в буфер (допишутся на следующем flush). */
    append(sessionId: string, files: FoundFile[]): void {
        const buffer = this.buffers.get(sessionId) ?? [];
        buffer.push(...files);
        this.buffers.set(sessionId, buffer);
    }

    /** Сбросить буфер одной сессии или всех. */
    async flush(sessionId?: string): Promise<void> {
        if (sessionId !== undefined) {
            await this.flushOne(sessionId);
            return;
        }
        for (const id of [...this.buffers.keys()]) {
            await this.flushOne(id);
        }
    }

    private async flushOne(sessionId: string): Promise<void> {
        const buffer = this.buffers.get(sessionId);
        if (buffer === undefined || buffer.length === 0) return;
        // Снимок и очистка сразу: новые находки уйдут в новый массив во время await.
        this.buffers.delete(sessionId);
        const snapshot = buffer.splice(0, buffer.length);
        if (snapshot.length === 0) return;
        await mkdir(this.dir, { recursive: true });
        const data = `${snapshot.map((f) => JSON.stringify(f)).join('\n')}\n`;
        try {
            await appendFile(this.file(sessionId), data, 'utf8');
        } catch (err) {
            // Ошибка диска: возвращаем находки в буфер (повторная попытка на следующем flush).
            const existing = this.buffers.get(sessionId) ?? [];
            this.buffers.set(sessionId, [...existing, ...snapshot]);
            throw err;
        }
    }

    /** Прочитать все находки сессии (неполная последняя строка игнорируется). */
    async load(sessionId: string): Promise<FoundFile[]> {
        let raw: string;
        try {
            raw = await readFile(this.file(sessionId), 'utf8');
        } catch {
            return [];
        }
        const out: FoundFile[] = [];
        for (const line of raw.split('\n')) {
            if (line.trim() === '') continue;
            try {
                out.push(JSON.parse(line) as FoundFile);
            } catch {
                /* неполная строка при краше — отбрасываем */
            }
        }
        return out;
    }

    /** Удалить лог сессии (при закрытии вкладки). */
    async remove(sessionId: string): Promise<void> {
        this.buffers.delete(sessionId);
        try {
            await rm(this.file(sessionId), { force: true });
        } catch {
            /* файла нет — ок */
        }
    }
}

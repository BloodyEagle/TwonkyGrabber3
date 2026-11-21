/**
 * Дисковый учёт проверенных номеров: файл `probed-<sessionId>.bin` (битмап
 * VisitedBitmap). Переживает «Начать скан» и рестарт сервера — дозапуск скана
 * пробует только непроверенные номера. Записи сериализуются цепочкой
 * (конкурентные rename одного tmp-имени запрещены), сохранение — только при
 * изменениях (dirty).
 */
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export class ProbedLog {
    /** Цепочки записи по сессиям: атомарный tmp+rename не должен конкурировать. */
    private readonly chains = new Map<string, Promise<void>>();

    constructor(private readonly dir: string) {}

    private file(sessionId: string): string {
        return join(this.dir, `probed-${sessionId}.bin`);
    }

    /** Прочитать учёт сессии (null — файла нет: старая сессия или первая). */
    async load(sessionId: string): Promise<Uint8Array | null> {
        try {
            return new Uint8Array(await readFile(this.file(sessionId)));
        } catch {
            return null;
        }
    }

    /** Записать учёт сессии (tmp + rename); вызовы одной сессии сериализуются. */
    save(sessionId: string, bytes: Uint8Array): Promise<void> {
        const done = (this.chains.get(sessionId) ?? Promise.resolve()).then(() =>
            this.saveNow(sessionId, bytes),
        );
        // Ошибка одной записи не должна рвать цепочку последующих.
        this.chains.set(
            sessionId,
            done.catch(() => undefined),
        );
        return done;
    }

    private async saveNow(sessionId: string, bytes: Uint8Array): Promise<void> {
        const target = this.file(sessionId);
        const tmp = `${target}.tmp`;
        await writeFile(tmp, bytes);
        await rename(tmp, target);
    }

    /** Удалить учёт сессии (при закрытии вкладки и полном сбросе учёта). */
    remove(sessionId: string): Promise<void> {
        const done = (this.chains.get(sessionId) ?? Promise.resolve()).then(() =>
            rm(this.file(sessionId), { force: true }),
        );
        this.chains.set(
            sessionId,
            done.catch(() => undefined),
        );
        return done;
    }
}

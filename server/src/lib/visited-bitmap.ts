/**
 * Персистентный учёт проверенных номеров (битмап 0..MAX_NUMBER).
 *
 * Заменяет visited-Set сканера: 10 млн номеров — это ~1.25 МБ, поэтому память
 * о каждой пробе переживает «Начать скан» и перезапуск сервера. Дозапуск
 * пробует только непроверенные номера; полный сброс сканера (reset) стирает
 * учёт — это осознанный путь к рескану с нуля. Сохранение на диск — через
 * ProbedLog (probed-<sessionId>.bin в каталоге данных).
 */
import { C } from '../config';

const BYTE_COUNT = Math.floor(C.MAX_NUMBER / 8) + 1;
/** Таблица popcount — быстрый пересчёт счётчика при загрузке файла. */
const POPCOUNT = new Uint8Array(256);
for (let i = 0; i < 256; i += 1) {
    let bits = 0;
    for (let b = i; b !== 0; b >>= 1) {
        if ((b & 1) !== 0) bits += 1;
    }
    POPCOUNT[i] = bits;
}

export class VisitedBitmap {
    private readonly bytes = new Uint8Array(BYTE_COUNT);
    private dirty = false;
    private counted = 0;

    has(n: number): boolean {
        if (n < 0 || n > C.MAX_NUMBER) return false;
        const b = this.bytes[n >> 3] ?? 0;
        return (b & (1 << (n & 7))) !== 0;
    }

    add(n: number): void {
        if (n < 0 || n > C.MAX_NUMBER) return;
        const mask = 1 << (n & 7);
        const cell = n >> 3;
        const b = this.bytes[cell] ?? 0;
        if ((b & mask) === 0) {
            this.bytes[cell] = b | mask;
            this.counted += 1;
            this.dirty = true;
        }
    }

    /** Снять отметку (сетевой сбой — проба не состоялась, номер вернётся в очередь). */
    delete(n: number): void {
        if (n < 0 || n > C.MAX_NUMBER) return;
        const mask = 1 << (n & 7);
        const cell = n >> 3;
        const b = this.bytes[cell] ?? 0;
        if ((b & mask) !== 0) {
            this.bytes[cell] = b & ~mask;
            this.counted -= 1;
            this.dirty = true;
        }
    }

    clear(): void {
        this.bytes.fill(0);
        this.counted = 0;
        this.dirty = true;
    }

    /** Число отмеченных номеров (инкрементальный счётчик — O(1)). */
    count(): number {
        return this.counted;
    }

    /** Были ли изменения с последней записи на диск. */
    isDirty(): boolean {
        return this.dirty;
    }

    markSaved(): void {
        this.dirty = false;
    }

    /** Снимок для записи на диск (копия — безопасная асинхронная запись). */
    serialize(): Uint8Array {
        return this.bytes.slice();
    }

    /** Загрузить байты файла; неверный размер — учёт остаётся пустым, false. */
    load(data: Uint8Array): boolean {
        if (data.length !== BYTE_COUNT) return false;
        this.bytes.set(data);
        let total = 0;
        for (const b of this.bytes) total += POPCOUNT[b] ?? 0;
        this.counted = total;
        this.dirty = false;
        return true;
    }
}

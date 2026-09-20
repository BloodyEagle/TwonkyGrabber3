/** Форматирование чисел и размеров для UI (§13.1: разряды, КБ/МБ/ГБ, МБ/с). */

export function formatNumber(value: number | undefined | null): string {
    return (value ?? 0).toLocaleString('ru-RU');
}

export function formatSize(bytes: number | undefined | null): string {
    const b = bytes ?? 0;
    if (b < 1024) return `${b} Б`;
    const units = ['КБ', 'МБ', 'ГБ', 'ТБ'];
    let v = b;
    let i = -1;
    do {
        v /= 1024;
        i += 1;
    } while (v >= 1024 && i < units.length - 1);
    return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatSpeed(bytesPerSec: number | undefined | null): string {
    if ((bytesPerSec ?? 0) <= 0) return '0 МБ/с';
    return `${((bytesPerSec ?? 0) / 1_048_576).toFixed(1)} МБ/с`;
}

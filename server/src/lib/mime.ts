/**
 * Карта mime-типов → расширения файлов (план, п.6: unknown → bin).
 * Используется сканером (FoundFile.name) и загрузчиком (имя файла на диске).
 */

const MIME_TO_EXT: Readonly<Record<string, string>> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'image/tiff': 'tiff',
    'image/avif': 'avif',
    'image/x-ms-bmp': 'bmp',
    'image/x-icon': 'ico',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/x-msvideo': 'avi',
    'video/x-matroska': 'mkv',
    'video/webm': 'webm',
    'video/mpeg': 'mpg',
    'video/3gpp': '3gp',
};

/** Расширение для content-type (без параметров); неизвестное → 'bin'. */
export function mimeToExt(contentType: string): string {
    const base = contentType.toLowerCase().split(';')[0]?.trim() ?? '';
    return MIME_TO_EXT[base] ?? 'bin';
}

/** Имя файла: хвост URL (префикс + номер) + расширение из content-type. */
export function buildFileName(tail: string, contentType: string): string {
    return `${tail}.${mimeToExt(contentType)}`;
}

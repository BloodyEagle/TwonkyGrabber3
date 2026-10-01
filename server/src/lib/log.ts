/**
 * Минимальный логгер сервера: обёртка над console с единым форматом.
 * Ошибки/предупреждения пишутся в stderr/stdout процесса (plan §Bugs, п.4).
 * Контекст — короткий идентификатор модуля/операции (напр. 'scan', 'download', 'stats').
 */

function timestamp(): string {
    return new Date().toISOString();
}

/** Ошибка с контекстом и (опционально) стеком исключения. */
export function logError(context: string, message: string, err?: unknown): void {
    const detail =
        err === undefined || err === null ? '' : ` — ${err instanceof Error ? err.stack ?? err.message : String(err)}`;
    console.error(`[${timestamp()}] [error] [${context}] ${message}${detail}`);
}

/** Предупреждение (не фатальное, но требующее внимания). */
export function logWarn(context: string, message: string): void {
    console.warn(`[${timestamp()}] [warn] [${context}] ${message}`);
}

/** Информационное сообщение о значимом переходе состояния. */
export function logInfo(context: string, message: string): void {
    console.log(`[${timestamp()}] [info] [${context}] ${message}`);
}

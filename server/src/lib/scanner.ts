/**
 * Сканер Twonky (план, п.5).
 *
 * Жизненный цикл: start() → разведка (detect) → руки (arms) → done.
 * Руки делят общий семафор C.PROBE_CONCURRENCY; глобальный visited-сет исключает
 * повторные пробы и дубли находок. Фазы руки: scan | gapfill | sparse.
 *
 * Зависимость Prober внедряется — в юнит-тестах подставляется мок (сеть запрещена).
 */
import { C } from '../config';
import { buildFileName } from './mime';
import { fileUrl } from './url-parser';
import { probePool } from './pool';
import { logWarn } from './log';
import type { Arm, ArmDir, FoundFile, ScanMode, ScanProgress, ScanStatus, TwonkyConnection } from './types';
import type { ProbeResult } from './probe';
import type { ServerStats } from './server-stats';

/** Пробер по номеру файла (интерфейс для моков в тестах). */
export interface Prober {
    probe(number: number): Promise<ProbeResult>;
}

/** Персистентное состояние сканера (план, п.5.10). */
export interface PersistedScanState {
    connection: TwonkyConnection;
    status: ScanStatus;
    mode: ScanMode;
    probed: number;
    arms: Arm[];
    /** Находки (опционально: в state.json не пишутся — хранятся в found-<id>.jsonl). */
    found?: FoundFile[];
}

/** Позиция, запланированная на пробу в батче. */
interface BatchItem {
    number: number;
    /** Проба из очереди плотного прохода — не влияет на missStreak. */
    fromSweep: boolean;
    arm: Arm;
}

/** Шаг разреженного поиска: случайный из [C.SPARSE_MIN..C.SPARSE_MAX], в delta — кратный шагу. */
function sparseStep(step: number): number {
    const raw = C.SPARSE_MIN + Math.floor(Math.random() * (C.SPARSE_MAX - C.SPARSE_MIN + 1));
    if (step <= 1) return raw;
    const rounded = Math.round(raw / step) * step;
    return Math.max(step, rounded);
}

function outOfRange(n: number): boolean {
    return n < 0 || n > C.MAX_NUMBER;
}

/** Чтение состояния руки через функцию снимает ложное сужение типа в цикле runArm. */
function isStopped(arm: Arm): boolean {
    return arm.state === 'stopped';
}

/**
 * Сканер: управляет разведкой, руками и находками.
 * Все публичные методы безопасны для вызова из Express-обработчиков.
 */
export class Scanner {
    private connection: TwonkyConnection | null = null;
    private status: ScanStatus = 'idle';
    private reason: string | null = null;
    private mode: ScanMode = null;
    private probed = 0;
    private arms: Arm[] = [];
    private readonly visited = new Set<number>();
    private readonly foundMap = new Map<number, FoundFile>();
    /** Инкрементные счётчики типов (чтобы progress() не итерировал весь foundMap). */
    private foundImagesCount = 0;
    private foundVideosCount = 0;
    /** Кэш отсортированного списка находок; null — требуется пересортировка. */
    private sortedFoundCache: FoundFile[] | null = null;
    private neterrStreak = 0;
    /** Инкрементируется в reset — живые циклы рук/разведки прерываются. */
    private generation = 0;
    /** Циклы рук уже запущены (false после reset/restore — resume должен перезапустить их). */
    private armLoopsRunning = false;
    private pausedFlag = false;
    private resumeWaiters: Array<() => void> = [];
    private readonly foundSinks: Array<(files: FoundFile[]) => void> = [];
    private probeTimestamps: number[] = [];

    constructor(private readonly prober: Prober) {}

    /** Приёмник находок: SSE-хаб (батчи для фронта) и загрузчик (autoAll). */
    addOnFound(sink: (files: FoundFile[]) => void): void {
        this.foundSinks.push(sink);
    }

    private emitFound(files: FoundFile[]): void {
        for (const sink of this.foundSinks) sink(files);
        this.checkStatsDone();
    }

    /** Точные счётчики сервера (/rpc/info_status); останавливает скан при полном наборе. */
    setServerTotals(stats: ServerStats | null): void {
        this.serverTotals = stats;
        this.checkStatsDone();
    }

    private serverTotals: ServerStats | null = null;

    /** Досрочное завершение: найдены все файлы по статистике сервера. */
    private checkStatsDone(): void {
        if (this.serverTotals === null) return;
        if (this.status !== 'detecting' && this.status !== 'scanning') return;
        const target = this.serverTotals.pictures + this.serverTotals.videos;
        if (target <= 0 || this.mediaFoundCount() < target) return;
        this.generation += 1;
        this.pausedFlag = false;
        const waiters = this.resumeWaiters;
        this.resumeWaiters = [];
        for (const w of waiters) w();
        for (const arm of this.arms) arm.state = 'stopped';
        this.status = 'done';
        this.reason = `Найдены все файлы по статистике сервера (фото ${this.serverTotals.pictures}, видео ${this.serverTotals.videos})`;
    }

    /** Число найденных image/video (музыку сканер не ищет). */
    private mediaFoundCount(): number {
        const { images, videos } = this.mediaCounts();
        return images + videos;
    }

    /** Счётчики найденных фото/видео (инкрементальные поля). */
    private mediaCounts(): { images: number; videos: number } {
        return { images: this.foundImagesCount, videos: this.foundVideosCount };
    }

    getConnection(): TwonkyConnection | null {
        return this.connection;
    }

    /** Установить/заменить подключение без запуска скана (после /api/connect). */
    setConnection(connection: TwonkyConnection | null): void {
        this.connection = connection;
    }

    /** Текущий прогресс для фронта. */
    progress(): ScanProgress {
        const foundImages = this.foundImagesCount;
        const foundVideos = this.foundVideosCount;
        return {
            status: this.status,
            reason: this.reason,
            mode: this.mode,
            connection: this.connection,
            probed: this.probed,
            found: this.foundMap.size,
            foundImages,
            foundVideos,
            eps: this.eps(),
            stats: this.serverTotals,
            epoch: this.epochValue,
            arms: this.arms.map((a) => ({
                dir: a.dir,
                pos: a.pos,
                step: a.step,
                phase: a.phase,
                state: a.state,
                foundCount: a.foundCount,
            })),
        };
    }

    /** Найденные файлы, отсортированные по номеру (кэш, пересобирается при новых находках). */
    foundList(): FoundFile[] {
        if (this.sortedFoundCache === null) {
            this.sortedFoundCache = [...this.foundMap.values()].sort((a, b) => a.number - b.number);
        }
        return this.sortedFoundCache;
    }

    /** Найденный файл по номеру (для постановки в очередь скачивания). */
    getFound(number: number): FoundFile | null {
        return this.foundMap.get(number) ?? null;
    }

    /** Запуск скана; при paused — возобновление. */
    start(connection: TwonkyConnection): void {
        if (this.status === 'detecting' || this.status === 'scanning') return;
        if (this.status === 'paused') {
            this.resume();
            return;
        }
        this.connection = connection;
        this.beginDetect();
    }

    /** Остановка (пауза): руки замораживаются, продолжение — start()/resume(). */
    stop(): void {
        if (this.status !== 'detecting' && this.status !== 'scanning') return;
        this.pausedFlag = true;
        this.status = 'paused';
        this.reason = 'Остановлено пользователем';
    }

    /** Возобновление после паузы. */
    resume(): void {
        if (this.status !== 'paused') return;
        this.pausedFlag = false;
        this.neterrStreak = 0;
        this.reason = null;
        if (this.arms.length > 0) {
            this.status = 'scanning';
            this.startArmLoops();
        } else if (this.lastDetectStart !== null) {
            // Пауза во время разведки после находки поиска — продолжаем от неё,
            // найденные файлы станут якорями (foundMap учитывается в detect).
            this.status = 'detecting';
            const startN = this.lastDetectStart;
            const conn = this.connection;
            if (conn !== null) {
                const gen = this.generation;
                void this.detect(gen, conn, startN).catch((err: unknown) => {
                    this.status = 'error';
                    this.reason = `Ошибка разведки: ${err instanceof Error ? err.message : String(err)}`;
                });
            }
        } else {
            // Пауза случилась до создания рук — разведку начинаем заново.
            this.status = 'detecting';
            this.beginDetect();
        }
        const waiters = this.resumeWaiters;
        this.resumeWaiters = [];
        for (const w of waiters) w();
    }

    /** Старт последней разведки (для возобновления после паузы). */
    private lastDetectStart: number | null = null;

    /** Полный сброс сканера (находки тоже очищаются). */
    reset(): void {
        this.generation += 1;
        this.epochValue += 1;
        this.pausedFlag = false;
        const waiters = this.resumeWaiters;
        this.resumeWaiters = [];
        for (const w of waiters) w();
        this.connection = null;
        this.status = 'idle';
        this.reason = null;
        this.mode = null;
        this.probed = 0;
        this.arms = [];
        this.lastDetectStart = null;
        this.visited.clear();
        this.foundMap.clear();
        this.foundImagesCount = 0;
        this.foundVideosCount = 0;
        this.sortedFoundCache = null;
        this.neterrStreak = 0;
        this.probeTimestamps = [];
        this.armLoopsRunning = false;
    }

    /** Эпоха библиотеки: инкремент при сбросе — фронт вешает её на URL превью,
     *  чтобы браузерный кэш не показывал картинки прошлой библиотеки. */
    private epochValue = 0;

    epoch(): number {
        return this.epochValue;
    }

    /** Сериализация для персистентности (M3). */
    serialize(): PersistedScanState | null {
        if (this.connection === null) return null;
        return {
            connection: this.connection,
            status: this.status,
            mode: this.mode,
            probed: this.probed,
            arms: this.arms.map((a) => ({ ...a, sweepQueue: [...a.sweepQueue] })),
            found: this.foundList(),
        };
    }

    /** Метаданные скана без находок (пишутся в state.json; находки — отдельным JSONL). */
    serializeMeta(): Omit<PersistedScanState, 'found'> | null {
        if (this.connection === null) return null;
        return {
            connection: this.connection,
            status: this.status,
            mode: this.mode,
            probed: this.probed,
            arms: this.arms.map((a) => ({ ...a, sweepQueue: [...a.sweepQueue] })),
        };
    }

    /**
     * Восстановление после рестарта. Возвращает wasRunning: скан/разведка были активны.
     * Активный статус переводится в paused — автопродолжение решает владелец (M3).
     */
    restore(state: PersistedScanState): boolean {
        this.reset();
        this.connection = state.connection;
        this.mode = state.mode;
        this.probed = state.probed;
        this.arms = state.arms.map((a) => ({ ...a, sweepQueue: [...a.sweepQueue] }));
        for (const f of state.found ?? []) {
            this.foundMap.set(f.number, f);
            if (f.kind === 'image') this.foundImagesCount += 1;
            else if (f.kind === 'video') this.foundVideosCount += 1;
        }
        const wasRunning = state.status === 'scanning' || state.status === 'detecting';
        this.status = wasRunning ? 'paused' : state.status;
        this.reason = wasRunning ? 'Остановлено перезапуском сервера' : null;
        // visited не сохраняется (план) — повторные пробои после рестарта допустимы.
        return wasRunning;
    }

    /** Заполнить находки после restore из внешнего источника (found-<id>.jsonl). */
    restoreFound(found: FoundFile[]): void {
        for (const f of found) {
            if (this.foundMap.has(f.number)) continue;
            this.foundMap.set(f.number, f);
            if (f.kind === 'image') this.foundImagesCount += 1;
            else if (f.kind === 'video') this.foundVideosCount += 1;
        }
        this.sortedFoundCache = null;
    }

    // --- внутреннее ---

    private eps(): number {
        const now = Date.now();
        const cutoff = now - C.EPS_WINDOW_MS;
        while (this.probeTimestamps.length > 0 && (this.probeTimestamps[0] ?? 0) < cutoff) {
            this.probeTimestamps.shift();
        }
        return this.probeTimestamps.length / (C.EPS_WINDOW_MS / 1000);
    }

    /** Ожидание паузы; false — цикл должен прерваться (reset). */
    private async waitGate(gen: number): Promise<boolean> {
        while (this.pausedFlag) {
            if (gen !== this.generation) return false;
            await new Promise<void>((resolve) => this.resumeWaiters.push(resolve));
        }
        return gen === this.generation;
    }

    private pauseNeterr(): void {
        this.pausedFlag = true;
        this.status = 'paused';
        this.reason = 'Сетевые ошибки: сервер не отвечает. Продолжите вручную';
    }

    private beginDetect(): void {
        const gen = this.generation;
        this.status = 'detecting';
        this.reason = null;
        this.mode = null;
        this.probed = 0;
        this.neterrStreak = 0;
        this.arms = [];
        this.visited.clear();
        this.probeTimestamps = [];
        const conn = this.connection;
        if (conn === null) return;
        // Запоминаем точку старта разведки — resume() продолжит с неё, а не перезапустит заново.
        this.lastDetectStart = conn.startNumber;
        void this.detect(gen, conn).catch((err: unknown) => {
            this.status = 'error';
            this.reason = `Ошибка разведки: ${err instanceof Error ? err.message : String(err)}`;
        });
    }

    /** Разведка блока start..start+C.DETECT_BLOCK-1 (startN — точка старта). */
    private async detect(gen: number, conn: TwonkyConnection, startN: number = conn.startNumber): Promise<void> {
        const foundNumbers: number[] = [];
        let anyResponse = false;

        for (let base = 0; base < C.DETECT_BLOCK; base += C.PROBE_BATCH) {
            if (!(await this.waitGate(gen))) return;

            const items: number[] = [];
            for (let k = 0; k < C.PROBE_BATCH && base + k < C.DETECT_BLOCK; k += 1) {
                const n = startN + base + k;
                if (!this.visited.has(n)) {
                    this.visited.add(n);
                    items.push(n);
                } else if (this.foundMap.has(n)) {
                    // Уже найдено (например, в фазе поиска) — учитываем как якорь без пробы.
                    foundNumbers.push(n);
                }
            }
            const results = await Promise.all(items.map((n) => probePool.run(() => this.prober.probe(n))));
            this.probed += items.length;

            const newFound: FoundFile[] = [];
            for (const [i, n] of items.entries()) {
                const res = results[i];
                if (res === undefined) continue;
                this.probeTimestamps.push(Date.now());
                if (res.kind === 'neterr') {
                    this.neterrStreak += 1;
                    if (this.neterrStreak >= C.NETERR_PAUSE) {
                        this.pauseNeterr();
                        return;
                    }
                    continue;
                }
                this.neterrStreak = 0;
                anyResponse = true;
                if (res.kind === 'exists' && res.media !== null) {
                    foundNumbers.push(n);
                    this.registerFound(n, res, conn, newFound);
                }
            }
            if (newFound.length > 0) this.emitFound(newFound);
        }

        if (!(await this.waitGate(gen))) return;

        if (!anyResponse) {
            // Сервер перестал отвечать посреди разведки: пауза вместо ошибки —
            // «Продолжить» вернётся к этой же точке (lastDetectStart).
            this.pauseNeterr();
            this.reason = 'Сервер перестал отвечать во время разведки. Продолжите вручную';
            return;
        }

        this.mode = foundNumbers.length >= C.SEQ_THRESHOLD ? 'seq' : 'delta';
        this.arms = this.buildArms(this.mode, startN, foundNumbers);
        this.status = 'scanning';
        this.armLoopsRunning = true;
        for (const arm of this.arms) {
            if (arm.state === 'run') void this.runArm(gen, arm);
        }
        this.checkDone();
    }

    /** Создание рук по итогам разведки. */
    private buildArms(mode: ScanMode, startN: number, anchors: number[]): Arm[] {
        const mk = (dir: ArmDir, pos: number, step: number): Arm => ({
            dir,
            pos,
            step,
            phase: 'scan',
            state: outOfRange(pos) ? 'stopped' : 'run',
            missStreak: 0,
            jumpsDone: 0,
            hadJump: false,
            foundCount: 0,
            foundSinceSweep: 0,
            sweepQueue: [],
            gapPos: 0,
            gapMiss: 0,
            resumePos: 0,
            sparseLeft: 0,
            searchLeft: 0,
        });
        if (mode === 'seq') {
            return [mk(1, startN + C.DETECT_BLOCK, 1), mk(-1, startN - 1, 1)];
        }
        if (anchors.length === 0) {
            // Нулевая разведка: база библиотеки неизвестна — режим поиска блоками
            // (шаг 1 внутри блока, блоки через C.SEARCH_STRIDE). Первая находка
            // перезапускает обычную разведку вокруг себя (см. probeBatch).
            const search = (dir: ArmDir, pos: number, left: number): Arm => ({
                ...mk(dir, pos, C.STEP_DELTA),
                phase: 'search',
                searchLeft: left,
            });
            return [search(1, startN, 0), search(-1, startN - 1, C.DETECT_BLOCK)];
        }
        // delta: якоря = найденные номера
        const arms: Arm[] = [];
        for (const a of anchors) {
            arms.push(mk(1, a + C.STEP_DELTA, C.STEP_DELTA));
            arms.push(mk(-1, a - C.STEP_DELTA, C.STEP_DELTA));
        }
        return arms;
    }

    /** Запуск циклов рук, если ещё не запущены (после restore/resume). */
    private startArmLoops(): void {
        if (this.armLoopsRunning) return;
        this.armLoopsRunning = true;
        const gen = this.generation;
        for (const arm of this.arms) {
            if (arm.state === 'run') void this.runArm(gen, arm);
        }
    }

    /** Цикл руки до остановки. */
    private async runArm(gen: number, arm: Arm): Promise<void> {
        while (arm.state === 'run') {
            if (!(await this.waitGate(gen))) return;

            const batch = this.planBatch(arm);
            if (isStopped(arm)) break;
            if (batch.length === 0) {
                // Нечего пробить (например, sparse упирается в visited) — не крутимся вхолостую.
                await new Promise<void>((resolve) => setTimeout(resolve, 1));
                continue;
            }

            await this.probeBatch(batch);

            // Прыжки / смена фаз по итогам батча.
            if (arm.phase === 'scan' && arm.missStreak >= C.MISS_LIMIT) {
                arm.missStreak = 0;
                if (arm.jumpsDone < C.JUMP_REPEATS) {
                    arm.pos += arm.dir * C.JUMP_POSITIONS * arm.step;
                    arm.jumpsDone += 1;
                    arm.hadJump = true;
                    if (outOfRange(arm.pos)) arm.state = 'stopped';
                } else {
                    arm.phase = 'sparse';
                    arm.sparseLeft = C.SPARSE_PROBES;
                }
            }
            if (arm.phase === 'search' && arm.missStreak >= C.SEARCH_LIMIT_PROBES) {
                // Бюджет поиска исчерпан: библиотеки в этом направлении нет.
                arm.state = 'stopped';
            }
            if (arm.phase === 'gapfill' && arm.gapMiss >= C.MISS_LIMIT) {
                this.finishGapfill(arm);
            }
            if (arm.phase === 'sparse' && arm.sparseLeft <= 0) {
                // Все пробы разреженного поиска — промахи: конец библиотеки в эту сторону.
                arm.state = 'stopped';
            }
        }
        this.checkDone();
    }

    /** Планирование батча: сначала очередь плотного прохода, затем позиция фазы. */
    private planBatch(arm: Arm): BatchItem[] {
        const batch: BatchItem[] = [];

        while (arm.sweepQueue.length > 0 && batch.length < C.PROBE_BATCH) {
            const n = arm.sweepQueue.shift();
            if (n === undefined) break;
            if (outOfRange(n) || this.visited.has(n)) continue;
            this.visited.add(n);
            batch.push({ number: n, fromSweep: true, arm });
        }

        while (batch.length < C.PROBE_BATCH) {
            if (arm.phase === 'scan') {
                const n = arm.pos;
                arm.pos += arm.step * arm.dir;
                if (outOfRange(n)) {
                    arm.state = 'stopped';
                    break;
                }
                if (this.visited.has(n)) continue;
                this.visited.add(n);
                batch.push({ number: n, fromSweep: false, arm });
            } else if (arm.phase === 'gapfill') {
                const n = arm.gapPos;
                if (this.visited.has(n) || outOfRange(n)) {
                    // Дошли до разведанной зоны/границы — разрыв закрыт.
                    this.finishGapfill(arm);
                    continue;
                }
                arm.gapPos -= arm.step * arm.dir;
                this.visited.add(n);
                batch.push({ number: n, fromSweep: false, arm });
            } else if (arm.phase === 'search') {
                // Поиск базы библиотеки: блоки DETECT_BLOCK подряд номеров
                // (шаг 1), между блоками сдвиг до C.SEARCH_STRIDE.
                if (arm.searchLeft <= 0) {
                    arm.searchLeft = C.DETECT_BLOCK;
                    // pos уже за концом блока: добираем остаток шага между блоками.
                    arm.pos += arm.dir * Math.max(0, C.SEARCH_STRIDE - C.DETECT_BLOCK);
                }
                while (batch.length < C.PROBE_BATCH && arm.searchLeft > 0) {
                    const n = arm.pos;
                    arm.pos += arm.dir;
                    arm.searchLeft -= 1;
                    if (outOfRange(n)) {
                        arm.state = 'stopped';
                        break;
                    }
                    if (this.visited.has(n)) continue;
                    this.visited.add(n);
                    batch.push({ number: n, fromSweep: false, arm });
                }
                break;
            } else {
                // sparse
                if (arm.sparseLeft <= 0) break;
                let attempts = 0;
                let planned = true;
                while (planned && batch.length < C.PROBE_BATCH && arm.sparseLeft > 0 && attempts < C.PROBE_BATCH * 2) {
                    attempts += 1;
                    const n = arm.pos + arm.dir * sparseStep(arm.step);
                    arm.pos = n;
                    if (outOfRange(n)) {
                        arm.state = 'stopped';
                        planned = false;
                        break;
                    }
                    if (this.visited.has(n)) continue;
                    this.visited.add(n);
                    arm.sparseLeft -= 1;
                    batch.push({ number: n, fromSweep: false, arm });
                }
                break;
            }
        }

        return batch;
    }

    /** Выполнение батча проб с общим семафором и обработка результатов. */
    private async probeBatch(batch: BatchItem[]): Promise<void> {
        const results = await Promise.all(
            batch.map((it) => probePool.run(() => this.prober.probe(it.number))),
        );
        this.probed += batch.length;

        const newFound: FoundFile[] = [];
        let neterrNow = false;

        for (const [i, it] of batch.entries()) {
            const res = results[i];
            if (res === undefined) continue;
            this.probeTimestamps.push(Date.now());
            const arm = it.arm;

            if (res.kind === 'neterr') {
                this.neterrStreak += 1;
                neterrNow = true;
                continue;
            }
            this.neterrStreak = 0;

            if (res.kind === 'exists' && res.media !== null) {
                this.handleFound(arm, it.number, res, newFound);
                if (arm.phase === 'search') {
                    // Первая находка поиска: рука завершается, разведка перезапустится
                    // вокруг минимального найденного номера (seq/delta определится заново).
                    arm.state = 'stopped';
                    this.searchRelaunch =
                        this.searchRelaunch === null ? it.number : Math.min(this.searchRelaunch, it.number);
                }
                continue;
            }

            // Промах.
            if (!it.fromSweep) {
                if (arm.phase === 'scan') arm.missStreak += 1;
                else if (arm.phase === 'gapfill') arm.gapMiss += 1;
                else if (arm.phase === 'search') arm.missStreak += 1;
                // sparse: отдельного счётчика нет — только исчерпание sparseLeft.
            }
        }

        if (newFound.length > 0) this.emitFound(newFound);
        if (neterrNow && this.neterrStreak >= C.NETERR_PAUSE) this.pauseNeterr();
        if (this.searchRelaunch !== null) {
            const n = this.searchRelaunch;
            this.searchRelaunch = null;
            this.relaunchDetect(n);
        }
    }

    /** Номер для перезапуска разведки после находки в фазе search. */
    private searchRelaunch: number | null = null;

    /** Перезапуск разведки блока вокруг найденного номера (выход из режима поиска). */
    private relaunchDetect(startN: number): void {
        const conn = this.connection;
        if (conn === null) return;
        this.generation += 1;
        const gen = this.generation;
        const waiters = this.resumeWaiters;
        this.resumeWaiters = [];
        for (const w of waiters) w();
        for (const a of this.arms) a.state = 'stopped';
        this.arms = [];
        this.mode = null;
        this.status = 'detecting';
        this.neterrStreak = 0;
        this.lastDetectStart = startN;
        void this.detect(gen, conn, Math.max(0, startN)).catch((err: unknown) => {
            this.status = 'error';
            this.reason = `Ошибка разведки: ${err instanceof Error ? err.message : String(err)}`;
        });
    }

    /** Обработка находки: регистрация + фазовые переходы руки. */
    private handleFound(arm: Arm, n: number, res: ProbeResult, sink: FoundFile[]): void {
        const conn = this.connection;
        if (conn !== null) this.registerFound(n, res, conn, sink);

        arm.missStreak = 0;
        arm.gapMiss = 0;
        arm.foundCount += 1;
        arm.foundSinceSweep += 1;

        if (arm.phase === 'sparse' || arm.hadJump) {
            // Находка после прыжка/разреженного поиска — заполняем разрыв в обратную сторону.
            arm.gapPos = n - arm.step * arm.dir;
            arm.resumePos = n + arm.step * arm.dir;
            arm.phase = 'gapfill';
            arm.hadJump = false;
            arm.gapMiss = 0;
            // TODO(уточнить): счётчик прыжков сбрасываем — серия прервана находкой (новая область).
            arm.jumpsDone = 0;
        }

        if (arm.phase !== 'search' && arm.foundSinceSweep >= C.DENSE_SWEEP_EVERY) {
            this.enqueueSweep(arm, n);
            arm.foundSinceSweep = 0;
        }
    }

    /** Поставить в очередь плотный проход: 256 подряд идущих номеров вокруг находки
     *  (симметрично — независимо от направления руки, чтобы не оставлять «хвост»). */
    private enqueueSweep(arm: Arm, foundN: number): void {
        const half = Math.floor(C.DETECT_BLOCK / 2);
        const start = foundN - half;
        for (let k = 0; k < C.DETECT_BLOCK; k += 1) {
            const n = start + k;
            if (!outOfRange(n)) arm.sweepQueue.push(n);
        }
    }

    private finishGapfill(arm: Arm): void {
        arm.phase = 'scan';
        arm.pos = arm.resumePos;
        arm.gapMiss = 0;
        if (outOfRange(arm.pos)) arm.state = 'stopped';
    }

    /** Зарегистрировать файл (дедуп по номеру; состояние найденных не меняем). */
    private registerFound(n: number, res: ProbeResult, conn: TwonkyConnection, sink: FoundFile[]): void {
        if (this.foundMap.has(n)) return;
        const contentType = res.contentType ?? 'application/octet-stream';
        const tail = `${conn.prefix}${n}`;
        const file: FoundFile = {
            number: n,
            url: fileUrl(conn, n),
            tail,
            contentType,
            kind: res.media ?? 'image',
            size: res.size ?? 0,
            name: buildFileName(tail, contentType),
            addedAt: Date.now(),
        };
        this.foundMap.set(n, file);
        if (file.kind === 'image') this.foundImagesCount += 1;
        else if (file.kind === 'video') this.foundVideosCount += 1;
        this.sortedFoundCache = null;
        sink.push(file);
    }

    /** Все руки остановлены → скан завершён. Если статистика известна и библиотека
     *  не полна — фиксируем причину досрочной остановки (а не молчаливый done). */
    private checkDone(): void {
        if (this.status !== 'scanning') return;
        if (this.arms.length === 0 || !this.arms.every((a) => a.state === 'stopped')) return;
        this.status = 'done';
        if (this.serverTotals === null) {
            this.reason = null;
            return;
        }
        const total = this.serverTotals.pictures + this.serverTotals.videos;
        const { images, videos } = this.mediaCounts();
        if (total > 0 && images + videos < total) {
            this.reason =
                `Остановлено досрочно: найдено ${images + videos} из ${total} ` +
                `(фото ${images} из ${this.serverTotals.pictures}, видео ${videos} из ${this.serverTotals.videos})`;
            logWarn('scan', this.reason);
            return;
        }
        this.reason = null;
    }
}

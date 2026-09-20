/**
 * Юнит-тесты сканера (план, M2) — на моке Prober, реальная сеть запрещена.
 * Покрытие: seq/delta, цикл прыжков, sparse-остановка, gapfill, плотный проход,
 * пауза по сетевым ошибкам, дедуп проб, граница 0, stop/resume, serialize/restore.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scanner } from '../src/lib/scanner';
import type { Prober } from '../src/lib/scanner';
import type { ProbeResult } from '../src/lib/probe';
import { parseConnectionUrl } from '../src/lib/url-parser';
import type { TwonkyConnection } from '../src/lib/types';

function conn(): TwonkyConnection {
    const res = parseConnectionUrl('http://host:9000/disk/O0$2$20I5000');
    assert.equal(res.ok, true);
    if (res.ok) return res.connection;
    throw new Error('не должен выполняться');
}

class MockProber implements Prober {
    readonly calls: number[] = [];

    constructor(
        private readonly exists: (n: number) => boolean,
        /** Искусственная задержка пробы, мс — чтобы ловить промежуточные статусы скана. */
        private readonly delayMs = 0,
    ) {}

    async probe(n: number): Promise<ProbeResult> {
        if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        this.calls.push(n);
        if (this.exists(n)) {
            return { kind: 'exists', media: 'image', contentType: 'image/jpeg', size: 1024, detail: 'мок' };
        }
        return { kind: 'missing', media: null, contentType: null, size: null, detail: 'мок' };
    }
}

class NetErrProber implements Prober {
    async probe(_n: number): Promise<ProbeResult> {
        return { kind: 'neterr', media: null, contentType: null, size: null, detail: 'мок' };
    }
}

/** Флапающая сеть: до cut1 отвечает, [cut1..cut2) — обвал (neterr), после — снова отвечает. */
class FlakyProber implements Prober {
    private count = 0;

    constructor(
        private readonly exists: (n: number) => boolean,
        private readonly cut1: number,
        private readonly cut2: number,
    ) {}

    async probe(n: number): Promise<ProbeResult> {
        this.count += 1;
        if (this.count >= this.cut1 && this.count < this.cut2) {
            return { kind: 'neterr', media: null, contentType: null, size: null, detail: 'обвал сети' };
        }
        if (this.exists(n)) {
            return { kind: 'exists', media: 'image', contentType: 'image/jpeg', size: 1024, detail: 'мок' };
        }
        return { kind: 'missing', media: null, contentType: null, size: null, detail: 'мок' };
    }
}

async function waitStatus(scanner: Scanner, expected: string[], timeoutMs = 10_000): Promise<void> {
    const t0 = Date.now();
    while (!expected.includes(scanner.progress().status)) {
        if (Date.now() - t0 > timeoutMs) {
            throw new Error(`таймаут ожидания статуса ${expected.join('|')}; текущий: ${scanner.progress().status}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
}

test('seq: полный блок → режим «шаг 1», две руки, найден весь блок', async () => {
    const prober = new MockProber((n) => n >= 5000 && n <= 5255);
    const scanner = new Scanner(prober);
    scanner.start(conn());
    await waitStatus(scanner, ['done']);

    const p = scanner.progress();
    assert.equal(p.mode, 'seq');
    assert.equal(p.arms.length, 2);
    assert.equal(p.found, 256);

    // Руки стартуют сразу за блоком разведки.
    assert.ok(prober.calls.includes(5256), 'прямая рука должна пробить 5256');
    assert.ok(prober.calls.includes(4999), 'обратная рука должна пробить 4999');
});

test('дедуп: ни одна позиция не пробуется дважды', async () => {
    const prober = new MockProber((n) => n >= 5000 && n <= 5255);
    const scanner = new Scanner(prober);
    scanner.start(conn());
    await waitStatus(scanner, ['done']);

    assert.equal(new Set(prober.calls).size, prober.calls.length);
});

test('граница 0: обратная рука доходит до 0 включительно и не ниже', async () => {
    const prober = new MockProber((n) => n >= 5000 && n <= 5255);
    const scanner = new Scanner(prober);
    scanner.start(conn());
    await waitStatus(scanner, ['done']);

    assert.ok(prober.calls.includes(0), 'номер 0 должен быть пробит');
    assert.ok(prober.calls.every((n) => n >= 0), 'отрицательных номеров быть не должно');
});

test('цикл прыжков и sparse: после 5 прыжков — разреженный поиск, затем остановка', async () => {
    const prober = new MockProber((n) => n >= 5000 && n <= 5255);
    const scanner = new Scanner(prober);
    scanner.start(conn());
    await waitStatus(scanner, ['done']);

    // Первый прыжок: 512 промахов (32 батча × 16) от 5256 → прыжок на 5768+1000=6768.
    assert.ok(prober.calls.includes(6768), 'проба после первого прыжка');
    // Sparse уводит далеко за пределы прыжков.
    const maxProbed = Math.max(...prober.calls);
    assert.ok(maxProbed > 15_000, `разреженный поиск должен уйти далеко (максимум: ${maxProbed})`);

    const state = scanner.serialize();
    assert.ok(state !== null);
    const fwd = state?.arms.find((a) => a.dir === 1);
    assert.ok(fwd !== undefined);
    assert.equal(fwd.state, 'stopped');
    assert.equal(fwd.jumpsDone >= 5 || fwd.phase === 'sparse' || fwd.sparseLeft === 0, true);
});

test('delta: единственная находка в блоке → якорь, шаг 256', async () => {
    const prober = new MockProber((n) => n === 5000);
    const scanner = new Scanner(prober);
    scanner.start(conn());
    await waitStatus(scanner, ['done']);

    const p = scanner.progress();
    assert.equal(p.mode, 'delta');
    assert.equal(p.arms.length, 2);
    assert.equal(p.found, 1);
    // Руки от якоря ±256.
    assert.ok(prober.calls.includes(5256));
    assert.ok(prober.calls.includes(4744));
});

test('delta: ноль найдено в блоке → режим поиска (руки останавливаются по бюджету)', async () => {
    const prober = new MockProber(() => false);
    const scanner = new Scanner(prober);
    scanner.start(conn());
    await waitStatus(scanner, ['done'], 60_000);

    const p = scanner.progress();
    assert.equal(p.mode, 'delta');
    assert.equal(p.arms.length, 2);
    assert.equal(p.found, 0);
    // Обе руки остановлены (бюджет поиска/границы), не зависли.
    assert.ok(p.arms.every((a) => a.state === 'stopped'));
});

test('gapfill: находка после прыжка заполняет разрыв в обратную сторону и продолжает скан', async () => {
    // 512 промахов (32 батча × 16) от 5256 → прыжок на 5768+1000=6768; там изолированный файл.
    const prober = new MockProber((n) => (n >= 5000 && n <= 5255) || n === 6768);
    const scanner = new Scanner(prober);
    scanner.start(conn());
    await waitStatus(scanner, ['done']);

    // Находка на 6768 (после прыжка) → gapfill вниз от 6767.
    assert.ok(prober.calls.includes(6768));
    assert.ok(prober.calls.includes(6767), 'gapfill должен пробить 6767 (шаг назад от находки)');
    assert.ok(prober.calls.includes(6769), 'после gapfill скан продолжается с 6769');

    const state = scanner.serialize();
    const fwd = state?.arms.find((a) => a.dir === 1);
    assert.ok(fwd !== undefined);
    assert.notEqual(fwd.phase, 'gapfill');
    assert.equal(scanner.foundList().some((f) => f.number === 6768), true);
});

test('плотный проход: после 2000 находок руки пробиваются соседние номера с шагом 1', async () => {
    // Сетка кратных 256 за блоком: 2100 находок по +256, затем обрыв.
    const limit = 5256 + 256 * 2100;
    const prober = new MockProber((n) => (n >= 5000 && n < 5256) || (n > 5255 && n % 256 === 0 && n <= limit));
    const scanner = new Scanner(prober);
    scanner.start(conn());
    await waitStatus(scanner, ['done']);

    // Ищем два соседних числа за пределами блока разведки — след плотного прохода.
    const beyond = new Set(prober.calls.filter((n) => n > 5256));
    let neighbours = false;
    for (const n of beyond) {
        if (beyond.has(n + 1)) {
            neighbours = true;
            break;
        }
    }
    assert.ok(neighbours, 'sweep должен пробить соседние номера (шаг 1) вне блока');
});

test('сетевые ошибки: 12 подряд → пауза с reason', async () => {
    const scanner = new Scanner(new NetErrProber());
    scanner.start(conn());
    await waitStatus(scanner, ['paused']);

    const p = scanner.progress();
    assert.equal(p.status, 'paused');
    assert.match(p.reason ?? '', /Сетевые/);
});

test('стоп и продолжение: stop → paused, resume → скан завершается', async () => {
    // Задержка проб оставляет окно, чтобы поймать промежуточный статус scanning.
    const prober = new MockProber((n) => n >= 5000 && n <= 5255, 5);
    const scanner = new Scanner(prober);
    scanner.start(conn());
    await waitStatus(scanner, ['scanning']);

    scanner.stop();
    let p = scanner.progress();
    assert.equal(p.status, 'paused');
    assert.match(p.reason ?? '', /Остановлено/);

    scanner.resume();
    await waitStatus(scanner, ['done']);
    p = scanner.progress();
    assert.equal(p.status, 'done');
});

test('serialize/restore: находки и статус переносятся', async () => {
    const prober = new MockProber((n) => n >= 5000 && n <= 5255);
    const scanner = new Scanner(prober);
    scanner.start(conn());
    await waitStatus(scanner, ['done']);

    const state = scanner.serialize();
    assert.ok(state !== null);

    const second = new Scanner(new NetErrProber());
    const wasRunning = second.restore(state!);
    assert.equal(wasRunning, false);
    assert.equal(second.progress().status, 'done');
    assert.equal(second.progress().found, 256);
    assert.deepEqual(
        second.foundList().map((f) => f.number),
        scanner.foundList().map((f) => f.number),
    );
});

test('статистика сервера: найдено всё → досрочная остановка', async () => {
    const prober = new MockProber((n) => n >= 5000 && n <= 5009);
    const scanner = new Scanner(prober);
    scanner.setServerTotals({ pictures: 10, videos: 0 });
    scanner.start(conn());
    await waitStatus(scanner, ['done']);

    const p = scanner.progress();
    assert.equal(p.found, 10);
    assert.match(p.reason ?? '', /статистике сервера/);
    // За пределы разведочного блока не выходили.
    assert.ok(!prober.calls.some((n) => n > 5255), 'не должно быть проб за блоком разведки');
});

test('статистика недоступна (null) — скан идёт как обычно', async () => {
    const prober = new MockProber((n) => n >= 5000 && n <= 5255);
    const scanner = new Scanner(prober);
    scanner.setServerTotals(null);
    scanner.start(conn());
    await waitStatus(scanner, ['done']);
    assert.equal(scanner.progress().found, 256);
});

test('поиск: обвал сети после находки → пауза → продолжить от находки', async () => {
    // Библиотека 130844..131612 (шаг 256). Обвал сети начинается после того, как
    // поиск нашёл первый файл и перезапустил разведку (кут попадает на detect-блок).
    // Суммарный счётчик проб к моменту находки: 256 (разведка) + ~5000 (рука вниз до нуля)
    // + ~125 600 (рука вперёд до 130843) ≈ 130 845. Обвал ловит relaunch-разведку:
    // первый же батч даёт 16 neterr подряд → пауза (~130 916). Обвал короткий —
    // после resume сервер снова отвечает.
    const prober = new FlakyProber((n) => n >= 130844 && n <= 131612 && (n - 130844) % 256 === 0, 130_900, 130_920);
    const scanner = new Scanner(prober);
    scanner.start(conn());
    await waitStatus(scanner, ['paused'], 60_000);
    assert.equal(scanner.getFound(130844) !== null, true, 'находка поиска должна быть зарегистрирована до паузы');

    scanner.resume();
    await waitStatus(scanner, ['done'], 60_000);
    assert.equal(scanner.progress().found, 4);
    assert.ok(scanner.getFound(131612) !== null);
});

test('поиск: нулевая разведка → блоки поиска → перезапуск вокруг находки', async () => {
    // Библиотека далеко от старта 5000: 130844..131612 с шагом 256 (как у реального сервера).
    const prober = new MockProber((n) => n >= 130844 && n <= 131612 && (n - 130844) % 256 === 0);
    const scanner = new Scanner(prober);
    scanner.start(conn());
    await waitStatus(scanner, ['done'], 60_000);

    const p = scanner.progress();
    assert.equal(p.mode, 'delta');
    assert.equal(p.found, 4); // 130844, 131100, 131356, 131612
    assert.ok(scanner.getFound(130844) !== null);
    assert.ok(scanner.getFound(131612) !== null);
    // Соседние с границами не «найдены».
    assert.ok(scanner.getFound(131868) === null);
});

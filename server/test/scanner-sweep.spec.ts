/**
 * Юнит-тесты полного прохода (sweep) и повторных проб после сетевых сбоев.
 * На моке Prober, реальная сеть запрещена.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { C } from '../src/config';
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

    constructor(private readonly exists: (n: number) => boolean) {}

    async probe(n: number): Promise<ProbeResult> {
        this.calls.push(n);
        if (this.exists(n)) {
            return { kind: 'exists', media: 'image', contentType: 'image/jpeg', size: 1024, detail: 'мок' };
        }
        return { kind: 'missing', media: null, contentType: null, size: null, detail: 'мок' };
    }
}

/** Первая проба указанных номеров — сетевой сбой, повторные — как обычно. */
class FailOnceProber implements Prober {
    readonly calls: number[] = [];

    constructor(
        private readonly exists: (n: number) => boolean,
        private readonly failFirst: readonly number[],
    ) {}

    async probe(n: number): Promise<ProbeResult> {
        this.calls.push(n);
        if (this.failFirst.includes(n) && this.calls.filter((c) => c === n).length === 1) {
            return { kind: 'neterr', media: null, contentType: null, size: null, detail: 'мок: разовый сбой' };
        }
        if (this.exists(n)) {
            return { kind: 'exists', media: 'image', contentType: 'image/jpeg', size: 1024, detail: 'мок' };
        }
        return { kind: 'missing', media: null, contentType: null, size: null, detail: 'мок' };
    }
}

async function waitStatus(scanner: Scanner, expected: string[], timeoutMs = 60_000): Promise<void> {
    const t0 = Date.now();
    while (!expected.includes(scanner.progress().status)) {
        if (Date.now() - t0 > timeoutMs) {
            throw new Error(`таймаут ожидания статуса ${expected.join('|')}; текущий: ${scanner.progress().status}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
}

test('полный проход: файл за огромным разрывом находится после остановки рук', async () => {
    // Библиотека на сетке якоря 5000 (шаг 256): 5000, 4744, 17800 и далёкий 773000.
    // Руки «перепрыгивают» далёкий файл (прыжки 256000), полный проход его добирает.
    const far = 5000 + 256 * 3000;
    const prober = new MockProber(
        (n) => n === 5000 || n === 5000 - 256 * 10 || n === 5000 + 256 * 50 || n === far,
    );
    const scanner = new Scanner(prober);
    scanner.setServerTotals({ pictures: 4, videos: 0 });
    scanner.start(conn());
    await waitStatus(scanner, ['done']);

    const p = scanner.progress();
    assert.equal(p.found, 4, `должны быть найдены все 4, реально: ${p.found}`);
    assert.ok(prober.calls.includes(far), 'далёкий файл должен быть пробит полным проходом');
    assert.match(p.reason ?? '', /статистике сервера/);
});

test('полный проход: исчерпание бюджета → done с причиной о бюджете', async () => {
    const prober = new MockProber((n) => n === 5000);
    const scanner = new Scanner(prober);
    scanner.setServerTotals({ pictures: 5, videos: 0 });
    const savedBudget = C.SWEEP_MAX_PROBES;
    C.SWEEP_MAX_PROBES = 100;
    try {
        scanner.start(conn());
        await waitStatus(scanner, ['done']);
    } finally {
        C.SWEEP_MAX_PROBES = savedBudget;
    }
    const p = scanner.progress();
    assert.equal(p.found, 1);
    assert.match(p.reason ?? '', /бюджет полного прохода/);
});

test('персистентность: sweepOffset переносится через serialize/restore', async () => {
    const prober = new MockProber((n) => n === 5000);
    const scanner = new Scanner(prober);
    scanner.setServerTotals({ pictures: 5, videos: 0 });
    const savedBudget = C.SWEEP_MAX_PROBES;
    C.SWEEP_MAX_PROBES = 64;
    let state: ReturnType<Scanner['serialize']> = null;
    try {
        scanner.start(conn());
        await waitStatus(scanner, ['done']);
        state = scanner.serialize();
    } finally {
        C.SWEEP_MAX_PROBES = savedBudget;
    }
    assert.ok(state !== null);
    assert.ok(
        state !== null && typeof state.sweepOffset === 'number' && state.sweepOffset > 0,
        'проход должен был продвинуться',
    );

    const second = new Scanner(new MockProber(() => false));
    second.restore(state!);
    const meta = second.serializeMeta();
    assert.equal(meta?.sweepOffset, state?.sweepOffset);
});

test('сетевые сбои: разовый сбой не теряет файл (повтор через очередь руки)', async () => {
    // seq-библиотека 5000..5255; у 5100 первая проба — neterr.
    const prober = new FailOnceProber((n) => n >= 5000 && n <= 5255, [5100]);
    const scanner = new Scanner(prober);
    scanner.start(conn());
    await waitStatus(scanner, ['done']);

    const p = scanner.progress();
    assert.equal(p.found, 256, 'все 256 файлов должны быть найдены');
    assert.ok(prober.calls.filter((n) => n === 5100).length >= 2, '5100 пробуется повторно');
});

test('разведка: пауза по серии сбоев → resume продолжает и завершает', async () => {
    // Первые 12 проб — neterr (пауза разведки), дальше сервер отвечает.
    class RecoveringProber implements Prober {
        count = 0;

        async probe(n: number): Promise<ProbeResult> {
            this.count += 1;
            if (this.count <= 12) {
                return { kind: 'neterr', media: null, contentType: null, size: null, detail: 'мок' };
            }
            if (n >= 5000 && n <= 5255) {
                return { kind: 'exists', media: 'image', contentType: 'image/jpeg', size: 1024, detail: 'мок' };
            }
            return { kind: 'missing', media: null, contentType: null, size: null, detail: 'мок' };
        }
    }
    const scanner = new Scanner(new RecoveringProber());
    scanner.start(conn());
    await waitStatus(scanner, ['paused']);

    scanner.resume();
    await waitStatus(scanner, ['done']);
    assert.equal(scanner.progress().found, 256);
});

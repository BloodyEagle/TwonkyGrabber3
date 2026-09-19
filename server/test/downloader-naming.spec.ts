/**
 * Тесты загрузчика (план, M4): нейминг файлов (skip при равном размере, _N при отличии),
 * дедуп очереди, настройки потоков, restore (active→pending).
 * Сеть запрещена: зависимости подменяются моками.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSaveTarget, Downloader } from '../src/lib/downloader';
import type { DownloaderDeps, FoundSource } from '../src/lib/downloader';
import type { ProbeResult } from '../src/lib/probe';
import type { FoundFile } from '../src/lib/types';

const DIR = 'X:/downloads';

function makeFound(number: number, size: number): FoundFile {
    const tail = `O0$2$20I${number}`;
    return {
        number,
        url: `http://127.0.0.1:59999/disk/${tail}`,
        tail,
        contentType: 'image/jpeg',
        kind: 'image',
        size,
        name: `${tail}.jpg`,
        addedAt: 1_700_000_000_000,
    };
}

/** Мок размера файла по пути. */
function sizeOfMock(files: Record<string, number>): (path: string) => Promise<number | null> {
    // Нормализация разделителей: path.join на Windows даёт обратные слеши.
    return async (path) => {
        const norm = path.split('\\').join('/');
        return norm in files ? files[norm] : null;
    };
}

const NEVER: Promise<ProbeResult> = new Promise<ProbeResult>(() => {
    // Намеренно никогда не резолвится: item зависает в active для теста restore.
});

/** Мок зависимостей: probe не отвечает, стрим не используется. */
function mockDeps(files: Record<string, number> = {}): DownloaderDeps {
    return {
        downloadDir: DIR,
        probe: () => NEVER,
        stream: () => {
            throw new Error('стрим в этих тестах не используется');
        },
        sizeOf: sizeOfMock(files),
        write: () => {
            throw new Error('запись в этих тестах не используется');
        },
        rename: async () => {},
        mkdirp: async () => {},
    };
}

function mockFound(files: FoundFile[]): FoundSource & { put(file: FoundFile): void } {
    // put имитирует обновление хранилища сканера до emit found.
    const map = new Map(files.map((f) => [f.number, f]));
    return {
        getFound: (n) => map.get(n) ?? null,
        foundList: () => [...map.values()].sort((a, b) => a.number - b.number),
        put: (file) => {
            map.set(file.number, file);
        },
    };
}

// --- resolveSaveTarget ---

test('нейминг: свободно → писать без суффикса', async () => {
    const target = await resolveSaveTarget(sizeOfMock({}), DIR, 'O0$2$20I5000', 'O0$2$20I5000.jpg', 123);
    assert.deepEqual(target, { action: 'write', fileName: 'O0$2$20I5000.jpg' });
});

test('нейминг: файл того же размера → skipped «уже скачан»', async () => {
    const files = { 'X:/downloads/O0$2$20I5000.jpg': 123 };
    const target = await resolveSaveTarget(sizeOfMock(files), DIR, 'O0$2$20I5000', 'O0$2$20I5000.jpg', 123);
    assert.deepEqual(target, { action: 'skip', savedAs: 'O0$2$20I5000.jpg', note: 'уже скачан' });
});

test('нейминг: размер отличается → суффикс _1', async () => {
    const files = { 'X:/downloads/O0$2$20I5000.jpg': 999 };
    const target = await resolveSaveTarget(sizeOfMock(files), DIR, 'O0$2$20I5000', 'O0$2$20I5000.jpg', 123);
    assert.deepEqual(target, { action: 'write', fileName: 'O0$2$20I5000_1.jpg' });
});

test('нейминг: _1 тоже занят другим размером → _2', async () => {
    const files = {
        'X:/downloads/O0$2$20I5000.jpg': 999,
        'X:/downloads/O0$2$20I5000_1.jpg': 888,
    };
    const target = await resolveSaveTarget(sizeOfMock(files), DIR, 'O0$2$20I5000', 'O0$2$20I5000.jpg', 123);
    assert.deepEqual(target, { action: 'write', fileName: 'O0$2$20I5000_2.jpg' });
});

test('нейминг: все суффиксы заняты → fail', async () => {
    const files: Record<string, number> = {};
    for (let k = 0; k <= 100; k += 1) {
        const name = k === 0 ? 'O0$2$20I5000.jpg' : `O0$2$20I5000_${k}.jpg`;
        files[`X:/downloads/${name}`] = 1000 + k;
    }
    const target = await resolveSaveTarget(sizeOfMock(files), DIR, 'O0$2$20I5000', 'O0$2$20I5000.jpg', 123);
    assert.equal(target.action, 'fail');
});

// --- очередь ---

test('очередь: дедуп при добавлении', () => {
    const dl = new Downloader(mockDeps(), mockFound([makeFound(5000, 10)]));
    dl.pause();
    const added = dl.add([5000, 5000, 5001]); // 5001 нет в найденных
    assert.equal(added, 1);
    assert.equal(dl.state().total, 1);
    dl.dispose();
});

test('очередь: addAll ставит все находки и включает autoAll', () => {
    const source = mockFound([makeFound(5000, 10), makeFound(5001, 20)]);
    const dl = new Downloader(mockDeps(), source);
    dl.pause();
    const added = dl.addAll();
    assert.equal(added, 2);
    assert.equal(dl.settings().autoAll, true);


    source.put(makeFound(5256, 5));
    dl.handleFound([makeFound(5256, 5)]);
    assert.equal(dl.state().total, 3);
    dl.dispose();
});

test('настройки: ручной режим применяет слайдер с клампом', () => {
    const dl = new Downloader(mockDeps(), mockFound([]));
    dl.pause();
    dl.applySettings({ threadsMode: 'manual', threadsValue: 999 });
    assert.equal(dl.settings().threadsValue, 32);
    assert.deepEqual(dl.state().threads, { live: 0, target: 32, mode: 'manual', manual: 32 });
    dl.applySettings({ threadsValue: 0 });
    assert.equal(dl.settings().threadsValue, 1);
    dl.dispose();
});

test('очередь: удаление pending разрешено, несуществующего — нет', () => {
    const dl = new Downloader(mockDeps(), mockFound([makeFound(5000, 10)]));
    dl.pause();
    dl.add([5000]);
    assert.equal(dl.remove(5000), true);
    assert.equal(dl.remove(5000), null);
    assert.equal(dl.state().total, 0);
    dl.dispose();
});

test('персистентность: serialize/restore, active становится pending', async () => {
    // Первый загрузчик: элемент зависает в active (probe не отвечает).
    const dl1 = new Downloader(mockDeps(), mockFound([makeFound(5000, 10)]));
    dl1.add([5000]);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal(dl1.state().counts.active, 1);

    const snap = dl1.serialize();
    const activeItem = snap.items.find((i) => i.number === 5000);
    assert.ok(activeItem !== undefined);
    assert.equal(activeItem.status, 'pending');
    dl1.dispose();

    // Второй: restore восстанавливает paused=false из снапшота и очередь
    // возобновляется сразу (план п.6), элемент снова active (probe подвешен).
    const dl2 = new Downloader(mockDeps(), mockFound([makeFound(5000, 10)]));
    dl2.restore(snap);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const state2 = dl2.state();
    assert.equal(state2.total, 1);
    assert.equal(state2.counts.active, 1);
    const page = dl2.itemsPage(1, 10);
    assert.equal(page.items[0]?.number, 5000);
    assert.equal(page.items[0]?.status, 'active');
    dl2.dispose();
});

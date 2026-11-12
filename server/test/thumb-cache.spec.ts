/**
 * Юнит-тесты дискового кэша превью: запись/чтение, TTL (в т.ч. негативных записей),
 * дедуп одновременных загрузок, LRU-обрезка. Реальная сеть не используется.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { C } from '../src/config';
import { ThumbCache } from '../src/lib/thumb-cache';
import type { ThumbLoadResult } from '../src/lib/thumb-cache';

async function tempDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'thumb-cache-'));
}

const IMG: ThumbLoadResult = {
    type: 'content',
    contentType: 'image/jpeg',
    body: Buffer.from('jpeg-body'),
    cache: true,
};

test('put/get: запись и чтение тела и content-type', async () => {
    const dir = await tempDir();
    try {
        const cache = new ThumbCache(dir);
        await cache.put('k1', IMG);
        const hit = await cache.get('k1');
        assert.ok(hit !== null && hit.type === 'content');
        if (hit.type === 'content') {
            assert.equal(hit.contentType, 'image/jpeg');
            assert.deepEqual(hit.body, IMG.body);
        }
        assert.equal(await cache.get('missing'), null);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('негативная запись: 404 кэшируется и просрочивается по THUMB_NEG_CACHE_TTL', async () => {
    const dir = await tempDir();
    const savedNeg = C.THUMB_NEG_CACHE_TTL;
    C.THUMB_NEG_CACHE_TTL = 1; // 1 с
    try {
        const cache = new ThumbCache(dir);
        await cache.put('k-neg', { type: 'negative' });
        assert.equal((await cache.get('k-neg'))?.type, 'negative');
        // Просрочка: сдвигаем время записи в мета-файле назад.
        const metaPath = join(dir, 'k-neg.json');
        const meta = JSON.parse(await readFile(metaPath, 'utf8')) as { at: number };
        meta.at -= (C.THUMB_NEG_CACHE_TTL + 10) * 1000;
        await writeFile(metaPath, JSON.stringify(meta), 'utf8');
        assert.equal(await cache.get('k-neg'), null);
    } finally {
        C.THUMB_NEG_CACHE_TTL = savedNeg;
        await rm(dir, { recursive: true, force: true });
    }
});

test('getOrLoad: загрузчик вызывается один раз при параллельных запросах', async () => {
    const dir = await tempDir();
    try {
        const cache = new ThumbCache(dir);
        let loads = 0;
        const loader = async (): Promise<ThumbLoadResult> => {
            loads += 1;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return IMG;
        };
        const results = await Promise.all([
            cache.getOrLoad('k-dedup', loader),
            cache.getOrLoad('k-dedup', loader),
            cache.getOrLoad('k-dedup', loader),
        ]);
        assert.equal(loads, 1);
        for (const r of results) assert.equal(r.type, 'content');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('prune: превышение лимита удаляет самые старые записи, свежие остаются', async () => {
    const dir = await tempDir();
    const savedAge = C.THUMB_CACHE_MAX_AGE;
    const savedMax = C.THUMB_CACHE_MAX_BYTES;
    C.THUMB_CACHE_MAX_AGE = 3600;
    C.THUMB_CACHE_MAX_BYTES = 2500; // 5 записей по 1000 байт → удалить две старейшие
    try {
        const cache = new ThumbCache(dir);
        for (let i = 0; i < 5; i += 1) {
            await cache.put(`k${i}`, {
                type: 'content',
                contentType: 'image/jpeg',
                body: Buffer.alloc(1000, i),
                cache: true,
            });
            // Разносим время записи: LRU-порядок k0 < k1 < … < k4.
            const metaPath = join(dir, `k${i}.json`);
            const meta = JSON.parse(await readFile(metaPath, 'utf8')) as { at: number };
            meta.at = Date.now() - (5 - i) * 1000;
            await writeFile(metaPath, JSON.stringify(meta), 'utf8');
        }
        await cache.prune();

        assert.equal(await cache.get('k0'), null);
        assert.equal(await cache.get('k1'), null);
        assert.equal(await cache.get('k2'), null);
        assert.equal((await cache.get('k3'))?.type, 'content');
        assert.equal((await cache.get('k4'))?.type, 'content');
        const bins = (await readdir(dir)).filter((f) => f.endsWith('.bin'));
        assert.equal(bins.length, 2);
    } finally {
        C.THUMB_CACHE_MAX_AGE = savedAge;
        C.THUMB_CACHE_MAX_BYTES = savedMax;
        await rm(dir, { recursive: true, force: true });
    }
});

test('prune: просроченные записи удаляются по TTL', async () => {
    const dir = await tempDir();
    const savedAge = C.THUMB_CACHE_MAX_AGE;
    C.THUMB_CACHE_MAX_AGE = 1; // 1 с
    try {
        const cache = new ThumbCache(dir);
        await cache.put('old', IMG);
        const metaPath = join(dir, 'old.json');
        const meta = JSON.parse(await readFile(metaPath, 'utf8')) as { at: number };
        meta.at -= (C.THUMB_CACHE_MAX_AGE + 10) * 1000;
        await writeFile(metaPath, JSON.stringify(meta), 'utf8');

        await cache.prune();
        assert.equal(await cache.get('old'), null);
    } finally {
        C.THUMB_CACHE_MAX_AGE = savedAge;
        await rm(dir, { recursive: true, force: true });
    }
});

test('key: компоненты ключа склеиваются безопасно для ФС', () => {
    assert.equal(
        ThumbCache.key('94.172.130.32_9000', 3, 131100, '200x160'),
        '18:94.172.130.32_9000_3_131100_200x160',
    );
    assert.equal(ThumbCache.key('srv', 0, 5, 'orig'), '3:srv_0_5_orig');
});

test('key: длина в префиксе сессии исключает коллизии «host_80» vs «host_8080»', () => {
    const pa = ThumbCache.sessionPrefix('1.2.3.4_80');
    const pb = ThumbCache.sessionPrefix('1.2.3.4_8080');
    assert.ok(!pb.startsWith(pa) && !pa.startsWith(pb), 'префикс одной сессии не должен совпадать с префиксом другой');
});

test('prune: осиротевшие записи (тело без меты, мета без тела) удаляются', async () => {
    const dir = await tempDir();
    try {
        const cache = new ThumbCache(dir);
        // Тело без меты: сбой записи до мета-файла (новый порядок: .bin первым).
        await writeFile(join(dir, 'orphan-bin.bin'), Buffer.from('body'));
        // Мета без тела: сбой записи старого формата или потеря .bin.
        await cache.put('orphan-meta', IMG);
        await rm(join(dir, 'orphan-meta.bin'));
        await cache.prune();

        const names = await readdir(dir);
        assert.equal(names.some((f) => f === 'orphan-bin.bin'), false, 'тело без меты удаляется');
        assert.equal(names.some((f) => f === 'orphan-meta.json'), false, 'мета без тела удаляется');
        // И get() сам подчищает мета-без-тела без ожидания prune.
        await cache.put('orphan-meta2', IMG);
        await rm(join(dir, 'orphan-meta2.bin'));
        assert.equal(await cache.get('orphan-meta2'), null);
        assert.equal((await readdir(dir)).some((f) => f === 'orphan-meta2.json'), false);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('purgePrefix: записи сессии удаляются, соседняя сессия не задета', async () => {
    const dir = await tempDir();
    try {
        const cache = new ThumbCache(dir);
        const host80 = ThumbCache.key('1.2.3.4_80', 1, 5, 'orig');
        const host8080 = ThumbCache.key('1.2.3.4_8080', 1, 5, 'orig');
        await cache.put(host80, IMG);
        await cache.put(host8080, IMG);

        await cache.purgePrefix(ThumbCache.sessionPrefix('1.2.3.4_80'));

        assert.equal(await cache.get(host80), null, 'запись закрытой сессии удалена');
        assert.ok((await cache.get(host8080)) !== null, 'запись другой сессии не тронута');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

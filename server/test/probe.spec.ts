/**
 * Юнит-тесты probe-логики (план, M1) — на мок-транспорте, реальная сеть запрещена.
 * Задержки ретраев подменяются мгновенным sleep.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkAvailable, mediaKindOf, probeUrl} from '../src/lib/probe';
import {NetworkError} from '../src/lib/http';
import type {HttpMetaOptions, HttpMetaResponse, HttpTransport} from '../src/lib/http';

/** Элемент сценария: ответ или сетевая ошибка. */
type ScriptItem = { status: number; headers: Record<string, string> } | 'NET';

interface Recorded {
    method: 'HEAD' | 'GET';
    headers?: Record<string, string>;
}

/** Транспорт со сценариями ответов по методам; неисчерпанный сценарий — ошибка теста. */
function scriptedTransport(head: ScriptItem[], get: ScriptItem[]): { transport: HttpTransport; calls: Recorded[] } {
    const calls: Recorded[] = [];
    let headIdx = 0;
    let getIdx = 0;
    const transport: HttpTransport = {
        async meta(_url: string, options: HttpMetaOptions): Promise<HttpMetaResponse> {
            calls.push({method: options.method, headers: options.headers});
            const isHead = options.method === 'HEAD';
            const idx = isHead ? headIdx++ : getIdx++;
            const item = (isHead ? head : get)[idx];
            if (item === undefined) throw new Error('сценарий исчерпан — недостаточно ответов в моке');
            if (item === 'NET') throw new NetworkError('сетевая ошибка (мок)');
            return {status: item.status, headers: item.headers};
        },
    };
    return {transport, calls};
}

const instantSleep = async (): Promise<void> => {
};

test('HEAD 200 image/jpeg → exists с размером из Content-Length', async () => {
    const {transport} = scriptedTransport(
        [{status: 200, headers: {'content-type': 'image/jpeg', 'content-length': '12345'}}],
        [],
    );
    const r = await probeUrl('http://h/disk/O0$2$20I5000', {transport, sleep: instantSleep});
    assert.equal(r.kind, 'exists');
    assert.equal(r.media, 'image');
    assert.equal(r.contentType, 'image/jpeg');
    assert.equal(r.size, 12345);
});

test('HEAD 200 video/mp4 → exists/video', async () => {
    const {transport} = scriptedTransport(
        [{status: 200, headers: {'content-type': 'video/mp4', 'content-length': '7'}}],
        [],
    );
    const r = await probeUrl('http://h/x', {transport, sleep: instantSleep});
    assert.equal(r.kind, 'exists');
    assert.equal(r.media, 'video');
});

test('HEAD 200 text/html → missing (не медиа), тип в detail', async () => {
    const {transport} = scriptedTransport(
        [{status: 200, headers: {'content-type': 'text/html'}}],
        [],
    );
    const r = await probeUrl('http://h/x', {transport, sleep: instantSleep});
    assert.equal(r.kind, 'missing');
    assert.equal(r.media, null);
    assert.match(r.detail, /text\/html/);
});

test('HEAD 200 без content-type → missing', async () => {
    const {transport} = scriptedTransport([{status: 200, headers: {}}], []);
    const r = await probeUrl('http://h/x', {transport, sleep: instantSleep});
    assert.equal(r.kind, 'missing');
});

test('HEAD 404 → missing без ретраев', async () => {
    const {transport, calls} = scriptedTransport([{status: 404, headers: {}}], []);
    const r = await probeUrl('http://h/x', {transport, sleep: instantSleep});
    assert.equal(r.kind, 'missing');
    assert.equal(calls.length, 1);
});

test('HEAD 405 → GET Range 206: размер из Content-Range', async () => {
    const {transport, calls} = scriptedTransport(
        [{status: 405, headers: {}}],
        [{
            status: 206,
            headers: {'content-type': 'image/jpeg', 'content-range': 'bytes 0-0/999', 'content-length': '1'}
        }],
    );
    const r = await probeUrl('http://h/x', {transport, sleep: instantSleep});
    assert.equal(r.kind, 'exists');
    assert.equal(r.size, 999);
    const get = calls.find((c) => c.method === 'GET');
    assert.ok(get, 'GET-запрос должен быть выполнен');
    assert.equal(get.headers?.['Range'], 'bytes=0-0');
});

test('HEAD 501 → GET 200 без поддержки Range: размер из Content-Length', async () => {
    const {transport} = scriptedTransport(
        [{status: 501, headers: {}}],
        [{status: 200, headers: {'content-type': 'video/mp4', 'content-length': '777'}}],
    );
    const r = await probeUrl('http://h/x', {transport, sleep: instantSleep});
    assert.equal(r.kind, 'exists');
    assert.equal(r.size, 777);
});

test('HEAD 405 → GET 404 → missing', async () => {
    const {transport} = scriptedTransport(
        [{status: 405, headers: {}}],
        [{status: 404, headers: {}}],
    );
    const r = await probeUrl('http://h/x', {transport, sleep: instantSleep});
    assert.equal(r.kind, 'missing');
});

test('HEAD 500 → neterr с ретраями (3 попытки)', async () => {
    const {transport, calls} = scriptedTransport(
        [{status: 500, headers: {}}, {status: 500, headers: {}}, {status: 500, headers: {}}],
        [],
    );
    const r = await probeUrl('http://h/x', {transport, sleep: instantSleep});
    assert.equal(r.kind, 'neterr');
    assert.equal(calls.length, 3);
});

test('сетевая ошибка ретраится: успех на третьей попытке', async () => {
    const {transport, calls} = scriptedTransport(
        ['NET', 'NET', {status: 200, headers: {'content-type': 'image/png', 'content-length': '10'}}],
        [],
    );
    const r = await probeUrl('http://h/x', {transport, sleep: instantSleep});
    assert.equal(r.kind, 'exists');
    assert.equal(calls.length, 3);
});

test('сетевые ошибки на всех попытках → neterr (1 + 2 ретрая)', async () => {
    const {transport, calls} = scriptedTransport(['NET', 'NET', 'NET'], []);
    const r = await probeUrl('http://h/x', {transport, sleep: instantSleep});
    assert.equal(r.kind, 'neterr');
    assert.match(r.detail, /сеть/);
    assert.equal(calls.length, 3);
});

test('checkAvailable: 404 на HEAD = сервер доступен', async () => {
    const {transport} = scriptedTransport([{status: 404, headers: {}}], []);
    assert.equal(await checkAvailable('http://h/x', transport), true);
});

test('checkAvailable: HEAD падает в сеть, GET Range отвечает = доступен', async () => {
    const {transport} = scriptedTransport(
        ['NET'],
        [{status: 206, headers: {'content-range': 'bytes 0-0/5'}}],
    );
    assert.equal(await checkAvailable('http://h/x', transport), true);
});

test('checkAvailable: полная сетевая тишина = недоступен', async () => {
    const {transport} = scriptedTransport(['NET'], ['NET']);
    assert.equal(await checkAvailable('http://h/x', transport), false);
});

test('mediaKindOf: базовые типы', () => {
    assert.equal(mediaKindOf('image/jpeg'), 'image');
    assert.equal(mediaKindOf('IMAGE/PNG; charset=binary'), 'image');
    assert.equal(mediaKindOf('video/mp4'), 'video');
    assert.equal(mediaKindOf('application/octet-stream'), null);
    assert.equal(mediaKindOf('text/html'), null);
});

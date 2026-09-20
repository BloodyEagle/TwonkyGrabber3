/**
 * Юнит-тесты парсера URL подключения (план, M1).
 * Сети нет — только чистые функции.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileUrl, parseConnectionUrl, thumbUrl} from '../src/lib/url-parser';

test('полный URL: протокол, порт, путь, хвост с номером', () => {
    const res = parseConnectionUrl('http://192.168.1.10:9000/disk/O0$2$20I5000');
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const c = res.connection;
    assert.equal(c.protocol, 'http');
    assert.equal(c.host, '192.168.1.10');
    assert.equal(c.port, 9000);
    assert.equal(c.basePath, '/disk/');
    assert.equal(c.prefix, 'O0$2$20I');
    assert.equal(c.startNumber, 5000);
    assert.equal(c.baseUrl, 'http://192.168.1.10:9000/disk/O0$2$20I');
    assert.equal(c.raw, 'http://192.168.1.10:9000/disk/O0$2$20I5000');
});

test('без протокола: дописывается http', () => {
    const res = parseConnectionUrl('192.168.1.10:9000/disk/O0$2$20I5100');
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.connection.protocol, 'http');
    assert.equal(res.connection.port, 9000);
    assert.equal(res.connection.startNumber, 5100);
});

test('http без порта: дефолт 9000', () => {
    const res = parseConnectionUrl('http://nas.local/disk/');
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.connection.port, 9000);
    assert.equal(res.connection.basePath, '/disk/');
    assert.equal(res.connection.prefix, 'O0$2$20I');
    assert.equal(res.connection.startNumber, 5000);
});

test('https без порта: дефолт 443, порт опускается в baseUrl', () => {
    const res = parseConnectionUrl('https://nas.local/disk/O0$2$20I7777');
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const c = res.connection;
    assert.equal(c.protocol, 'https');
    assert.equal(c.port, 443);
    assert.equal(c.baseUrl, 'https://nas.local/disk/O0$2$20I');
    assert.equal(c.startNumber, 7777);
});

test('только хост: дефолты пути и номера', () => {
    const res = parseConnectionUrl('192.168.0.5');
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const c = res.connection;
    assert.equal(c.protocol, 'http');
    assert.equal(c.port, 9000);
    assert.equal(c.basePath, '/disk/');
    assert.equal(c.prefix, 'O0$2$20I');
    assert.equal(c.startNumber, 5000);
    assert.equal(c.baseUrl, 'http://192.168.0.5:9000/disk/O0$2$20I');
});

test('путь без завершающего слеша нормализуется', () => {
    const res = parseConnectionUrl('http://host:9000/disk');
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.connection.basePath, '/disk/');
});

test('вложенный путь сохраняется', () => {
    const res = parseConnectionUrl('http://host:9000/nas/twonky/O0$2$20I6100');
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.connection.basePath, '/nas/twonky/');
    assert.equal(res.connection.startNumber, 6100);
});

test('кастомный префикс парсится из хвоста', () => {
    const res = parseConnectionUrl('http://host:9000/disk/X1$2$20I6000');
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.connection.prefix, 'X1$2$20I');
    assert.equal(res.connection.startNumber, 6000);
});

test('хвост только из цифр: префикс дефолтный, номер из хвоста', () => {
    const res = parseConnectionUrl('http://host:9000/disk/5255');
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.connection.prefix, 'O0$2$20I');
    assert.equal(res.connection.startNumber, 5255);
});

test('query отбрасывается', () => {
    const res = parseConnectionUrl('http://host:9000/disk/O0$2$20I5000?scale=200x160');
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.connection.startNumber, 5000);
    assert.equal(res.connection.baseUrl, 'http://host:9000/disk/O0$2$20I');
});

test('мусор: пустая строка', () => {
    assert.equal(parseConnectionUrl('').ok, false);
    assert.equal(parseConnectionUrl('   ').ok, false);
});

test('мусор: без хоста', () => {
    assert.equal(parseConnectionUrl('http://').ok, false);
    assert.equal(parseConnectionUrl('http:///disk/').ok, false);
});

test('мусор: нечто не похожее на URL', () => {
    assert.equal(parseConnectionUrl('::: wtf ::').ok, false);
});

test('мусор: неподдерживаемый протокол', () => {
    const res = parseConnectionUrl('ftp://host:9000/disk/');
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.error, /http и https/);
});

test('fileUrl и thumbUrl строятся от baseUrl', () => {
    const res = parseConnectionUrl('http://host:9000/disk/O0$2$20I5000');
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const c = res.connection;
    assert.equal(fileUrl(c, 7321), 'http://host:9000/disk/O0$2$20I7321');
    assert.equal(thumbUrl(c, 7321, 200, 160), 'http://host:9000/disk/O0$2$20I7321?scale=200x160');
});

test('ссылка на файл с расширением и подпапкой: номер из имени, не дефолт', () => {
    const res = parseConnectionUrl('http://host:9000/disk/DLNA-PNJPEG_TN-FLAGS00d00000/O0$2$20I131100.JPG');
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const c = res.connection;
    assert.equal(c.startNumber, 131100);
    assert.equal(c.prefix, 'O0$2$20I');
    assert.equal(c.basePath, '/disk/DLNA-PNJPEG_TN-FLAGS00d00000/');
    // baseUrl НЕ должен содержать сегмент файла — иначе Twonky отвечает
    // одной и той же картинкой на любой номер во «вложенном» URL.
    assert.equal(c.baseUrl, 'http://host:9000/disk/DLNA-PNJPEG_TN-FLAGS00d00000/O0$2$20I');
    assert.equal(fileUrl(c, 131356), 'http://host:9000/disk/DLNA-PNJPEG_TN-FLAGS00d00000/O0$2$20I131356');
});

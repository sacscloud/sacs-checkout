/**
 * Cuentas migradas a sacs5: si contrato-config FALLA ya no se trata como «sin contrato».
 *  · 503 (o red / success:false) → reintenta, muestra error con «Reintentar» y NO llama crear-pago.
 *  · success:true con data:null → sin contrato: se salta la firma, como siempre.
 *  · requiereFirma:true → paso de firma.
 *  · Cuenta de sacs3 (sin cuentaSacs5) → sin ningún cambio, aunque el contrato falle.
 * Dobles de fetch y de Stripe; sin red ni compras. Correr: node --test tests/widget-contrato-fallo.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const WIDGET = fileURLToPath(new URL('../checkout-widget.js', import.meta.url));

function instalarDoble(opts) {
    window.__llamadas = []; window.__confirmCalls = 0; window.__contrato = opts.contrato;
    window.Stripe = function () {
        return {
            elements() { return { create() { return { mount() {}, on() {}, destroy() {} }; } }; },
            async confirmCardPayment() { window.__confirmCalls++; return { error: { message: 'x' } }; }
        };
    };
    const json = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
    window.fetch = async (url) => {
        const ruta = new URL(String(url)).pathname;
        window.__llamadas.push(ruta);
        if (ruta.endsWith('/store-config')) return json({ success: true, data: opts.storeConfig });
        if (ruta.endsWith('/contrato-config')) {
            const c = window.__contrato;
            if (c === 'red') throw new TypeError('Failed to fetch');
            if (c === '503') return json({ success: false, code: 'CONTRATO_PENDIENTE_DE_MIGRAR' }, 503);
            if (c === 'success-false') return json({ success: false });
            if (c === 'null') return json({ success: true, data: null });
            return json({ success: true, data: { nombre: 'C', config: { general: { requiereFirma: true } } } });
        }
        if (ruta.endsWith('/crear-pago')) return json({ success: false, msg: 'doble' }, 400);
        if (ruta.endsWith('/ecommerceconfig/aggregate')) return json({ success: true, data: [{ id: 'b', products: [{ fid: 'A', nombre: 'Playera', precio: 100, tipo: 'Producto Simple', imagen: 'https://x.test/a.jpg' }] }] });
        return json({ success: false });
    };
}

const STRIPE = { connected: true, accountId: 'acct_x', livemode: false };
const migrada = { stripe: STRIPE, defaults: {}, branding: {}, cuentaSacs5: true };
const sacs3 = { stripe: STRIPE, defaults: {}, branding: {} };

async function correr(opts, fn) {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const errores = [];
    page.on('pageerror', e => errores.push(e.message));
    await page.addInitScript(instalarDoble, opts);
    await page.route('**/*', (route) => {
        const u = route.request().url();
        if (u === 'https://tienda.ejemplo.test/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="c1"></div></body></html>' });
        if (u === 'https://tienda.ejemplo.test/w.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: readFileSync(WIDGET, 'utf8') });
        return route.abort();
    });
    await page.goto('https://tienda.ejemplo.test/');
    await page.addScriptTag({ url: 'https://tienda.ejemplo.test/w.js' });
    await page.evaluate(() => window.sacsCheckout.init({ accountId: 'tienda', configId: 'b', containerId: 'c1' }));
    await page.evaluate(() => window.sacsCheckout.open('c1'));
    await page.waitForTimeout(200);
    try { await fn(page, errores); } finally { await browser.close(); }
}

// Llega al paso 2, llena los datos y pulsa «continuar».
async function continuarDesdePaso2(page) {
    await page.evaluate(() => {
        const w = window.sacsCheckout.getInstance('c1');
        w.cart = [{ fid: 'A', nombre: 'Playera', precio: 100, quantity: 1, tipo: 'Producto Simple' }];
        w.goToStep(2);
    });
    await page.fill('#sacs-correo', 'cliente@ejemplo.test');
    await page.fill('#sacs-nombre', 'Ana Prueba');
    await page.fill('#sacs-telefono', '5512345678');
    await page.click('#sacs-pay-btn');
    await page.waitForTimeout(1500);
}

const estado = (page) => page.evaluate(() => ({
    paso: window.sacsCheckout.getInstance('c1').currentStep,
    firma: !!document.querySelector('[id^="sacs-signature-canvas"]'),
    error: !!document.querySelector('[data-sacs-contrato-error]'),
    reintentar: !!document.querySelector('[data-sacs-contrato-reintentar]'),
    contratos: window.__llamadas.filter(r => r.endsWith('/contrato-config')).length,
    crearPago: window.__llamadas.filter(r => r.endsWith('/crear-pago')).length,
    confirm: window.__confirmCalls
}));

for (const modo of ['503', 'red', 'success-false']) {
    test(`migrada + contrato ${modo} → reintenta, error con «Reintentar», sin crear-pago ni paso siguiente`, async () => {
        await correr({ storeConfig: migrada, contrato: modo }, async (page, errores) => {
            const antes = (await estado(page)).contratos;
            await continuarDesdePaso2(page);
            const r = await estado(page);
            assert.equal(r.paso, 2, 'no avanza');
            assert.equal(r.error, true); assert.equal(r.reintentar, true);
            assert.ok(r.contratos - antes >= 2, 'reintentó antes de rendirse');
            assert.equal(r.firma, false); assert.equal(r.crearPago, 0); assert.equal(r.confirm, 0);
            // Aunque se fuerce el pago, no se llama a crear-pago.
            await page.evaluate(() => { const w = window.sacsCheckout.getInstance('c1'); w.goToStep(4); });
            await page.waitForTimeout(300);
            await page.evaluate(() => window.sacsCheckout.getInstance('c1').processPayment());
            await page.waitForTimeout(1500);
            assert.equal((await estado(page)).crearPago, 0);
            assert.deepEqual(errores, []);
        });
    });
}

test('migrada: tras el fallo, «Reintentar» con el contrato ya disponible continúa (firma si la pide)', async () => {
    await correr({ storeConfig: migrada, contrato: '503' }, async (page) => {
        await continuarDesdePaso2(page);
        assert.equal((await estado(page)).error, true);
        await page.evaluate(() => { window.__contrato = 'ok'; });
        await page.click('[data-sacs-contrato-reintentar]');
        await page.waitForTimeout(1500);
        const r = await estado(page);
        assert.equal(r.paso, 3); assert.equal(r.firma, true); assert.equal(r.error, false);
    });
});

test('migrada + data:null con success:true → sin contrato: sin paso de firma, va al pago', async () => {
    await correr({ storeConfig: migrada, contrato: 'null' }, async (page, errores) => {
        await continuarDesdePaso2(page);
        const r = await estado(page);
        assert.equal(r.paso, 4); assert.equal(r.firma, false); assert.equal(r.error, false);
        assert.deepEqual(errores, []);
    });
});

test('migrada + requiereFirma → paso de firma', async () => {
    await correr({ storeConfig: migrada, contrato: 'ok' }, async (page) => {
        await continuarDesdePaso2(page);
        const r = await estado(page);
        assert.equal(r.paso, 3); assert.equal(r.firma, true); assert.equal(r.error, false);
    });
});

test('cuenta de sacs3 (sin cuentaSacs5) + contrato 503 → igual que antes: sin firma, sin error nuevo, sin reintentos', async () => {
    await correr({ storeConfig: sacs3, contrato: '503' }, async (page) => {
        const antes = (await estado(page)).contratos;
        await continuarDesdePaso2(page);
        const r = await estado(page);
        assert.equal(r.paso, 4); assert.equal(r.firma, false); assert.equal(r.error, false);
        assert.equal(r.contratos, antes);
    });
});

/**
 * Candado de reentrancia del intento de pago / paso a firma (cuentas sacs5, contrato caído que se recupera).
 *  · Doble clic en «Pagar» con contrato caído que luego se recupera → exactamente UNA llamada a crear-pago.
 *  · Doble clic en «Continuar» (paso 2) → un solo avance.
 *  · El candado se libera siempre: tras error del pago, tras contrato caído y al cerrar el drawer, se puede reintentar.
 *  · Cuenta de sacs3: sin cambios.
 * Dobles de fetch y de Stripe; sin red ni compras. Correr: node --test tests/widget-candado-pago.test.mjs
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
    window.__llamadas = []; window.__contrato = opts.contrato;
    window.Stripe = function () {
        return {
            elements() { return { create() { return { mount() {}, on() {}, destroy() {} }; } }; },
            async confirmCardPayment() { return { error: { message: 'x' } }; }
        };
    };
    const json = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
    window.fetch = async (url) => {
        const ruta = new URL(String(url)).pathname;
        window.__llamadas.push(ruta);
        if (ruta.endsWith('/store-config')) return json({ success: true, data: opts.storeConfig });
        if (ruta.endsWith('/contrato-config')) {
            if (window.__contrato === '503') return json({ success: false }, 503);
            return json({ success: true, data: null });
        }
        if (ruta.endsWith('/checkout/identidad')) return json({ success: false, code: 'CHECKOUT_IDENTIDAD_NO_DISPONIBLE' }, 404);
        if (ruta.endsWith('/crear-pago')) { await new Promise(r => setTimeout(r, 300)); return json({ success: false, msg: 'doble' }, 400); }
        if (ruta.endsWith('/ecommerceconfig/aggregate')) return json({ success: true, data: [{ id: 'b', products: [{ fid: 'A', nombre: 'Playera', precio: 100, tipo: 'Producto Simple', imagen: 'https://x.test/a.jpg' }] }] });
        return json({ success: false });
    };
}

const STRIPE = { connected: true, accountId: 'acct_x', livemode: false };
const migrada = { stripe: STRIPE, defaults: { almacen: { key: 'ALM1' }, sucursal: { key: 'S1' }, tipoCliente: { key: 'T1' } }, branding: {}, cuentaSacs5: true };
const sacs3 = { stripe: STRIPE, defaults: { almacen: { key: 'ALM1' }, sucursal: { key: 'S1' }, tipoCliente: { key: 'T1' } }, branding: {} };

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

const n = (page, sufijo) => page.evaluate((s) => window.__llamadas.filter(r => r.endsWith(s)).length, sufijo);

async function irAPaso(page, paso) {
    await page.evaluate((p) => {
        const w = window.sacsCheckout.getInstance('c1');
        w.cart = [{ fid: 'A', nombre: 'Playera', precio: 100, quantity: 1, tipo: 'Producto Simple' }];
        w.customerInfo = { correo: 'cliente@ejemplo.test', nombre: 'Ana Prueba', telefono: '5512345678', direccion: 'Calle 1', ciudad: 'CDMX', codigoPostal: '01000' };
        w.goToStep(p);
    }, paso);
    await page.waitForTimeout(400);
}

// Dos clics seguidos, sin esperar entre ellos.
const dobleClic = (page) => page.evaluate(() => {
    const b = document.getElementById('sacs-pay-btn');
    b.click(); b.click();
});

test('migrada: doble clic en Pagar con contrato caído que se recupera → exactamente UNA llamada a crear-pago', async () => {
    await correr({ storeConfig: migrada, contrato: '503' }, async (page, errores) => {
        await irAPaso(page, 4);
        await dobleClic(page);
        await page.waitForTimeout(100);
        await page.evaluate(() => { window.__contrato = 'ok'; }); // se recupera durante los reintentos
        await page.waitForTimeout(2500);
        assert.equal(await n(page, '/crear-pago'), 1);
        assert.deepEqual(errores, []);
    });
});

test('migrada: contrato caído → el candado se libera; tras recuperarse un nuevo clic sí cobra (una vez) y el botón queda habilitado', async () => {
    await correr({ storeConfig: migrada, contrato: '503' }, async (page) => {
        await irAPaso(page, 4);
        await dobleClic(page);
        await page.waitForTimeout(2500);
        assert.equal(await n(page, '/crear-pago'), 0);
        assert.equal(await page.evaluate(() => document.getElementById('sacs-pay-btn').disabled), false);
        await page.evaluate(() => { window.__contrato = 'ok'; });
        await page.click('[data-sacs-contrato-reintentar]');
        await page.waitForTimeout(1500);
        assert.equal(await n(page, '/crear-pago'), 1);
    });
});

test('error del pago (crear-pago 400) → candado liberado y botón habilitado: otro clic reintenta', async () => {
    await correr({ storeConfig: migrada, contrato: 'ok' }, async (page) => {
        await irAPaso(page, 4);
        await page.click('#sacs-pay-btn');
        await page.waitForTimeout(800);
        assert.equal(await n(page, '/crear-pago'), 1);
        assert.equal(await page.evaluate(() => document.getElementById('sacs-pay-btn').disabled), false);
        await page.click('#sacs-pay-btn');
        await page.waitForTimeout(800);
        assert.equal(await n(page, '/crear-pago'), 2);
    });
});

test('cerrar el drawer con un intento en curso libera el candado (no queda atorado)', async () => {
    await correr({ storeConfig: migrada, contrato: '503' }, async (page) => {
        await irAPaso(page, 4);
        await page.evaluate(() => document.getElementById('sacs-pay-btn').click());
        await page.waitForTimeout(100);
        assert.equal(await page.evaluate(() => !!window.sacsCheckout.getInstance('c1')._candadoPago), true);
        await page.evaluate(() => window.sacsCheckout.getInstance('c1').close());
        assert.equal(await page.evaluate(() => !!window.sacsCheckout.getInstance('c1')._candadoPago), false);
    });
});

test('migrada: doble clic en Continuar (paso 2) con contrato caído que se recupera → un solo avance, sin errores', async () => {
    await correr({ storeConfig: migrada, contrato: '503' }, async (page, errores) => {
        await page.evaluate(() => {
            const w = window.sacsCheckout.getInstance('c1');
            w.cart = [{ fid: 'A', nombre: 'Playera', precio: 100, quantity: 1, tipo: 'Producto Simple' }];
            w.goToStep(2);
        });
        await page.fill('#sacs-correo', 'cliente@ejemplo.test');
        await page.fill('#sacs-nombre', 'Ana Prueba');
        await page.fill('#sacs-telefono', '5512345678');
        const antes = await n(page, '/contrato-config');
        await dobleClic(page);
        await page.waitForTimeout(100);
        await page.evaluate(() => { window.__contrato = 'ok'; });
        await page.waitForTimeout(2000);
        assert.equal(await page.evaluate(() => window.sacsCheckout.getInstance('c1').currentStep), 4);
        // Un solo proceso consultó el contrato (el segundo clic se ignoró).
        assert.ok((await n(page, '/contrato-config')) - antes <= 3);
        assert.deepEqual(errores, []);
    });
});

test('cuenta de sacs3: el pago sigue funcionando igual (una llamada a crear-pago por clic)', async () => {
    await correr({ storeConfig: sacs3, contrato: '503' }, async (page) => {
        await irAPaso(page, 4);
        await page.click('#sacs-pay-btn');
        await page.waitForTimeout(800);
        assert.equal(await n(page, '/crear-pago'), 1);
    });
});

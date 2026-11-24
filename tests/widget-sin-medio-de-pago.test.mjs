/**
 * Sin medio de pago en línea conectado → aviso (antes de datos y firma); con Stripe → flujo de siempre.
 * Doble de fetch y de Stripe, sin red ni compras. Correr: node --test tests/widget-sin-medio-de-pago.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const WIDGET = fileURLToPath(new URL('../checkout-widget.js', import.meta.url));
const TEXTO = 'Por ahora el pago en línea no está disponible. Escríbenos y te ayudamos a completar tu compra.';

function instalarDoble(storeConfig) {
    window.__llamadas = []; window.__confirmCalls = 0;
    window.Stripe = function () {
        return {
            elements() { return { create() { return { mount() {}, on() {}, destroy() {} }; } }; },
            async confirmCardPayment() { window.__confirmCalls++; return { error: { message: 'x' } }; }
        };
    };
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
    window.fetch = async (url) => {
        const ruta = new URL(String(url)).pathname;
        window.__llamadas.push(ruta);
        if (ruta.endsWith('/store-config')) return json({ success: true, data: storeConfig });
        if (ruta.endsWith('/contrato-config')) return json({ success: true, data: { nombre: 'C', config: { general: { requiereFirma: true } } } });
        if (ruta.endsWith('/ecommerceconfig/aggregate')) return json({ success: true, data: [{ id: 'b', products: [{ fid: 'A', nombre: 'Playera', precio: 100, tipo: 'Producto Simple', imagen: 'https://x.test/a.jpg' }] }] });
        return json({ success: false });
    };
}

async function correr(storeConfig, fn) {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const errores = [];
    page.on('pageerror', e => errores.push(e.message));
    await page.addInitScript(instalarDoble, storeConfig);
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

const sinPago = (page) => page.evaluate(() => ({
    aviso: document.querySelector('[data-sacs-sin-pago]')?.innerText || null,
    formulario: !!document.getElementById('sacs-telefono'),
    firma: !!document.querySelector('[id^="sacs-signature-canvas"]'),
    boton: !!document.getElementById('sacs-pay-btn'),
    confirm: window.__confirmCalls
}));

test('Stripe connected:false y nada más → aviso con contacto, sin formulario/firma/confirmCardPayment', async () => {
    const cfg = { stripe: { connected: false, accountId: null, livemode: true }, defaults: {}, branding: {}, contacto: { whatsapp: '+52 55 1234 5678', correo: 'hola@tienda.test' },
        mercadopago: { connected: false }, paypal: { connected: false } };
    await correr(cfg, async (page, errores) => {
        const r = await sinPago(page);
        assert.ok(r.aviso.includes(TEXTO));
        assert.ok(r.aviso.includes('+52 55 1234 5678') && r.aviso.includes('hola@tienda.test'));
        assert.equal(r.formulario, false); assert.equal(r.firma, false); assert.equal(r.boton, false); assert.equal(r.confirm, 0);
        await page.evaluate(() => window.sacsCheckout.getInstance('c1').processPayment()); // aunque se fuerce, no truena
        assert.equal((await sinPago(page)).confirm, 0);
        assert.deepEqual(errores, []);
    });
});

test('sin contacto en la config → solo el texto', async () => {
    await correr({ stripe: { connected: false }, defaults: {}, branding: {} }, async (page) => {
        const r = await sinPago(page);
        assert.equal(r.aviso.trim(), TEXTO);
    });
});

test('solo otro medio conectado (el widget solo sabe cobrar con Stripe) → aviso', async () => {
    await correr({ stripe: { connected: false }, mercadopago: { connected: true }, defaults: {}, branding: {} }, async (page) => {
        assert.ok((await sinPago(page)).aviso.includes(TEXTO));
    });
});

test('Stripe conectado → flujo de siempre: carrito, datos, firma, pago', async () => {
    const cfg = { stripe: { connected: true, accountId: 'acct_x', livemode: false }, defaults: {}, branding: {} };
    await correr(cfg, async (page, errores) => {
        let r = await sinPago(page);
        assert.equal(r.aviso, null); assert.equal(r.boton, true);
        await page.evaluate(() => window.sacsCheckout.goToStep(2));
        assert.equal((await sinPago(page)).formulario, true);
        await page.evaluate(() => window.sacsCheckout.goToStep(3));
        await page.waitForTimeout(200);
        assert.equal((await sinPago(page)).firma, true);
        await page.evaluate(() => window.sacsCheckout.goToStep(4));
        await page.waitForTimeout(200);
        assert.equal(await page.evaluate(() => !!window.sacsCheckout.getInstance('c1').stripe), true);
        assert.deepEqual(errores, []);
    });
});

test('Stripe con accountId y sin campo connected → flujo de siempre', async () => {
    await correr({ stripe: { accountId: 'acct_x', livemode: false }, defaults: {}, branding: {} }, async (page) => {
        assert.equal((await sinPago(page)).aviso, null);
    });
});

test('processPayment sin Stripe: mensaje claro, sin excepción', async () => {
    await correr({ stripe: { connected: true, accountId: 'acct_x' }, defaults: {}, branding: {} }, async (page, errores) => {
        await page.evaluate(() => { window.sacsCheckout.goToStep(4); window.sacsCheckout.getInstance('c1').stripe = null; });
        await page.evaluate(() => window.sacsCheckout.getInstance('c1').processPayment());
        const t = await page.evaluate(() => document.getElementById('sacs-error-container')?.innerText || '');
        assert.ok(t.includes(TEXTO));
        assert.equal((await sinPago(page)).confirm, 0);
        assert.deepEqual(errores, []);
    });
});

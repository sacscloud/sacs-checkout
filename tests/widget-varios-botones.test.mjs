/**
 * SOP-158776 — varios contenedores con el mismo accountId/configId (init x5, cambia solo containerId).
 * Los controles del carrito (+, −, quitar, cerrar, volver a abrir) deben actuar sobre la instancia
 * que abrió el carrito, no sobre la última instancia creada.
 * Todas las peticiones de red están simuladas. Correr: node --test tests/widget-varios-botones.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const WIDGET = fileURLToPath(new URL('../checkout-widget.js', import.meta.url));

function instalarDoble(storeConfig) {
    window.Stripe = function () {
        return { elements() { return { create() { return { mount() {}, on() {}, destroy() {} }; } }; }, async confirmCardPayment() { return { error: { message: 'x' } }; } };
    };
    const json = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
    window.fetch = async (url) => {
        const ruta = new URL(String(url)).pathname;
        if (ruta.endsWith('/store-config')) return json({ success: true, data: storeConfig });
        if (ruta.endsWith('/contrato-config')) return json({ success: true, data: null });
        if (ruta.endsWith('/ecommerceconfig/aggregate')) return json({ success: true, data: [{ id: 'b', products: [{ fid: 'A', nombre: 'Playera', precio: 100, tipo: 'Producto Simple', imagen: 'https://x.test/a.jpg' }] }] });
        return json({ success: false });
    };
}
const STORE = { stripe: { connected: true, accountId: 'acct_x', livemode: false }, defaults: { almacen: { key: 'ALM1' }, sucursal: { key: 'S1' }, tipoCliente: { key: 'T1' } }, branding: {} };

async function correr(total, fn) {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const errores = [];
    page.on('pageerror', e => errores.push(e.message));
    await page.addInitScript(instalarDoble, STORE);
    const divs = Array.from({ length: total }, (_, i) => `<div id="c${i + 1}"></div>`).join('');
    await page.route('**/*', (route) => {
        const u = route.request().url();
        if (u === 'https://tienda.ejemplo.test/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>${divs}</body></html>` });
        if (u === 'https://tienda.ejemplo.test/w.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: readFileSync(WIDGET, 'utf8') });
        return route.abort();
    });
    await page.goto('https://tienda.ejemplo.test/');
    await page.addScriptTag({ url: 'https://tienda.ejemplo.test/w.js' });
    await page.evaluate(async (n) => {
        for (let i = 1; i <= n; i++) await window.sacsCheckout.init({ accountId: 'tienda', configId: 'b', containerId: 'c' + i });
    }, total);
    try { await fn(page, errores); } finally { await browser.close(); }
}

const ponerCarrito = (page, id) => page.evaluate((i) => {
    const w = window.sacsCheckout.getInstance(i);
    w.cart = [{ fid: 'A', nombre: 'Playera', precio: 100, quantity: 2, tipo: 'Producto Simple' }];
    w.render();
}, id);
const cant = (page, id) => page.evaluate((i) => window.sacsCheckout.getInstance(i).cart.map(x => x.quantity), id);
const drawerAbierto = (page) => page.evaluate(() => !!document.getElementById('sacs-drawer'));

for (const total of [5, 1]) {
    const id = total === 1 ? 'c1' : 'c2';
    test(`${total} contenedor(es): «−» y «+» actúan sobre la instancia que abrió el carrito (${id})`, async () => {
        await correr(total, async (page, errores) => {
            await page.click(`#${id} button`);
            await page.waitForTimeout(300);
            await ponerCarrito(page, id);
            await page.click('.sacs-qty-btn:not([disabled]) >> nth=0');
            assert.deepEqual(await cant(page, id), [1]);
            await page.click('.sacs-qty-btn >> nth=1');
            assert.deepEqual(await cant(page, id), [2]);
            assert.deepEqual(errores, []);
        });
    });

    test(`${total} contenedor(es): quitar del carrito (cantidad 0) actúa sobre ${id}`, async () => {
        await correr(total, async (page) => {
            await page.click(`#${id} button`);
            await page.waitForTimeout(300);
            await ponerCarrito(page, id);
            await page.evaluate(() => { window.sacsCheckout.updateQuantity(0, 0); }); // mismo camino que onclick inline
            assert.deepEqual(await cant(page, id), [0]); // el item queda con cantidad 0 (comportamiento existente)
        });
    });

    test(`${total} contenedor(es): cerrar y volver a abrir desde el mismo botón funciona`, async () => {
        await correr(total, async (page) => {
            await page.click(`#${id} button`);
            await page.waitForTimeout(300);
            assert.equal(await drawerAbierto(page), true);
            await page.click('.sacs-close-btn');
            await page.waitForTimeout(500);
            assert.equal(await drawerAbierto(page), false);
            assert.equal(await page.evaluate((i) => window.sacsCheckout.getInstance(i).isOpen, id), false);
            await page.click(`#${id} button`);
            await page.waitForTimeout(300);
            assert.equal(await drawerAbierto(page), true);
        });
    });
}

test('5 contenedores: avisos «Falta 1 paso» de complementos obligatorios se conservan al tocar «−»', async () => {
    await correr(5, async (page) => {
        await page.click('#c2 button');
        await page.waitForTimeout(300);
        await page.evaluate(() => {
            const w = window.sacsCheckout.getInstance('c2');
            w.cart = [{ fid: 'K', nombre: 'Kit', precio: 100, quantity: 2, tipo: 'Producto Simple', _slotsDef: [{ insumo_fid: 'S', label: 'Calcetas', padre_nombre: 'Calcetas', cantidad: 1, min: 1, opciones: [{ variante: 'V1', nombre: 'Calceta M', existencia: 50 }] }] }];
            w.render();
        });
        const antes = await page.locator('.sacs-kit-req').count();
        assert.ok(antes > 0, 'el aviso «Falta 1 paso» debe verse antes');
        await page.click('.sacs-qty-btn:not([disabled]) >> nth=0');
        assert.equal(await page.locator('.sacs-kit-req').count(), antes);
        assert.deepEqual(await cant(page, 'c2'), [1]);
    });
});

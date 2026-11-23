/**
 * Prueba de peticiones del widget (doble de fetch, sin red ni datos reales).
 *
 * Carga checkout-widget.js en Chromium (Playwright) con `window.fetch` reemplazado por
 * un doble que contesta como el API y anota cada llamada. Simula una tienda con VARIOS
 * botones (instancias) que comparten productos y tienen kits, como la de un cliente real.
 *
 * Correr:   node --test tests/widget-peticiones.test.mjs
 * Medir otra versión del widget (p. ej. la de master) sin asertos:
 *           WIDGET=/ruta/al/checkout-widget.js node tests/widget-peticiones.test.mjs --medir
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const WIDGET = process.env.WIDGET || fileURLToPath(new URL('../checkout-widget.js', import.meta.url));

// 3 botones; los productos A y B se repiten entre botones; K es un kit; F trae foto en el config.
const CONFIGS = {
    'btn-1': [{ fid: 'A', nombre: 'Playera', precio: 100, tipo: 'Producto Simple' },
              { fid: 'K', nombre: 'Combo', precio: 300, tipo: 'Producto Compuesto' }],
    'btn-2': [{ fid: 'A', nombre: 'Playera', precio: 100, tipo: 'Producto Simple' },
              { fid: 'B', nombre: 'Gorra', precio: 80, tipo: 'Producto Simple' },
              { fid: 'K2', nombre: 'Acceso', precio: 599, tiene_hueco_variante: true }],
    'btn-3': [{ fid: 'B', nombre: 'Gorra', precio: 80, tipo: 'Producto Simple' },
              { fid: 'F', nombre: 'Taza', precio: 50, tipo: 'Producto Simple', imagen: 'https://cdn.ejemplo.test/taza.jpg' }],
};

// Doble de fetch: se instala ANTES del widget. Anota método, URL, headers y cuerpo.
function instalarDoble(configs) {
    window.__llamadas = [];
    window.Stripe = function () { return { elements() { return { create() { return { mount() {}, on() {}, destroy() {} }; } }; } }; };
    const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
    window.fetch = async (url, opts = {}) => {
        const headers = {};
        const h = opts.headers || {};
        (h instanceof Headers ? [...h.entries()] : Object.entries(h)).forEach(([k, v]) => { headers[k.toLowerCase()] = v; });
        const metodo = (opts.method || 'GET').toUpperCase();
        window.__llamadas.push({ metodo, url: String(url), headers, body: opts.body || null });
        const u = new URL(String(url));
        const ruta = u.pathname;
        await new Promise(r => setTimeout(r, 5));
        if (ruta.endsWith('/store-config')) return json({ success: true, data: { stripe: { accountId: 'acct_test', livemode: false }, defaults: { almacen: { key: 'ALM1' } }, branding: {} } });
        if (ruta.endsWith('/contrato-config')) return json({ success: true, data: null });
        if (ruta.endsWith('/ecommerceconfig/aggregate')) {
            const id = JSON.parse(opts.body).pipeline[0].$match.id;
            return json({ success: true, data: [{ id, products: configs[id] }] });
        }
        if (ruta.endsWith('/articulo-imagen')) return json({ success: true, data: 'https://cdn.ejemplo.test/' + u.searchParams.get('key') + '.jpg' });
        if (ruta.endsWith('/kits/slots')) {
            const kit = JSON.parse(opts.body).kit_id;
            return json({ success: true, data: { slots: [{ insumo_fid: kit + '-S', label: 'Talla', padre_nombre: 'Calceta', cantidad: 1, min: 1,
                opciones: [{ fid: kit + '-CH', nombre: 'Calceta CH', atributos: 'CH', existencia: 5 }] }] } });
        }
        return json({ success: false });
    };
}

async function cargarPagina(widgetPath) {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const errores = [];
    page.on('pageerror', e => errores.push(e.message));
    await page.addInitScript(instalarDoble, CONFIGS);
    // Página falsa servida localmente; cualquier otra red (fuentes, Stripe) se corta.
    await page.route('**/*', (route) => {
        const u = route.request().url();
        if (u === 'https://tienda.ejemplo.test/') return route.fulfill({ contentType: 'text/html', body:
            '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="c1"></div><div id="c2"></div><div id="c3"></div></body></html>' });
        if (u === 'https://tienda.ejemplo.test/checkout-widget.js') return route.fulfill({ contentType: 'text/javascript', body: readFileSync(widgetPath, 'utf8') });
        return route.abort();
    });
    await page.goto('https://tienda.ejemplo.test/');
    await page.addScriptTag({ url: 'https://tienda.ejemplo.test/checkout-widget.js' });
    await page.evaluate(async () => {
        // En paralelo, como en una página real (un <script> por botón, sin await entre ellos).
        await Promise.all(['btn-1', 'btn-2', 'btn-3'].map((id, i) =>
            window.sacsCheckout.init({ accountId: 'tiendademo', configId: id, containerId: 'c' + (i + 1) })));
    });
    return { browser, page, errores };
}

const llamadas = (page) => page.evaluate(() => window.__llamadas.map(l => ({ ...l })));

// Una petición "no simple" (método ≠ GET/HEAD/POST, o Content-Type JSON) dispara preflight OPTIONS.
function resumen(ls) {
    const preflight = ls.filter(l => !['GET', 'HEAD', 'POST'].includes(l.metodo) || (l.headers['content-type'] || '').includes('application/json'));
    const tipo = (l) => l.url.replace(/^https:\/\/api\.sacscloud\.com\/v1/, '').replace(/\?.*$/, '').replace(/tienda\/[^/]+\//, 'tienda/:a/');
    const porRuta = {};
    ls.forEach(l => { porRuta[l.metodo + ' ' + tipo(l)] = (porRuta[l.metodo + ' ' + tipo(l)] || 0) + 1; });
    return { peticiones: ls.length, preflightsPosibles: preflight.length, totalConPreflight: ls.length + preflight.length, porRuta };
}

if (process.argv.includes('--medir')) {
    const { browser, page, errores } = await cargarPagina(WIDGET);
    console.log('AL CARGAR:', JSON.stringify(resumen(await llamadas(page)), null, 2));
    await page.evaluate(() => window.sacsCheckout.open('c1'));
    await page.waitForTimeout(300);
    console.log('TRAS ABRIR btn-1:', JSON.stringify(resumen(await llamadas(page)), null, 2));
    if (errores.length) console.log('ERRORES:', errores);
    await browser.close();
} else {
    test('al cargar: GET sin Content-Type, sin huecos de kits, cada foto una vez', async () => {
        const { browser, page, errores } = await cargarPagina(WIDGET);
        try {
            const ls = await llamadas(page);
            const gets = ls.filter(l => l.metodo === 'GET');
            assert.ok(gets.length > 0);
            for (const g of gets) assert.equal(g.headers['content-type'], undefined, 'GET con Content-Type: ' + g.url);

            assert.equal(ls.filter(l => l.url.includes('/kits/slots')).length, 0, 'no se piden huecos al cargar');

            const fotos = ls.filter(l => l.url.includes('/articulo-imagen')).map(l => new URL(l.url).searchParams.get('key'));
            assert.deepEqual([...fotos].sort(), ['A', 'B', 'K', 'K2'], 'una petición por producto; F ya trae foto');

            // Mismo resultado visual: cada producto queda con su foto.
            const urls = await page.evaluate(() => Object.values(window.sacsCheckout.instances)
                .flatMap(i => i.config.products.map(p => p.fid + '=' + p.imageUrl)));
            assert.ok(urls.includes('A=https://cdn.ejemplo.test/A.jpg'));
            assert.ok(urls.includes('F=https://cdn.ejemplo.test/taza.jpg'));
            assert.deepEqual(errores, []);
        } finally { await browser.close(); }
    });

    test('al abrir el carrito se piden los huecos de SUS kits y aparecen en el carrito', async () => {
        const { browser, page, errores } = await cargarPagina(WIDGET);
        try {
            await page.evaluate(() => window.sacsCheckout.open('c1'));
            await page.waitForFunction(() => window.sacsCheckout.getInstance('c1').cart.some(c => c._slotsDef));
            const slots = (await llamadas(page)).filter(l => l.url.includes('/kits/slots'));
            assert.equal(slots.length, 1, 'solo el kit del botón abierto');
            assert.equal(JSON.parse(slots[0].body).kit_id, 'K');
            assert.equal(JSON.parse(slots[0].body).almacen, 'ALM1');
            // El bloque "Elige ..." del kit ya está pintado.
            await page.waitForSelector('.sacs-kit-txt, .sacs-kit-bloque, [class*="sacs-kit"]');
            // Reabrir no repite la petición.
            await page.evaluate(() => { const i = window.sacsCheckout.getInstance('c1'); i.close(); });
            await page.waitForTimeout(500);
            await page.evaluate(() => window.sacsCheckout.open('c1'));
            await page.waitForTimeout(200);
            assert.equal((await llamadas(page)).filter(l => l.url.includes('/kits/slots')).length, 1);
            assert.deepEqual(errores, []);
        } finally { await browser.close(); }
    });

    test('"Continuar" antes de que lleguen los huecos espera y abre el selector del kit', async () => {
        const { browser, page, errores } = await cargarPagina(WIDGET);
        try {
            // Huecos lentos: el comprador da clic antes de que lleguen.
            await page.evaluate(() => {
                const f = window.fetch;
                window.fetch = async (u, o) => { if (String(u).includes('/kits/slots')) await new Promise(r => setTimeout(r, 400)); return f(u, o); };
                window.sacsCheckout.open('c1');
            });
            await page.click('#sacs-pay-btn');
            await page.waitForFunction(() => !!window.sacsCheckout.getInstance('c1')._slotPicker, null, { timeout: 3000 });
            const inst = await page.evaluate(() => window.sacsCheckout.getInstance('c1').currentStep);
            assert.equal(inst, 1, 'no avanzó al pago con el combo sin elegir');
            assert.deepEqual(errores, []);
        } finally { await browser.close(); }
    });
}
